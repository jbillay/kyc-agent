# Tasks: OFAC SDN Sanctions List Ingestion and Search

**Input**: Design documents from `/specs/014-ofac-sdn-ingestion/`  
**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/ofac-provider.md ✓

**Tests**: Included — the feature specification explicitly defines 13 test scenarios and requires "unit tests with known SDN entries" as an acceptance criterion.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Exact file paths included in all descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Install dependencies and provision schema before any implementation begins.

- [x] T001 Add `fast-xml-parser` to dependencies in `backend/package.json` (run `npm install fast-xml-parser` and commit the updated lockfile)
- [x] T002 [P] Add `screening_sync_events` DDL to `backend/db/init.sql`: table definition, append-only PostgreSQL rules (`DO INSTEAD NOTHING` for UPDATE and DELETE), and index on `(list_name, started_at DESC)` — see data-model.md for full SQL
- [x] T003 [P] Create `backend/db/migrations/[timestamp]_add-screening-sync-events.js` using node-pg-migrate format containing the same `screening_sync_events` DDL (for existing deployed instances)
- [x] T004 [P] Add `match_threshold: 70` field to the `ofac_sdn` block in `config/screening-sources.yaml`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Class skeleton that all user story phases build on top of. No user story work can begin until this is complete.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T005 Create `OFACProvider` class skeleton in `backend/src/data-sources/screening/ofac.js`: constructor that sets `this.name`, `this.listType`, `this.sourceUrl`, `this.fuzzyMatcher`, `this.matchThreshold` (from `config.matchThreshold ?? 70`), and `this._listId`; stub out all methods (`search`, `getListMetadata`, `updateList`, `_downloadXML`, `_parseXML`, `_ensureList`, `_upsertEntries`, `_loadEntries`, `_dobMatches`, `_isStale`); add `module.exports = { OFACProvider }` — see contracts/ofac-provider.md for full method signatures

**Checkpoint**: Class skeleton in place — user story phases can now begin.

---

## Phase 3: User Story 1 — Screen a Name Against the SDN List (Priority: P1) 🎯 MVP

**Goal**: Fuzzy name search against the locally stored SDN list, with DOB and nationality score boosts.

**Independent Test**: Seed `screening_entries` with a known SDN fixture; call `provider.search({ name: 'John Doe', entityType: 'individual' })` and verify a `matchScore: 100` hit is returned with all required fields. Call with an unrelated name and verify `[]`.

### Tests for User Story 1

> **Write these first — verify they FAIL before implementing**

- [x] T006 [US1] Create `tests/backend/data-sources/screening/ofac.test.js` with a sample SDN XML fixture string (individual entry with aliases, DOB, nationality, programs) and write unit tests for `_parseXML()`: correct field extraction (`primaryName`, `aliases`, `dateOfBirth`, `nationalities`, `programs`, `remarks`, `entryId`, `entityType`); `sdnType='Individual'` → `entityType: 'individual'`; `sdnType='Entity'` → `entityType: 'entity'`; `akaList` entries extracted into `aliases` array; `programList` entries extracted into `programs` array
- [x] T007 [US1] Add unit tests for `search()` to `tests/backend/data-sources/screening/ofac.test.js` — mock `pool.query` to return a seeded entry and mock `FuzzyMatcher.compare()`: exact name match → `matchScore: 100`, `source: 'OFAC-SDN'`, full `listEntry` fields, `rawData` present; misspelled name → partial score above `matchThreshold`; unrelated name (mock returns score below threshold) → `[]`; query with matching DOB → `matchScore` is 10 higher than name-only; query with matching nationality → `matchScore` is 5 higher than name-only

### Implementation for User Story 1

- [x] T008 [US1] Implement `_parseXML(xml)` in `backend/src/data-sources/screening/ofac.js` using `fast-xml-parser` with `ignoreAttributes: false` and `isArray` for `['sdnEntry','aka','program','dateOfBirthItem','nationality']`; combine `firstName + lastName` for `primaryName`; extract `akaList`, `programList`, `dateOfBirthList` (first entry only), `nationalityList`; return array of plain objects matching the `screening_entries` column shape
- [x] T009 [US1] Implement `_loadEntries(entityType)` in `backend/src/data-sources/screening/ofac.js`: query `SELECT entry_id, primary_name, aliases, date_of_birth, nationalities, programs, remarks, raw_data FROM screening_entries se JOIN screening_lists sl ON se.list_id = sl.id WHERE sl.list_name = 'OFAC-SDN' AND ($1::varchar IS NULL OR se.entity_type = $1)` using `pool.query`
- [x] T010 [US1] Implement `_dobMatches(queryDOB, entryDOB)` in `backend/src/data-sources/screening/ofac.js`: strip non-numeric characters from both strings; return true if equal or either contains the other as a substring
- [x] T011 [US1] Implement `search(query)` in `backend/src/data-sources/screening/ofac.js`: load entries via `_loadEntries`; for each entry compare query name against `primary_name` and all aliases using `this.fuzzyMatcher.compare()`; track best score and matched name; apply DOB boost (+10, capped at 100) via `_dobMatches`; apply nationality boost (+5, capped at 100) via case-insensitive `.includes()`; filter entries below `this.matchThreshold`; sort descending by score; return `ScreeningHit[]` per types.js shape

**Checkpoint**: `search()` is fully functional. Unit tests pass. User Story 1 independently testable with seeded DB data.

---

## Phase 4: User Story 2 — Keep the Local SDN List Current (Priority: P2)

**Goal**: Download, parse, and idempotently upsert the SDN list; retry on failure; record every outcome to `screening_sync_events`.

**Independent Test**: Run `provider.updateList()` twice in succession against the same (mocked) XML; verify `entriesAdded = 0`, `entriesRemoved = 0`, `entriesModified = 0` on the second call. Verify a row appears in `screening_sync_events` after each call.

### Tests for User Story 2

> **Write these first — verify they FAIL before implementing**

- [x] T012 [US2] Add unit tests for `updateList()` to `tests/backend/data-sources/screening/ofac.test.js` — mock `fetch` and `pool`: idempotency (second call with identical parsed entries → `entriesAdded=0, entriesRemoved=0, entriesModified=0`); entry absent from second XML call → removed from DB (DELETE is called with its `entry_id`); `fetch` throws `TypeError` three times → `_downloadXML` throws after third attempt (verify 3 calls to `fetch`); successful `updateList()` → row inserted into `screening_sync_events` with `status='success'`

### Implementation for User Story 2

- [x] T013 [US2] Implement `_downloadXML()` in `backend/src/data-sources/screening/ofac.js` with 3-retry exponential backoff: attempt 1 — delay 0ms; on failure wait 2000ms, attempt 2; on failure wait 4000ms, attempt 3; on failure wait 8000ms, attempt 4 (final); each attempt uses a fresh `AbortController` with 60-second timeout; throw on exhaustion
- [x] T014 [US2] Implement `_ensureList()` in `backend/src/data-sources/screening/ofac.js`: `INSERT INTO screening_lists (list_name, list_type, source_url) VALUES ('OFAC-SDN', 'sanctions', $1) ON CONFLICT (list_name) DO UPDATE SET source_url = EXCLUDED.source_url RETURNING id`; cache result in `this._listId`; return list UUID
- [x] T015 [US2] Implement `_upsertEntries(listId, entries)` in `backend/src/data-sources/screening/ofac.js`: open transaction; fetch existing `entry_id` set; upsert each entry with `ON CONFLICT (list_id, entry_id) DO UPDATE ... RETURNING (xmax = 0) AS is_insert`; count `added` and `modified`; DELETE entries no longer in source; commit; return `{ added, removed, modified }`; rollback on error
- [x] T016 [US2] Implement `updateList()` in `backend/src/data-sources/screening/ofac.js`: call `_downloadXML()`, `_parseXML()`, `_ensureList()`, `_upsertEntries()`; UPDATE `screening_lists` with `last_updated = NOW()` and `entry_count`; write result row to `screening_sync_events` (`status='success'`, counts, `completed_at`); wrap in try/catch — on error write `status='failure'` row to `screening_sync_events` then rethrow; return `UpdateResult`
- [x] T017 [US2] Implement `syncScreeningLists()` in `backend/src/workers/screening-sync.js`: call `getConfigService().load()`; construct `OFACProvider` and `UKHMTProvider` with config and a shared `FuzzyMatcher` instance; iterate providers — call `updateList()`, log result, catch errors and record `{ provider: name, error: message }`; return `SyncSummary[]`

**Checkpoint**: `updateList()` and `syncScreeningLists()` are functional. Idempotency, retry, and audit events verified by unit tests.

---

## Phase 5: User Story 3 — Detect and Surface a Stale SDN List (Priority: P2)

**Goal**: Compute `isStale` from `last_updated`; emit a `stale_detected` event when `updateList()` runs against a stale list.

**Independent Test**: Mock `pool.query` to return `last_updated = 26 hours ago`; call `provider.getListMetadata()` and assert `isStale: true`. Call `provider.updateList()` and assert a `screening_sync_events` row with `status='stale_detected'` is written before the download begins.

### Tests for User Story 3

> **Write these first — verify they FAIL before implementing**

- [x] T018 [US3] Add unit tests for `_isStale()` and stale event to `tests/backend/data-sources/screening/ofac.test.js`: `lastUpdated = null` → returns `true`; `lastUpdated = 26h ago` → returns `true`; `lastUpdated = 12h ago` → returns `false`; mocked `pool.query` returns `last_updated` 26h ago → `updateList()` inserts a `screening_sync_events` row with `status='stale_detected'` before the `fetch` call

### Implementation for User Story 3

- [x] T019 [US3] Implement `_isStale(lastUpdated)` private method in `backend/src/data-sources/screening/ofac.js`: return `true` if `lastUpdated` is null/undefined or `Date.now() - new Date(lastUpdated).getTime() > 24 * 60 * 60 * 1000`
- [x] T020 [US3] Wire staleness check at the start of `updateList()` in `backend/src/data-sources/screening/ofac.js`: after `_ensureList()`, query `last_updated` from `screening_lists`; call `_isStale(lastUpdated)`; if stale, insert a `screening_sync_events` row with `status='stale_detected'` and `error_message` showing elapsed hours; then proceed with download
- [x] T021 [US3] Wire staleness check into `syncScreeningLists()` in `backend/src/workers/screening-sync.js`: after `updateList()` completes for each provider, call `provider.getListMetadata()`; if `isStale: true`, log an ERROR-level message with list name and `lastUpdated` value (note: this task depends on T024 `getListMetadata()` being implemented)

**Checkpoint**: Stale lists are detected and surfaced in `screening_sync_events` and worker logs.

---

## Phase 6: User Story 4 — Inspect Sanctions List Metadata (Priority: P3)

**Goal**: `getListMetadata()` returns the list's current status including computed `isStale` flag.

**Independent Test**: Call `provider.getListMetadata()` when `screening_lists` has no 'OFAC-SDN' row; assert default shape (`entryCount: 0`, `lastUpdated: null`, `isStale: true`). Seed a row with `last_updated = 1 hour ago`; call again; assert `isStale: false` and correct `entryCount`.

### Tests for User Story 4

> **Write these first — verify they FAIL before implementing**

- [x] T022 [US4] Add unit tests for `getListMetadata()` to `tests/backend/data-sources/screening/ofac.test.js`: `pool.query` returns no rows → `{ listName: 'OFAC-SDN', listType: 'sanctions', entryCount: 0, lastUpdated: null, isStale: true, sourceUrl: <configured> }`; `pool.query` returns row with `last_updated = 1h ago, entry_count = 12345` → `{ entryCount: 12345, lastUpdated: <ISO string>, isStale: false }`

### Implementation for User Story 4

- [x] T023 [US4] Implement `getListMetadata()` in `backend/src/data-sources/screening/ofac.js`: `SELECT list_name, list_type, source_url, last_updated, entry_count FROM screening_lists WHERE list_name = 'OFAC-SDN'`; if no row return default; compute `isStale` via `_isStale(row.last_updated)`; return `ListMetadata & { isStale }` shape per contracts/ofac-provider.md
- [x] T024 [US3] Wire `getListMetadata()` into `syncScreeningLists()` in `backend/src/workers/screening-sync.js` (completes T021): replace TODO comment with actual `provider.getListMetadata()` call; log `[WARN] OFAC-SDN list is stale — last updated: ${meta.lastUpdated ?? 'never'}` if `meta.isStale`

**Checkpoint**: All four user stories are independently functional and tested. Full `OFACProvider` interface is implemented.

---

## Phase 7: Polish & Cross-Cutting Concerns

- [x] T025 Run `cd backend && npm test` and confirm all unit tests in `tests/backend/data-sources/screening/ofac.test.js` pass with no failures or skipped tests
- [x] T026 [P] Create `tests/backend/data-sources/screening/screening-sync.integration.test.js` with integration tests against a real PostgreSQL instance: verify `screening_sync_events` append-only enforcement (attempt `UPDATE` and `DELETE`, assert rows unchanged); verify a full `updateList()` call with a sample XML string stores entries in `screening_entries` and a success row in `screening_sync_events` (note: requires running PostgreSQL — mark with `@integration` tag or skip in CI without `DATABASE_URL`)
- [x] T027 [P] Add JSDoc annotations (`@param`, `@returns`, `@throws`) to all public methods (`search`, `getListMetadata`, `updateList`) in `backend/src/data-sources/screening/ofac.js`
- [x] T028 Verify quickstart.md steps are accurate: run the manual sync command from quickstart.md, confirm console output matches expected format, confirm `screening_lists` row is created with correct `list_name` and `entry_count`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — all 4 tasks can start immediately and T002–T004 run in parallel
- **Phase 2 (Foundational)**: Depends on Phase 1 — BLOCKS all user story phases
- **Phase 3 (US1)**: Depends on Phase 2 completion — no dependency on US2/US3/US4
- **Phase 4 (US2)**: Depends on Phase 2 completion; builds on `_parseXML` from Phase 3 but does not require Phase 3 to be complete
- **Phase 5 (US3)**: Depends on Phase 2; `T021` additionally depends on `T023` (getListMetadata from Phase 6)
- **Phase 6 (US4)**: Depends on Phase 2; `T024` additionally depends on `T023` completing
- **Phase 7 (Polish)**: Depends on Phases 3–6 completion

### User Story Dependencies

- **US1 (P1)**: Independent after Phase 2 — no dependency on US2/US3/US4
- **US2 (P2)**: Independent after Phase 2; reuses `_parseXML` from US1 but does not wait for US1 to complete
- **US3 (P2)**: Independent after Phase 2 for `_isStale()` and `updateList()` wiring; `syncScreeningLists()` wiring (T021/T024) requires US4 `getListMetadata()`
- **US4 (P3)**: Independent after Phase 2; `getListMetadata()` only queries the DB

### Critical Path

```
T001 → T005 → T006 → T008 → T011 → T025
              T007 ↗
```

### Parallel Opportunities (within Phase 1)

```
T001 (package.json)
T002 (init.sql)       ← run in parallel
T003 (migration)      ← run in parallel
T004 (config yaml)    ← run in parallel
```

### Parallel Opportunities (within Polish Phase)

```
T025 (run tests)
T026 (integration test file)   ← run in parallel
T027 (JSDoc annotations)       ← run in parallel
```

---

## Parallel Example: User Story 1

```bash
# Once T005 (class skeleton) is complete, write tests and implement in any order:

# These can be written independently (sequential within same file):
Task T006: _parseXML unit tests
Task T007: search() unit tests

# Implementation in natural dependency order:
Task T008: _parseXML   ← must come first (no DB needed, pure function)
Task T009: _loadEntries
Task T010: _dobMatches
Task T011: search      ← depends on T008, T009, T010
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T004)
2. Complete Phase 2: Foundational (T005) — CRITICAL
3. Complete Phase 3: User Story 1 (T006–T011)
4. **STOP and VALIDATE**: Run `npm test`, seed DB, call `search()`, verify results
5. US1 can be demonstrated independently at this point

### Incremental Delivery

1. Setup + Foundational → class skeleton ready
2. User Story 1 → search working; independently testable
3. User Story 2 → sync + audit working; independently testable
4. User Story 3 → stale detection wired in; independently testable
5. User Story 4 → metadata endpoint complete; full interface done
6. Polish → all tests pass; integration test; docs clean

### Notes on `FuzzyMatcher` Dependency

`FuzzyMatcher` (spec #19) is currently a stub. All unit tests mock it via jest. The integration test in T026 will also need to mock it unless spec #19 is implemented first. Flag T026 as blocked on spec #19 if running integration tests against the full pipeline.

---

## Notes

- `[P]` tasks = different files, no dependencies on incomplete tasks
- `[Story]` label maps to spec.md user stories for traceability
- Each user story is independently testable after Phase 2 completion
- Write failing tests before implementing (TDD per spec requirement)
- Commit after each checkpoint (end of each phase)
- T021 and T024 in Phase 5/6 have a cross-phase dependency: T021 depends on T023 — do T023 before T021
