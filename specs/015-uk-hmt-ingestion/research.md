# Research: UK HMT Sanctions List Ingestion

**Feature**: 015-uk-hmt-ingestion  
**Date**: 2026-04-27

## Decision 1: CSV Parsing Strategy

**Decision**: Custom hand-rolled character-by-character CSV parser (no external library)

**Rationale**: The HMT CSV has well-defined edge cases (quoted commas, escaped double-quotes, CRLF line endings). The parser is ~60 lines and fully specced in the original feature spec. Adding a library dependency (`csv-parse`, `papaparse`) for a 60-line implementation adds maintenance overhead with no practical benefit for a stable, known format.

**Alternatives considered**:
- `csv-parse` (Node.js ecosystem standard) — rejected: overkill dependency for a known stable format; would require a new `npm install`
- `papaparse` — rejected: primarily browser-oriented; same concern

---

## Decision 2: Retry Pattern for CSV Download

**Decision**: 3 retries with exponential backoff — delays of 2 000 ms, 4 000 ms, 8 000 ms. Raise error after the third failure; leave existing entries unchanged.

**Rationale**: Matches the pattern in `OFACProvider._downloadXML()`. Consistent retry behaviour across all providers makes `syncScreeningLists` predictable and operationally uniform. The 60-second network timeout (AbortController) is retained unchanged. Three retries covers transient CDN hiccups without delaying the sync worker excessively.

**Alternatives considered**:
- No retry — rejected: transient GOV.UK CDN failures should not cause a sync failure
- 5 retries — rejected: OFAC uses 3; no evidence HMT CDN is less reliable; extra retries add latency on real failure

---

## Decision 3: DOB Partial Matching Algorithm

**Decision**: Strip all non-numeric characters from both values; return true if either stripped result is a substring of the other (`q === e || q.includes(e) || e.includes(q)`).

**Rationale**: Identical to `OFACProvider._dobMatches()`. The spec clarification (Session 2026-04-27) confirmed that partial matches qualify: a query of "1985-03-15" (numeric: "19850315") contains stored "1985" (numeric: "1985"), so the boost fires correctly. Reusing the same algorithm keeps behaviour consistent across providers and simplifies testing.

**Boundary case**: A stored value with an unrecognised format (e.g. "circa 1970" → numeric: "1970") could produce an accidental year match against a query of "1970-XX-XX". This is acceptable — the fuzzy name score must already be at threshold for the DOB boost to matter, making false-positive boosts extremely unlikely to change a screening outcome.

**Alternatives considered**:
- Strict exact-string equality — rejected: too restrictive; many HMT entries have year-only or month-year DOBs
- Structured date parsing (year/month/day fields) — rejected: overcomplicated for marginal gain given the substring approach handles all known HMT DOB formats

---

## Decision 4: Upsert Strategy — `_entryChanged` Guard

**Decision**: Load existing entries into memory before the upsert loop; only issue a database UPDATE for rows where `_entryChanged()` returns true. New entries are always inserted. This is the `OFACProvider` pattern.

**Rationale**: The original feature spec code uses an unconditional `ON CONFLICT DO UPDATE`, which always performs a write and cannot distinguish a no-op update from a real modification. The OFAC provider solves this with `_entryChanged` — comparing primary_name, aliases (sorted), date_of_birth, nationalities (sorted), programs (sorted), remarks — allowing the `modified` count to reflect only genuine changes. This is required for SC-005 (zero net changes on second identical run).

Array fields use `JSON.stringify(arr.slice().sort())` to achieve order-independence.

**Alternatives considered**:
- Unconditional `ON CONFLICT DO UPDATE` (original spec code) — rejected: inflates `modified` count on idempotent runs; less correct
- Hash-based comparison (e.g. SHA256 of serialised entry) — rejected: unnecessary complexity for ~5 000 entries

---

## Decision 5: `isStale` in `getListMetadata`

**Decision**: Include `isStale: boolean` in the `ListMetadata` return value, computed with the same 24-hour threshold used by `OFACProvider._isStale()`.

**Rationale**: The sync worker (`screening-sync.js` lines 35–39) calls `provider.getListMetadata()` and checks `meta.isStale` to emit a staleness warning before each update cycle. This field is a de-facto part of the interface contract even though the `ScreeningProvider` typedef does not declare it explicitly. Omitting it would cause a silent `undefined` comparison in the sync worker.

**Alternatives considered**:
- Omit `isStale` — rejected: breaks sync worker warning at runtime

---

## Decision 6: Unrecognised DOB Format Handling

**Decision**: Store the raw value unchanged. No log, no error. The value will not match any well-formed DOB query (the substring match against, e.g., "circa 1970" → stripped "1970" could match, but only if fuzzy name score is already at threshold).

**Rationale**: Storing raw preserves auditability — the auditor can see exactly what was in the source list. Logging every unrecognised DOB would generate noisy output given that HMT occasionally uses free-text dates. This matches the spec clarification (Session 2026-04-27, Q4).

**Alternatives considered**:
- Discard the value — rejected: data loss; violates auditability principle
- Log a warning per entry — rejected: excessive log noise on every sync run

---

## Decision 7: Sync Audit Event Pattern

**Decision**: Implement `_writeSyncEvent()` with the exact column set used by `OFACProvider`: `list_name`, `status`, `entries_added`, `entries_removed`, `entries_modified`, `error_message`, `started_at`, `completed_at`. Write on every attempt (success and failure).

**Rationale**: Required by Constitution Principle I (Auditability First). Consistent column usage means existing audit queries and monitoring tooling work for UK-HMT without modification. The sync worker wraps `updateList()` in a try/catch and records results; the provider itself must also record the attempt so that failures during download (before the worker catch) are still audited.

**Alternatives considered**:
- Log only on failure — rejected: success path is also auditable; Constitution requires immutable event record for all data source interactions
- Separate audit mechanism — rejected: `screening_sync_events` is the established pattern with append-only enforcement already in place
