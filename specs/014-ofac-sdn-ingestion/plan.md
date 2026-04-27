# Implementation Plan: OFAC SDN Sanctions List Ingestion and Search

**Branch**: `014-ofac-sdn-ingestion` | **Date**: 2026-04-27 | **Spec**: [spec.md](spec.md)  
**Input**: Feature specification from `/specs/014-ofac-sdn-ingestion/spec.md`

## Summary

Implement `OFACProvider` — a Layer 2 data-integration component that downloads the OFAC SDN XML list (~12k entries, ~50 MB), parses it, and stores it locally in PostgreSQL. Provides fuzzy name search with DOB and nationality score boosts. A daily sync worker keeps the list current with 3-retry exponential backoff, records every run outcome to a new append-only `screening_sync_events` table, and emits a stale-list event if the list has not been updated in over 24 hours.

## Technical Context

**Language/Version**: Node.js 22 (JavaScript, CommonJS `'use strict'`)  
**Primary Dependencies**: `fast-xml-parser` (new), `pg` (existing), `bullmq` (existing), `js-yaml` (existing)  
**Storage**: PostgreSQL — existing `screening_lists` + `screening_entries` tables; new `screening_sync_events` table  
**Testing**: Jest (`cd backend && npm test`); test root: `tests/backend/`  
**Target Platform**: Linux (Docker container — `screening-sync` service in `docker-compose.yml`)  
**Project Type**: Backend library/worker (Layer 2: Data Integration)  
**Performance Goals**: Full list ingest < 60s (SC-001); name search < 500ms (SC-002)  
**Constraints**: Programmatic interface only — no REST endpoint. Sync is idempotent. Threshold configurable, default 70.  
**Scale/Scope**: ~12,000 SDN entries; single-tenant worker; no concurrent write contention

## Constitution Check

*GATE: Must pass before implementation begins. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Auditability First | **PASS** | Every sync run recorded as immutable row in `screening_sync_events` (append-only via PostgreSQL rules). `rawData` JSONB preserves original XML entry on every `screening_entries` row for audit replay. |
| II. LLM-Agnostic | **N/A** | This feature makes no LLM calls. Fuzzy matching is algorithmic. |
| III. Strict Layered Architecture | **PASS** | `OFACProvider` is Layer 2 (Data Integration). `screening-sync.js` worker sits outside the named layers — it is Docker infrastructure that calls Layer 2 providers directly. No upward dependency introduced. |
| IV. Data Sovereignty | **PASS** | Full SDN list stored locally in PostgreSQL. No data leaves the deployment boundary; the only outbound call is the download from the public Treasury endpoint. |
| V. Configuration-Driven | **PASS** | Source URL and sync schedule already in `config/screening-sources.yaml`. `match_threshold` added there (Constitution forbids hardcoding compliance thresholds). |

**Post-Phase 1 re-check**: All gates remain PASS. `screening_sync_events` append-only enforcement mirrors the `decision_events` pattern exactly.

## Project Structure

### Documentation (this feature)

```text
specs/014-ofac-sdn-ingestion/
├── plan.md              ← this file
├── research.md          ← Phase 0 output
├── data-model.md        ← Phase 1 output
├── quickstart.md        ← Phase 1 output
├── contracts/
│   └── ofac-provider.md ← Phase 1 output
└── tasks.md             ← Phase 2 output (/speckit.tasks — not yet created)
```

### Source Code

```text
backend/
├── src/
│   ├── data-sources/
│   │   └── screening/
│   │       ├── ofac.js            implement (currently stub)
│   │       ├── fuzzy-matcher.js   dependency — spec #19 (currently stub)
│   │       ├── uk-hmt.js          out of scope for this feature
│   │       └── types.js           no changes
│   └── workers/
│       └── screening-sync.js      implement (currently stub)
├── db/
│   ├── init.sql                   add screening_sync_events table
│   └── migrations/
│       └── [timestamp]_add-screening-sync-events.js   new migration
└── package.json                   add fast-xml-parser dependency

config/
└── screening-sources.yaml         add match_threshold: 70 to ofac_sdn block

tests/backend/
└── data-sources/
    └── screening/
        ├── ofac.test.js                         unit tests (new)
        └── screening-sync.integration.test.js   integration tests (new)
```

**Structure Decision**: Option 2 (web application — backend only). All new source files follow the existing Layer 2 pattern established by `companies-house.js` and `registry-factory.js`.

## Complexity Tracking

> No Constitution Check violations. Table left empty per template instruction.

## Phase 0: Research

**Status**: Complete. See [research.md](research.md).

Resolved decisions:

| Unknown | Decision |
|---------|----------|
| XML parsing strategy | `fast-xml-parser` in-memory; add to `package.json` |
| Sync audit storage | New `screening_sync_events` table (append-only); cannot use `decision_events` — requires `case_id` NOT NULL |
| Configurable threshold | `match_threshold: 70` in `config/screening-sources.yaml` per source |
| Staleness detection | `getListMetadata()` returns `isStale`; sync worker emits `stale_detected` event |
| Retry logic | 3 retries, exponential backoff (2s → 4s → 8s), 60s per-attempt timeout |
| `FuzzyMatcher` dependency | Injected via constructor; unit tests mock it; integration tests need spec #19 |

## Phase 1: Design & Contracts

**Status**: Complete.

### Data Model

See [data-model.md](data-model.md) for full schema.

**New table**: `screening_sync_events` — append-only audit log for sync run outcomes.  
**Existing tables unchanged**: `screening_lists`, `screening_entries`.  
**Config change**: `match_threshold: 70` added to `config/screening-sources.yaml`.

### Contracts

See [contracts/ofac-provider.md](contracts/ofac-provider.md).

**Interface**: `OFACProvider` implements `ScreeningProvider` (from `types.js`):
- `search(query: ScreeningQuery) → Promise<ScreeningHit[]>`
- `getListMetadata() → Promise<ListMetadata & { isStale: boolean }>`
- `updateList() → Promise<UpdateResult>`

**Sync worker exports**: `syncScreeningLists() → Promise<SyncSummary[]>`

### Implementation Notes

**`OFACProvider.search()`**
- Loads entries from DB filtered by `entityType`
- Iterates all entries; for each, compares query name against `primary_name` + all aliases using `fuzzyMatcher.compare()`
- Applies DOB boost (+10, capped at 100) if DOB strings normalise to match
- Applies nationality boost (+5, capped at 100) if any nationality includes query nationality (case-insensitive)
- Filters by `matchThreshold`; sorts descending

**`OFACProvider.updateList()`**
- Calls `_downloadXML()` (with 3-retry backoff)
- Calls `_parseXML()` → array of parsed entries
- Calls `_ensureList()` → upserts `screening_lists` row, caches `_listId`
- Calls `_upsertEntries()` → transaction: upsert all entries, delete removed entries
- Updates `screening_lists.last_updated` and `entry_count`
- Writes `screening_sync_events` row with outcome

**`OFACProvider._isStale()`**
- Returns `true` if `last_updated` is null or `NOW() - last_updated > 24h`
- Called by `getListMetadata()` and at the start of `updateList()`

**`syncScreeningLists()` worker**
- Calls `config.load()` before instantiating providers
- Constructs `OFACProvider` and `UKHMTProvider` from config
- Loops providers: calls `updateList()`, catches errors, records results
- On startup: emits `stale_detected` event if list is already stale

### Quickstart

See [quickstart.md](quickstart.md).
