# Research: OFAC SDN Ingestion and Search

**Branch**: `014-ofac-sdn-ingestion`  
**Date**: 2026-04-27  
**Spec**: [spec.md](spec.md)

## 1. XML Parsing at Scale

**Decision**: Use `fast-xml-parser` (in-memory parse, no streaming).

**Rationale**: The OFAC SDN list is approximately 45–50 MB of XML, containing ~12,000 entries. Node.js 22 has a default heap of several GB; loading 50 MB into memory for parsing is well within bounds for a dedicated worker process. The spec already specifies `fast-xml-parser` and the existing codebase has no SAX/streaming XML parser infrastructure. Streaming parsers (e.g., `sax`) would add significant complexity with no measurable benefit at this list size. The 60-second ingest target (SC-001) is comfortably met with in-memory parsing.

**Alternatives considered**:
- `sax` (streaming): rejected — adds implementation complexity for no benefit at ~12k entries
- `xml2js`: rejected — `fast-xml-parser` is faster and its `isArray` option avoids the single-element list problem common with XML→JS conversion

**Action**: Add `fast-xml-parser` to `backend/package.json` dependencies.

---

## 2. Audit Event Store for Sync Outcomes

**Decision**: Create a new `screening_sync_events` table (append-only) rather than reusing `decision_events`.

**Rationale**: The `decision_events` table has a `NOT NULL` foreign key on `case_id` — sync runs are not tied to any KYC case. Three alternatives were evaluated:

| Option | Assessment |
|--------|------------|
| Null `case_id` in `decision_events` | Requires schema change to a core table; disrupts all existing `case_id`-centric queries and violates the design intent of the event store |
| Sentinel "system" case row | Hack — pollutes the `cases` table with a non-case entity; fragile and misleading in audit reports |
| Separate `screening_sync_events` table | Clean — mirrors append-only enforcement pattern from `decision_events`; purpose-specific schema; zero impact on existing tables |

The constitution (Principle I) requires an **immutable** event record. The `screening_sync_events` table enforces this via identical PostgreSQL rules (`DO INSTEAD NOTHING` for UPDATE and DELETE).

**Action**: Add `screening_sync_events` to `init.sql` and create a migration file for existing deployments.

---

## 3. Configurable Match Threshold

**Decision**: Add `match_threshold: 70` to each source block in `config/screening-sources.yaml`. Default is 70 (configurable per deployment per source).

**Rationale**: Constitution Principle V mandates that compliance thresholds be in YAML configuration, not hardcoded. The `ConfigService` already loads and validates `screening-sources.yaml` with a permissive Joi schema (`Joi.object().required()`), so adding `match_threshold` requires no schema change. The `OFACProvider` constructor receives the config object from the sync worker and reads `config.matchThreshold ?? 70`.

**Alternatives considered**:
- Global threshold in `risk-rules.yaml`: rejected — the threshold is source-specific (different lists may warrant different sensitivities)
- Hardcoded constant: rejected — violates Constitution Principle V

**Action**: Add `match_threshold: 70` to `ofac_sdn` block in `config/screening-sources.yaml`.

---

## 4. Staleness Detection Mechanism

**Decision**: Two-layer detection: (a) `getListMetadata()` returns `isStale: boolean` computed from `last_updated`; (b) the sync worker emits a `screening_list_stale` event to `screening_sync_events` at the start of each run if the list is already stale.

**Rationale**: Staleness detection should be observable from both the search path (consumers can see stale status in metadata) and the sync path (operational alerting). A 24-hour threshold is checked by comparing `NOW() - last_updated > 24 hours`. This is evaluated by the sync worker on each run and by `getListMetadata()` on demand.

**Staleness event shape** (written to `screening_sync_events`):
```json
{
  "list_name": "OFAC-SDN",
  "status": "stale_detected",
  "entries_added": 0,
  "entries_removed": 0,
  "entries_modified": 0,
  "error_message": "List has not been updated for 26h 14m"
}
```

**Action**: Implement `_isStale()` private method in `OFACProvider`; call it in `getListMetadata()` and at the start of `updateList()`.

---

## 5. Retry Logic for Download Failures

**Decision**: 3 retries with exponential backoff (base 2s, factor 2×: 2s → 4s → 8s) implemented in `_downloadXML()`. Uses `AbortController` for the 60s per-attempt timeout.

**Rationale**: The Treasury sanctions list service occasionally returns 5xx or connection timeouts during peak load. Three retries with exponential backoff handles transient failures without indefinitely blocking the worker. The maximum wait before giving up is 2 + 4 + 8 = 14 seconds of sleep plus up to 60s per attempt = ~3.5 minutes worst-case per sync run, well within operational bounds.

**Alternatives considered**:
- Fixed 3s retry delay: rejected — doesn't reduce load on a struggling server
- Unlimited retries: rejected — spec explicitly scopes to 3 retries (FR-014)

**Action**: Wrap `_downloadXML()` in a retry loop with `attempt` counter and `delay` calculation.

---

## 6. Fuzzy-Matcher Dependency

**Finding**: `backend/src/data-sources/screening/fuzzy-matcher.js` is currently a stub (`// TODO: implement`). The `OFACProvider` requires a `FuzzyMatcher` instance injected via constructor.

**Decision**: `OFACProvider` depends on `FuzzyMatcher` via constructor injection (already designed this way in the spec). Implementation of `FuzzyMatcher` is tracked under spec #19. The OFAC tasks must be sequenced after `FuzzyMatcher` is implemented, OR the `OFACProvider` tests must mock `FuzzyMatcher` (which is straightforward since it's injected).

**Action**: Unit tests for `OFACProvider` will use a mock `FuzzyMatcher`. Integration tests require `FuzzyMatcher` to be implemented (spec #19 dependency). Flag in `tasks.md` that integration test execution is blocked on spec #19.

---

## 7. `screening-sync.js` Worker Pattern

**Finding**: The existing `backend/src/workers/screening-sync.js` is a stub that runs `syncScreeningLists()` on a `setInterval` every 24 hours. The full implementation from the spec uses `getConfigService()`, instantiates providers, and calls `updateList()` for each.

**Decision**: Replace the stub with the full implementation. The worker self-manages its schedule via `setInterval`. This is consistent with how Docker Compose runs the `screening-sync` service continuously.

**Note**: The worker uses `getConfigService()` which requires `ConfigService.load()` to have been called. The worker must call `config.load()` before instantiating providers.

**Action**: Implement `syncScreeningLists()` in `backend/src/workers/screening-sync.js` with config loading, provider instantiation, retry-aware `updateList()` calls, and `screening_sync_events` writes.
