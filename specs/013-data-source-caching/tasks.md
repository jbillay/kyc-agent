# Tasks: Data Source Response Caching and Versioning

**Input**: Design documents from `/specs/013-data-source-caching/`  
**Prerequisites**: plan.md ✅ | spec.md ✅ | research.md ✅ | data-model.md ✅ | contracts/ ✅ | quickstart.md ✅

**Organization**: Tasks are grouped by user story so each story can be implemented, tested, and validated independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to
- All paths are relative to repo root

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Configuration update needed before implementation begins.

- [x] T001 Add `cache_ttl_hours: 1` for `ofac_sdn` and `uk_hmt` under a new `data_sources.screening` section in `config/data-sources.yaml`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Private infrastructure methods that ALL user stories depend on. Must be complete before any story phase begins.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T002 Scaffold `DataSourceCache` class in `backend/src/data-sources/cache.js` — replace TODO stub with `'use strict'`, import `crypto` (built-in) and `{ query }` from `'../db/connection'`, add constructor accepting `options = {}` with `this.defaultTTLHours = 24`, `this.ttlHours = { 'companies-house': 24, 'ofac-sdn': 1, 'uk-hmt': 1, ...options.ttlHours }`, `this._hits = 0`, `this._misses = 0`
- [x] T003 [P] Implement `DataSourceCache._hashQuery(provider, method, queryParams)` in `backend/src/data-sources/cache.js` — return `crypto.createHash('sha256').update(JSON.stringify({ provider, method, params: queryParams })).digest('hex')`
- [x] T004 [P] Implement `DataSourceCache._lookup(provider, queryHash)` in `backend/src/data-sources/cache.js` — `SELECT id, response_data, fetched_at, case_id FROM data_source_cache WHERE provider = $1 AND query_hash = $2 AND expires_at > NOW() ORDER BY fetched_at DESC LIMIT 1`; return `result.rows[0] || null`
- [x] T005 [P] Implement `DataSourceCache._store({ provider, queryHash, queryParams, responseData, ttlHours, caseId })` in `backend/src/data-sources/cache.js` — `INSERT INTO data_source_cache (provider, query_hash, query_params, response_data, fetched_at, expires_at, case_id) VALUES ($1, $2, $3, $4, NOW(), NOW() + INTERVAL '1 hour' * $5, $6) ON CONFLICT DO NOTHING`; use `query(sql, [provider, queryHash, queryParams, responseData, ttlHours, caseId || null])`
- [x] T006 Implement `DataSourceCache._linkToCase(caseId, provider, queryHash)` in `backend/src/data-sources/cache.js` — `UPDATE data_source_cache SET case_id = $1 WHERE id = (SELECT id FROM data_source_cache WHERE provider = $2 AND query_hash = $3 AND expires_at > NOW() AND case_id IS NULL ORDER BY fetched_at DESC LIMIT 1)`

**Checkpoint**: Private helpers complete — user story implementation can begin.

---

## Phase 3: User Story 1 — Transparent Cached Data Access (Priority: P1) 🎯 MVP

**Goal**: Agents get data through `getOrFetch` without knowing whether it came from cache or a live fetch. `withCache` and `withCacheScreening` make any provider transparently cached.

**Independent Test**: Call `getOrFetch` twice with the same params on an empty cache. Confirm the first call invokes `fetchFn` and the second does not. The returned `data` is identical both times.

- [x] T007 [US1] Implement `DataSourceCache.getOrFetch({ provider, method, queryParams, caseId, bypassCache = false, fetchFn })` in `backend/src/data-sources/cache.js` — compute hash via `_hashQuery`; if `!bypassCache` call `_lookup` and on hit increment `_hits`, conditionally call `_linkToCase` (when `caseId` provided and `cached.case_id` is null), return `{ data: cached.response_data, fromCache: true, cachedAt: cached.fetched_at }`; on miss increment `_misses`, call `fetchFn()`, call `_store` with `this.ttlHours[provider] ?? this.defaultTTLHours`, return `{ data, fromCache: false, cachedAt: null }`; propagate any error from `fetchFn` directly (no catch)
- [x] T008 [US1] Create `backend/src/data-sources/cached-provider.js` — implement `withCache(provider, cache)` using `Object.create(provider)`, iterating over `['searchEntity','getEntityDetails','getOfficers','getShareholders','getFilingHistory','getEntityStatus']`, skipping methods not present on provider; each wrapped method accepts `(queryParams, options = {})`, normalises a string `queryParams` to `{ id: queryParams }`, calls `cache.getOrFetch(...)` and returns `.then(r => r.data)`
- [x] T009 [P] [US1] Add `withCacheScreening(provider, cache)` to `backend/src/data-sources/cached-provider.js` — same `Object.create` pattern, wraps `search` method only; `getListMetadata` and `updateList` are NOT wrapped and remain as direct delegation
- [x] T010 [P] [US1] Write cache miss and cache hit unit tests in `tests/backend/data-sources/cache.test.js` — mock `'../../../backend/db/connection'` with `jest.mock`; mock `query` to return empty rows for miss, then a valid row for hit; verify `fetchFn` is called on miss and NOT called on hit; verify `fromCache` flag is correct
- [x] T011 [P] [US1] Write `withCache` and `withCacheScreening` unit tests in `tests/backend/data-sources/cached-provider.test.js` — verify all 6 `RegistryProvider` methods are wrapped; verify string arg is normalised to `{ id }`; verify non-wrapped methods on a custom provider delegate directly; verify `provider.name` is accessible on wrapped object; verify `withCacheScreening` wraps `search` only; verify `getListMetadata` and `updateList` delegate directly

**Checkpoint**: US1 complete. `DataSourceCache.getOrFetch` works, both provider wrappers work. Core cache behaviour is independently testable.

---

## Phase 4: User Story 2 — Audit-Proof Evidence Trail (Priority: P2)

**Goal**: Old cache entries are never deleted. Each entry can be linked to the KYC case that triggered it. Linking targets the most recent valid entry only.

**Independent Test**: Insert a cache entry with `case_id = null`. Call `getOrFetch` again with a `caseId`. Confirm `_linkToCase` UPDATE was called targeting the most-recent-valid entry. Then insert a new entry (simulating a new fetch) and confirm the original row still exists — only one INSERT, no DELETE.

- [x] T012 [US2] Write case-linking and audit-retention unit tests in `tests/backend/data-sources/cache.test.js` — test: `case_id` is passed through to `_store` on cache miss (scenario 8); test: `_linkToCase` is called on cache hit when hit row has `case_id = null` and `caseId` is provided (scenario 9); test: two sequential misses produce two INSERT calls and zero DELETE calls — confirm entry count is additive (scenario 10)

**Checkpoint**: US2 complete. Audit trail and case-linking behaviour verified independently.

---

## Phase 5: User Story 3 — Per-Provider Freshness Configuration (Priority: P3)

**Goal**: Each provider has its own TTL. Expired entries trigger a fresh fetch. Unrecognised providers fall back to 24h default.

**Independent Test**: Construct `DataSourceCache` with `{ ttlHours: { 'test-provider': 1 } }`. Mock `_lookup` to return null (simulating expired — entry exists but `expires_at` is in the past). Verify `fetchFn` is called and `_store` is called with `ttlHours = 1`. For an unknown provider, verify `_store` is called with `ttlHours = 24`.

- [x] T013 [US3] Write TTL expiry and per-provider freshness unit tests in `tests/backend/data-sources/cache.test.js` — test: entry with `expires_at` in past returns no rows from `_lookup`, causing a miss and a new fetch (scenario 3); test: provider configured with 1h TTL calls `_store` with `ttlHours = 1` (scenario 3 variant); test: provider with 24h window: mock returns a valid row at 12h age, verify `fetchFn` NOT called; test: unrecognised provider name calls `_store` with `defaultTTLHours = 24` (scenario 11)

**Checkpoint**: US3 complete. Per-provider TTL behaviour verified independently.

---

## Phase 6: User Story 4 — Forced Refresh (Priority: P4)

**Goal**: Callers can bypass cache with `bypassCache: true`, forcing a fresh fetch. The previous entry is preserved alongside the new entry.

**Independent Test**: Mock a valid cache hit. Call `getOrFetch` with `bypassCache: true`. Verify `fetchFn` IS called despite the hit, a new `_store` INSERT is issued, and the mock shows two entries (two INSERTs, zero DELETEs). Verify `withCache` forwards `options.bypassCache` correctly.

- [x] T014 [US4] Write bypass cache unit tests in `tests/backend/data-sources/cache.test.js` — test: `bypassCache: true` skips `_lookup` and always calls `fetchFn` even when a valid entry exists (scenario 4); test: bypass still calls `_store` (new entry created); test: previous entry not deleted (no DELETE call in mocks)
- [x] T015 [P] [US4] Write `withCache` bypass forwarding test in `tests/backend/data-sources/cached-provider.test.js` — verify `options.bypassCache = true` is forwarded to `cache.getOrFetch` and not silently dropped (scenario 3)

**Checkpoint**: US4 complete. Forced refresh verified — no audit entries deleted.

---

## Phase 7: User Story 5 — Cache Performance Monitoring (Priority: P5)

**Goal**: `getMetrics()` returns accurate hit count, miss count, and hit rate. `resetMetrics()` zeroes the counters. Errors from `fetchFn` propagate to the caller with no fallback.

**Independent Test**: Call `getOrFetch` three times — first two result in misses, third is a hit. Call `getMetrics()` and verify `{ hits: 1, misses: 2, hitRate: 0.333... }`. Call `resetMetrics()` and verify `{ hits: 0, misses: 0, hitRate: 0 }`.

- [x] T016 [US5] Implement `DataSourceCache.getMetrics()` and `DataSourceCache.resetMetrics()` in `backend/src/data-sources/cache.js` — `getMetrics` returns `{ hits: this._hits, misses: this._misses, hitRate: total > 0 ? this._hits / total : 0 }`; `resetMetrics` sets `this._hits = 0; this._misses = 0`
- [x] T017 [P] [US5] Write metrics and error-propagation unit tests in `tests/backend/data-sources/cache.test.js` — test: hit/miss counts accurate after a known sequence of hits and misses (scenario 7); test: `resetMetrics` returns counts to zero (scenario 7b); test: `fetchFn` throwing propagates the error directly — no stale fallback returned, `_misses` incremented (scenario 12)

**Checkpoint**: US5 complete. All 5 user stories implemented and independently testable.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Hash correctness tests, full suite validation, and `module.exports` completeness.

- [x] T018 [P] Write hash determinism and uniqueness unit tests in `tests/backend/data-sources/cache.test.js` — test: same `(provider, method, queryParams)` inputs always produce the same 64-char hex hash (scenario 5); test: different inputs produce different hashes (scenario 6)
- [x] T019 Add `module.exports = { DataSourceCache }` at the end of `backend/src/data-sources/cache.js` and `module.exports = { withCache, withCacheScreening }` at the end of `backend/src/data-sources/cached-provider.js`
- [x] T020 Run `cd backend && npm test` and confirm all tests in `tests/backend/data-sources/cache.test.js` and `tests/backend/data-sources/cached-provider.test.js` pass with no failures

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (T001 config update confirms provider names) — **BLOCKS all user story phases**
- **US1 (Phase 3)**: Depends on Phase 2 completion — first deliverable/MVP
- **US2 (Phase 4)**: Depends on Phase 2 (uses `_linkToCase` from foundational) — tests only, no new implementation
- **US3 (Phase 5)**: Depends on Phase 2 (uses `_store` TTL from foundational) — tests only, no new implementation
- **US4 (Phase 6)**: Depends on Phase 3 (tests the `bypassCache` path in `getOrFetch`) — tests only, no new implementation
- **US5 (Phase 7)**: Depends on Phase 2 (new methods added to existing class)
- **Polish (Phase 8)**: Depends on all user story phases

### User Story Dependencies

- **US1 (P1)**: Depends on Foundational only — **no dependencies on other stories**
- **US2 (P2)**: Depends on Foundational only — **no dependencies on US1** (tests directly against mocked `_linkToCase`)
- **US3 (P3)**: Depends on Foundational only — **no dependencies on US1** (tests mock `_lookup` directly)
- **US4 (P4)**: Depends on US1 (Phase 3) — tests the `bypassCache` path in `getOrFetch` which is implemented in T007
- **US5 (P5)**: Depends on Foundational only — `getMetrics`/`resetMetrics` are added directly to the class

### Within Each User Story

- Foundational private helpers before `getOrFetch` implementation (T002–T006 before T007)
- Implementation tasks before corresponding test tasks (T007 before T010; T016 before T017)
- Both wrapper functions (T008, T009) can be written in parallel
- Test files for cache and cached-provider can be written in parallel within each phase

### Parallel Opportunities

- **T003, T004, T005** (Foundational): All modify different logical sections of `cache.js` but the same file — parallel only if each developer works on a different method
- **T008, T009** (US1 wrappers): Different logical sections of `cached-provider.js` — parallel
- **T010, T011** (US1 tests): Different test files — parallel
- **T014, T015** (US4 tests): Different test files — parallel
- **T016, T017** (US5): Different concerns (impl vs tests) — T016 must complete before T017
- **T018, T019** (Polish): Different files — parallel

---

## Parallel Example: US1

```
# Write both test files simultaneously (different files):
Task T010: cache miss/hit tests → tests/backend/data-sources/cache.test.js
Task T011: withCache/withCacheScreening tests → tests/backend/data-sources/cached-provider.test.js

# Write both wrappers simultaneously (same file, different functions):
Task T008: withCache → backend/src/data-sources/cached-provider.js
Task T009: withCacheScreening → backend/src/data-sources/cached-provider.js
```

---

## Implementation Strategy

### MVP First (US1 Only)

1. Complete Phase 1: Setup (T001 — 5 min)
2. Complete Phase 2: Foundational (T002–T006 — implement private helpers)
3. Complete Phase 3: US1 (T007–T011 — `getOrFetch` + both wrappers + tests)
4. **STOP and VALIDATE**: Run `cd backend && npm test -- --testPathPattern data-sources`
5. US1 delivers: transparent cache hit/miss, both provider wrappers — fully functional MVP

### Incremental Delivery

1. Setup + Foundational → private helpers ready
2. US1 → `getOrFetch` + wrappers + tests → **deployable MVP**
3. US2 → case-linking tests confirm audit trail → compliance-ready
4. US3 → TTL expiry tests confirm provider freshness windows work → operations-ready
5. US4 → bypass tests confirm forced refresh → analyst workflow complete
6. US5 → metrics + error propagation tests → observability complete
7. Polish → hash tests, exports, full suite pass

### Single Developer Path (Recommended Order)

T001 → T002 → T003 → T004 → T005 → T006 → T007 → T008 → T009 → T010 → T011 → T012 → T013 → T014 → T015 → T016 → T017 → T018 → T019 → T020

---

## Notes

- `[P]` tasks are in different files or logically independent sections — safe to parallelise
- `[Story]` label maps each task to its user story for independent validation
- **No DB migration required** — `data_source_cache` table already exists in `backend/db/init.sql`
- **Mock pattern for DB tests**: `jest.mock('../../../backend/db/connection')` then `const { query } = require('../../../backend/db/connection'); query.mockResolvedValue({ rows: [...] })`
- All test files must set `'use strict'` at the top and use `describe`/`it` (or `test`) blocks matching the project's existing test style (see `tests/backend/data-sources/registry-factory.test.js`)
- Commit after each phase checkpoint for clean rollback points
