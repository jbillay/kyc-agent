# Tasks: UK HMT Sanctions List Ingestion and Search

**Input**: Design documents from `/specs/015-uk-hmt-ingestion/`
**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/ ✓, quickstart.md ✓

**Tests**: Included — the feature spec acceptance criteria explicitly requires "Unit tests with known HMT entries".

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different methods/files, no blocking dependency)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)

---

## Phase 1: Setup

**Purpose**: Create the test file scaffold so US1, US2, and US3 tests can be written in parallel.

- [X] T001 Create test file skeleton with `jest.mock('../../../../backend/db/connection', ...)` and `makeFuzzyMatcher` / `makeProvider` / `makeTransactionClient` helper factories in `tests/backend/data-sources/screening/uk-hmt.test.js`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Class scaffold that all user story methods attach to. Nothing else can start until this exists.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T002 Replace the 4-line stub with a `UKHMTProvider` class skeleton (constructor only: `this.name = 'uk-hmt'`, `this.listType = 'sanctions'`, `this.sourceUrl`, `this.fuzzyMatcher`, `this.matchThreshold = config.matchThreshold ?? 70`, `this._listId = null`) and `module.exports = { UKHMTProvider }` in `backend/src/data-sources/screening/uk-hmt.js`

**Checkpoint**: `new UKHMTProvider({}, mockFuzzyMatcher)` instantiates without error; file exports correctly.

---

## Phase 3: User Story 1 — Screen an Entity Against the UK HMT List (Priority: P1) 🎯 MVP

**Goal**: A compliance analyst can call `search(query)` against the locally cached UK HMT list and receive ranked `ScreeningHit[]` with fuzzy scores, DOB boost, and nationality boost applied.

**Independent Test**: Seed `screening_entries` directly with a known HMT entry (no CSV required), call `provider.search({ name: 'DOE John' })`, verify a hit is returned with `source: 'UK-HMT'`, `matchScore ≥ threshold`, and `matchedFields` containing `'name'`.

### Tests for User Story 1

> **Write these tests FIRST, ensure they FAIL before implementation**

- [X] T003 [P] [US1] Write `_dobMatches` unit tests (exact match, partial year match where query "1985-03-15" matches stored "1985", mismatch where "1985" ≠ "1990", unrecognised format "circa 1970") in `tests/backend/data-sources/screening/uk-hmt.test.js`
- [X] T004 [P] [US1] Write `search` unit tests (exact name hit at max score, fuzzy hit above threshold, name below threshold returns empty, DOB boost adds +10 to score, nationality boost adds +5 to score, entity-type filter excludes wrong type, empty list returns empty array) in `tests/backend/data-sources/screening/uk-hmt.test.js`

### Implementation for User Story 1

- [X] T005 [P] [US1] Implement `_dobMatches(queryDOB, entryDOB)` — strip non-numeric chars from both values via `replace(/[^0-9]/g, '')`, return `q === e || q.includes(e) || e.includes(q)` — in `backend/src/data-sources/screening/uk-hmt.js`
- [X] T006 [P] [US1] Implement `_loadEntries(entityType)` — `pool.query` SELECT with JOIN on `screening_lists` WHERE `list_name = 'UK-HMT'` AND optional `entity_type` filter — in `backend/src/data-sources/screening/uk-hmt.js`
- [X] T007 [US1] Implement `search(query)` — call `_loadEntries`, iterate entries building `allNames = [primary_name, ...aliases]`, find best fuzzy score via `this.fuzzyMatcher.compare`, apply DOB boost (+10, capped at 100) and nationality boost (+5, capped at 100), push hit with `source: 'UK-HMT'` and `matchedFields`, sort descending by score — in `backend/src/data-sources/screening/uk-hmt.js` (depends on T005, T006)

**Checkpoint**: All US1 unit tests pass; `provider.search()` returns correct hits for a seeded entry with no CSV needed.

---

## Phase 4: User Story 2 — Ingest and Refresh the List (Priority: P2)

**Goal**: An operator can call `updateList()` to download the GOV.UK CSV, parse Name1–Name6 grouped by Group ID, idempotently upsert entries, and write an append-only audit event to `screening_sync_events`.

**Independent Test**: Mock `_downloadCSV` to return the CSV fixture from `quickstart.md`. Call `provider.updateList()` twice. Verify: first call inserts 1 entry and writes a `'success'` sync event; second call produces `{ added: 0, removed: 0, modified: 0 }` and writes another `'success'` sync event. Then call with a CSV missing the entry and verify `removed: 1`.

### Tests for User Story 2

> **Write these tests FIRST, ensure they FAIL before implementation**

- [X] T008 [P] [US2] Write `_parseCSVLines` unit tests (quoted field with embedded comma, escaped double-quote `""`, CRLF line ending, row with <10 columns is skipped, empty trailing field preserved) in `tests/backend/data-sources/screening/uk-hmt.test.js`
- [X] T009 [P] [US2] Write `_normalizeDOB` unit tests (`'01/03/1985'` → `'1985-03-01'`, `'03/1985'` → `'1985-03'`, `'1985'` → `'1985'`, `'circa 1970'` → `'circa 1970'`) in `tests/backend/data-sources/screening/uk-hmt.test.js`
- [X] T010 [P] [US2] Write `_parseCSV` unit tests (two rows same Group ID → one entry with primary + alias; blank Name1–6 row produces no name entry; `'Individual'` → `'individual'`; non-`'Individual'` → `'entity'`; nationality and program collected and deduplicated across rows; no-Primary-Name row uses first name as primary) in `tests/backend/data-sources/screening/uk-hmt.test.js`
- [X] T011 [P] [US2] Write `updateList` unit tests (first run inserts entries and calls `_writeSyncEvent('success')`; second identical run produces zero changes; new CSV with removed entry calls DELETE; download failure after all retries calls `_writeSyncEvent('failure')` and rethrows without touching existing entries) in `tests/backend/data-sources/screening/uk-hmt.test.js`

### Implementation for User Story 2

- [X] T012 [P] [US2] Implement `_parseCSVLines(csv)` — character-by-character loop: track `inQuotes`, handle `""` escape, push field on `,`, push row on `\n`/`\r\n`, skip rows with ≤1 column — in `backend/src/data-sources/screening/uk-hmt.js`
- [X] T013 [P] [US2] Implement `_normalizeDOB(dob)` — regex for `DD/MM/YYYY` → `YYYY-MM-DD`, `MM/YYYY` → `YYYY-MM`, bare `YYYY` passthrough, raw fallback — in `backend/src/data-sources/screening/uk-hmt.js`
- [X] T014 [US2] Implement `_parseCSV(csv)` — call `_parseCSVLines`, skip header (index 0), group rows by col 2 (Group ID), per row: join non-empty cols 3–8 with space to form name, push `{ name, type: cols[9] }`, collect col 12 DOB (first non-empty, via `_normalizeDOB`), col 15 nationality (Set), col 25 program (Set), col 26 listedOn; convert Map to array of entries with primaryName/aliases/entityType/rawData — in `backend/src/data-sources/screening/uk-hmt.js` (depends on T012, T013)
- [X] T015 [US2] Implement `_downloadCSV()` — `new AbortController()` with 60 s timeout, `fetch(this.sourceUrl, { signal })`, retry loop up to 3 attempts (delays 2 000 ms / 4 000 ms / 8 000 ms), throw on non-ok response or final network error — in `backend/src/data-sources/screening/uk-hmt.js`
- [X] T016 [P] [US2] Implement `_ensureList()` — `pool.query` INSERT INTO `screening_lists (list_name, list_type, source_url)` VALUES `('UK-HMT', 'sanctions', $1)` ON CONFLICT (list_name) DO UPDATE SET source_url = EXCLUDED.source_url RETURNING id; cache result in `this._listId` — in `backend/src/data-sources/screening/uk-hmt.js`
- [X] T017 [P] [US2] Implement `_entryChanged(existing, newEntry)` — compare `primary_name`, `aliases` (sorted JSON), `date_of_birth`, `nationalities` (sorted JSON), `programs` (sorted JSON), `remarks` — return true if any differ — in `backend/src/data-sources/screening/uk-hmt.js`
- [X] T018 [P] [US2] Implement `_writeSyncEvent({ status, entriesAdded, entriesRemoved, entriesModified, errorMessage, startedAt, completedAt })` — `pool.query` INSERT INTO `screening_sync_events (list_name, status, entries_added, entries_removed, entries_modified, error_message, started_at, completed_at)` VALUES `('UK-HMT', $1, $2, $3, $4, $5, $6, $7)` — in `backend/src/data-sources/screening/uk-hmt.js`
- [X] T019 [US2] Implement `_upsertEntries(listId, entries)` — wrap in `pool.connect()` transaction: SELECT existing entry_ids for listId, for each new entry call `_entryChanged` and only issue UPDATE if changed (or INSERT if new), DELETE entries whose IDs are absent from new set, COMMIT; return `{ added, removed, modified }` — in `backend/src/data-sources/screening/uk-hmt.js` (depends on T016, T017)
- [X] T020 [US2] Implement `updateList()` — capture `startedAt = new Date()`; try: `_downloadCSV()` → `_parseCSV()` → `_ensureList()` → `_upsertEntries()` → UPDATE `screening_lists` SET `last_updated = NOW(), entry_count = $1` WHERE `id = $2` → `_writeSyncEvent('success', ...)` → return `UpdateResult`; catch: `_writeSyncEvent('failure', ..., errorMessage: err.message)` → rethrow — in `backend/src/data-sources/screening/uk-hmt.js` (depends on T014, T015, T018, T019)
- [X] T021 [US2] Register `UKHMTProvider` in the sync worker: add `const { UKHMTProvider } = require('../data-sources/screening/uk-hmt');` import and uncomment the `providers.push(new UKHMTProvider(...))` line in `backend/src/workers/screening-sync.js` (depends on T020)

**Checkpoint**: `provider.updateList()` on the quickstart fixture inserts entries on first run; zero changes on second run; one `'success'` sync event per run; all US2 unit tests pass.

---

## Phase 5: User Story 3 — Check List Metadata (Priority: P3)

**Goal**: An operator can call `getListMetadata()` to confirm whether the local UK HMT list is present, how many entries it contains, when it was last refreshed, and whether it is stale (>24 h old).

**Independent Test**: Call `provider.getListMetadata()` with a mocked pool returning a `screening_lists` row with a fresh timestamp — verify `isStale: false`. Call with a timestamp 25 h ago — verify `isStale: true`. Call with no row — verify zero-entry default and `isStale: true`.

### Tests for User Story 3

> **Write these tests FIRST, ensure they FAIL before implementation**

- [X] T022 [P] [US3] Write `getListMetadata` unit tests (list row present with fresh timestamp → all fields populated, `isStale: false`; list row with timestamp 25 h ago → `isStale: true`; no row in DB → zero-entry default, `lastUpdated: null`, `isStale: true`) in `tests/backend/data-sources/screening/uk-hmt.test.js`

### Implementation for User Story 3

- [X] T023 [P] [US3] Implement `_isStale(lastUpdated)` — return `true` if `lastUpdated` is null or `Date.now() - new Date(lastUpdated).getTime() > 24 * 60 * 60 * 1000` — in `backend/src/data-sources/screening/uk-hmt.js`
- [X] T024 [US3] Implement `getListMetadata()` — `pool.query` SELECT `list_name, list_type, source_url, last_updated, entry_count` FROM `screening_lists` WHERE `list_name = 'UK-HMT'`; if no row return `{ listName: 'UK-HMT', listType: 'sanctions', sourceUrl: this.sourceUrl, lastUpdated: null, entryCount: 0, isStale: true }`; else map row and call `_isStale(row.last_updated?.toISOString())` — in `backend/src/data-sources/screening/uk-hmt.js` (depends on T023)

**Checkpoint**: All three user stories independently functional; `getListMetadata()` correctly reports staleness; all US3 unit tests pass.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Full test run, export verification, regression check.

- [X] T025 [P] Verify `module.exports = { UKHMTProvider }` is the last statement in `backend/src/data-sources/screening/uk-hmt.js` and matches the export pattern in `ofac.js`
- [X] T026 Run `cd backend && npx jest tests/backend/data-sources/screening/uk-hmt.test.js` and confirm all tests pass with zero failures
- [X] T027 Run `cd backend && npm test` to confirm no regressions across the full backend test suite

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 — no dependency on US2 or US3
- **US2 (Phase 4)**: Depends on Phase 2 — no dependency on US1 or US3
- **US3 (Phase 5)**: Depends on Phase 2 — no dependency on US1 or US2
- **Polish (Phase 6)**: Depends on all desired user stories being complete

### User Story Dependencies

- **US1 (P1)**: After Phase 2 only — `_dobMatches` and `_loadEntries` are independent of all US2 methods
- **US2 (P2)**: After Phase 2 only — CSV parser, download, upsert have no dependency on US1 methods
- **US3 (P3)**: After Phase 2 only — `getListMetadata` and `_isStale` are independent of US1 and US2

### Within US2

```
T012 ──┐
T013 ──┤→ T014 ──┐
                  ├→ T020 → T021
T015 ─────────────┤
T016 ──┐           │
T017 ──┤→ T019 ───┘
T018 ─────────────┘
```

T008, T009, T010, T011 (tests) can all run in parallel before any implementation task begins.

### Parallel Opportunities

| Parallel group | Tasks |
|---|---|
| US1 tests | T003, T004 |
| US1 helpers | T005, T006 |
| US2 tests | T008, T009, T010, T011 |
| US2 CSV helpers | T012, T013 |
| US2 DB helpers | T016, T017, T018 |
| US3 tests + US2 work | T022 alongside any US2 task |
| Polish | T025, T026 |

---

## Parallel Example: User Story 2

```
# Round 1 — write all US2 tests simultaneously:
T008: "_parseCSVLines tests"
T009: "_normalizeDOB tests"
T010: "_parseCSV tests"
T011: "updateList tests"

# Round 2 — implement leaf helpers (all parallel):
T012: "_parseCSVLines implementation"
T013: "_normalizeDOB implementation"
T016: "_ensureList implementation"
T017: "_entryChanged implementation"
T018: "_writeSyncEvent implementation"

# Round 3 — implement composites (sequential within chain):
T014: "_parseCSV" (depends on T012 + T013)
T015: "_downloadCSV" (no local deps)
T019: "_upsertEntries" (depends on T016 + T017)

# Round 4 — orchestrator:
T020: "updateList" (depends on T014 + T015 + T018 + T019)
T021: "sync worker registration" (depends on T020)
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1 + Phase 2 (setup + constructor)
2. Complete Phase 3 (US1 — search)
3. **STOP and VALIDATE**: Seed the DB with a known entry, call `search()`, verify hit with correct score
4. US1 is independently shippable — the Screening Agent (spec #27–28) can consume it now

### Incremental Delivery

1. Phase 1 + 2 → class instantiates cleanly
2. Phase 3 (US1) → search works against seeded data → demo-able
3. Phase 4 (US2) → full ingest cycle; search now works against real HMT data → production-ready
4. Phase 5 (US3) → staleness monitoring enabled → operationally complete
5. Phase 6 → all tests green, no regressions

### Parallel Team Strategy

With two developers after Phase 2 completes:

- **Dev A**: Phase 3 (US1 — search: `_dobMatches`, `_loadEntries`, `search`)
- **Dev B**: Phase 4 (US2 — ingest: CSV parser, download, upsert chain)
- US3 takes ~2 tasks and can be done by either dev after their story is complete

---

## Notes

- [P] tasks involve different methods or have no blocking dependency — safe to run in parallel
- [Story] label provides traceability from task → user story → acceptance scenario
- Tests MUST fail before the corresponding implementation task begins (TDD)
- All 27 tasks touch only 3 files: `uk-hmt.js`, `uk-hmt.test.js`, and 2 lines in `screening-sync.js`
- No schema migrations, no new npm packages, no YAML config changes required
- Commit after each phase checkpoint; use the `015-uk-hmt-ingestion` branch throughout
