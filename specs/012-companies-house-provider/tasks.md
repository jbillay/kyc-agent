# Tasks: UK Corporate Registry Data Source

**Input**: Design documents from `/specs/012-companies-house-provider/`  
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

**Tests**: Included — the spec has explicit acceptance scenarios, plan.md lists test coverage targets, and this is a regulated KYC system where coverage is required.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no incomplete dependencies)
- **[Story]**: Which user story this task belongs to (US1–US6, maps to spec.md)
- Exact file paths in every description

## Path Conventions

- Implementation: `backend/src/data-sources/registry/companies-house.js`
- Unit tests: `tests/backend/data-sources/companies-house.test.js`
- Integration tests: `tests/backend/data-sources/companies-house.integration.test.js`
- Config: `config/data-sources.yaml`

---

## Phase 1: Setup

**Purpose**: Extend configuration to support the new provider parameters resolved during clarification.

- [x] T001 Uncomment the `companies_house` block in `config/data-sources.yaml` and add three new fields: `timeout_ms: 10000`, `max_queue_wait_ms: 30000`, `retry_attempts: 3` alongside the existing `api_key`, `base_url`, `rate_limit`, and `cache_ttl_hours` fields

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure shared by all 6 public methods. No user story can function until this phase is complete.

**⚠️ CRITICAL**: All Phase 3–8 tasks depend on Phase 2 completion.

- [x] T002 Scaffold `CompaniesHouseProvider` class in `backend/src/data-sources/registry/companies-house.js` — constructor sets `this.name = 'companies-house'`, `this.jurisdictions = ['GB']`, and all config properties (`baseUrl`, `apiKey`, `timeoutMs`, `maxQueueWaitMs`); initialise token-bucket state (`_tokens = 600`, `_maxTokens = 600`, `_refillRate = 2`, `_lastRefill = Date.now()`); add `module.exports = { CompaniesHouseProvider }`

- [x] T003 Implement four private mapping helpers in `backend/src/data-sources/registry/companies-house.js`: `_mapStatus(chStatus)` (maps CH status strings to `active/dissolved/liquidation/administration/other`); `_classifyPSCType(kind)` (maps CH PSC kind to `individual/corporate/other`); `_extractOwnershipPercentage(naturesOfControl)` (returns range string `75-100/50-75/25-50` by matching substrings); `_countryToCode(country)` (maps lowercase country name to ISO 3166-1 alpha-2, falls back to input)

- [x] T004 Implement `_acquireToken()` in `backend/src/data-sources/registry/companies-house.js` — refill bucket lazily on each call using elapsed time since `_lastRefill`; if `_tokens < 1`, compute wait as `((1 - _tokens) / _refillRate) * 1000` ms; use `Promise.race()` between the timed wait and a `maxQueueWaitMs` rejection timer that throws `Object.assign(new Error('Rate limit queue wait exceeded'), { code: 'RATE_LIMITED' })`; decrement `_tokens` by 1 before returning

- [x] T005 Implement `_retry(fn, maxAttempts = 3)` in `backend/src/data-sources/registry/companies-house.js` — call `fn()` and, on failure, retry up to `maxAttempts - 1` more times only if `err.code` is NOT `'NOT_FOUND'` or `'RATE_LIMITED'`; delays between attempts: 200ms, 400ms, 800ms (backoff: `200 * 2^(attempt - 1)`); re-throw the final error after all retries exhausted

- [x] T006 Implement `_get(path)` in `backend/src/data-sources/registry/companies-house.js` — call `await this._acquireToken()`; create `AbortController`, set `setTimeout(() => controller.abort(), this.timeoutMs)`; call native `fetch` with `Authorization: 'Basic ' + Buffer.from(this.apiKey + ':').toString('base64')` header and `signal: controller.signal`; wrap the fetch call in `this._retry()`; clear the timeout in `finally`; map 404 → `{ code: 'NOT_FOUND', statusCode: 404 }`, 429 → `{ code: 'RATE_LIMITED', statusCode: 429 }`, other non-ok → generic error with statusCode; return `response.json()`

- [x] T007 [P] Write unit tests for the foundational layer in `tests/backend/data-sources/companies-house.test.js` — use `jest.spyOn(global, 'fetch')` to mock HTTP; write `describe('_acquireToken')` block: verify token consumed on each call, verify wait fires when tokens exhausted, verify RATE_LIMITED thrown when queue wait exceeds maxQueueWaitMs; write `describe('_retry')` block: verify 3 attempts on 5xx, verify exponential delays (200/400/800ms) using `jest.useFakeTimers`, verify no retry on 404 (NOT_FOUND) or 429 (RATE_LIMITED), verify success on 3rd attempt; write `describe('_get timeout')` block: verify AbortController fires after timeoutMs and error propagates

**Checkpoint**: `_get()` can make authenticated, rate-limited, retrying, timed-out HTTP requests. All 6 public methods can now be implemented.

---

## Phase 3: User Story 1 — Search UK Companies by Name (Priority: P1) 🎯 MVP

**Goal**: KYC agents can search for UK companies by name and receive ranked results with company number, status, and incorporation date.

**Independent Test**: Submit `searchEntity({ name: 'Barclays' })` and verify results array contains entries with `entityId`, `name`, `status`, `entityType`, `incorporationDate`, `relevanceScore`, and `rawData` fields populated.

- [x] T008 [US1] Implement `searchEntity(query)` in `backend/src/data-sources/registry/companies-house.js` — call `_get('/search/companies?' + new URLSearchParams({ q: query.name, items_per_page: '10' }))`; map each item in `data.items` to `EntitySearchResult` shape per `data-model.md` (entityId = company_number, name = title, jurisdiction = 'GB', status via `_mapStatus`, relevanceScore = 100 if snippet else 80, rawData = item); return `[]` on empty `data.items`

- [x] T009 [P] [US1] Write unit tests for `searchEntity` in `tests/backend/data-sources/companies-house.test.js` — `describe('searchEntity')` block: mock `/search/companies` with 3-item response and verify all `EntitySearchResult` fields are mapped correctly (entityId, name, registrationNumber, jurisdiction='GB', incorporationDate, status, entityType, relevanceScore, rawData); mock with `items: []` and verify empty array returned; mock 429 response and verify `RATE_LIMITED` error propagates

**Checkpoint**: User Story 1 is fully functional and independently testable.

---

## Phase 4: User Story 2 — Retrieve Full Company Profile (Priority: P1)

**Goal**: KYC agents can retrieve a complete company profile (address, SIC codes, previous names, status) by company number.

**Independent Test**: Call `getEntityDetails('01026167')` (Barclays) and verify the response includes a populated `registeredAddress` object, a `sicCodes` array, `previousNames` with `effectiveFrom` and `effectiveTo` fields, and `status`.

- [x] T010 [US2] Implement `getEntityDetails(companyNumber)` in `backend/src/data-sources/registry/companies-house.js` — call `_get('/company/' + companyNumber)`; map response to `EntityDetails` shape per `data-model.md` (all `registeredAddress` subfields with defaults, `sicCodes = data.sic_codes || []`, `previousNames` array mapping `pn.name/effective_from/ceased_on||null`, `status` via `_mapStatus`, `rawData = data`)

- [x] T011 [P] [US2] Write unit tests for `getEntityDetails` in `tests/backend/data-sources/companies-house.test.js` — `describe('getEntityDetails')` block: mock `/company/01026167` with full profile and verify all `EntityDetails` fields including nested `registeredAddress`; mock a company with `previous_company_names` array and verify `previousNames[].effectiveTo` is `null` for open-ended names and a date string for closed names; mock 404 and verify `NOT_FOUND` code; verify `rawData` contains the complete response object

**Checkpoint**: User Story 2 is fully functional and independently testable.

---

## Phase 5: User Story 3 — Retrieve Officers and Directors (Priority: P2)

**Goal**: KYC agents can retrieve all current and resigned officers for a company, with full pagination ensuring no officer is missed.

**Independent Test**: Call `getOfficers` for a company with more than 50 known officers and verify all officers are returned (not just the first 50), each with `role`, `appointedDate`, `nationality`, and `dateOfBirth` in `YYYY-MM` format.

- [x] T012 [US3] Implement `_paginateOfficers(companyNumber)` in `backend/src/data-sources/registry/companies-house.js` — start with `startIndex = 0`, `pageSize = 50`, accumulate items into `allItems = []`; loop: call `_get('/company/' + companyNumber + '/officers?items_per_page=50&start_index=' + startIndex)`; push `page.items` into `allItems`; stop when `allItems.length >= page.total_results` or `page.items.length === 0`; advance `startIndex += pageSize`; return `allItems`

- [x] T013 [US3] Implement `getOfficers(companyNumber)` in `backend/src/data-sources/registry/companies-house.js` — call `_paginateOfficers(companyNumber)`; map each item to `Officer` shape per `data-model.md` (dateOfBirth formatted as `YYYY-MM` from `item.date_of_birth.year` and `item.date_of_birth.month.toString().padStart(2,'0')`; omit `resignedDate` if `item.resigned_on` is absent; rawData = item)

- [x] T014 [P] [US3] Write unit tests for `getOfficers` in `tests/backend/data-sources/companies-house.test.js` — `describe('getOfficers')` block: mock single page (`total_results: 2`, `items: [...]`) and verify Officer[] mapping including DOB formatted as `YYYY-MM`; mock two pages (`total_results: 60`, first page 50 items, second page 10 items) and verify both pages are fetched and combined into a 60-item result; verify resigned officer includes `resignedDate`; verify active officer omits `resignedDate`; mock 404 and verify `NOT_FOUND` propagates

**Checkpoint**: User Story 3 is fully functional and independently testable.

---

## Phase 6: User Story 4 — Retrieve Persons with Significant Control (Priority: P2)

**Goal**: KYC agents can retrieve all PSC entries for a company to identify UBOs and beneficial controllers, with correct type classification and ownership range extraction.

**Independent Test**: Call `getShareholders` for a company with known PSC entries and verify at least one `Shareholder` is returned with `name`, `type` (`individual` or `corporate`), `ownershipPercentage` (a range string), `naturesOfControl` array, and `rawData`.

- [x] T015 [US4] Implement `getShareholders(companyNumber)` in `backend/src/data-sources/registry/companies-house.js` — call `_get('/company/' + companyNumber + '/persons-with-significant-control')`; map each item in `data.items` to `Shareholder` shape per `data-model.md` (name from `item.name` if truthy, else construct from `item.name_elements.forename + ' ' + item.name_elements.surname`; type via `_classifyPSCType(item.kind)`; ownershipPercentage via `_extractOwnershipPercentage(item.natures_of_control)`; ceasedDate omitted if absent; corporate fields `registrationNumber` and `jurisdiction` via `_countryToCode` when `item.identification` is present; rawData = item); return `[]` on absent `data.items`

- [x] T016 [P] [US4] Write unit tests for `getShareholders` in `tests/backend/data-sources/companies-house.test.js` — `describe('getShareholders')` block: mock individual PSC with `name_elements` and verify name is constructed as `forename + ' ' + surname`; mock corporate PSC with `identification` block and verify `registrationNumber` and `jurisdiction` are set; verify `_extractOwnershipPercentage` maps `ownership-of-shares-75-to-100-percent` → `'75-100'`, `50-to-75` → `'50-75'`, `25-to-50` → `'25-50'`; verify `_classifyPSCType` returns `individual` for `individual-person`, `corporate` for `corporate-entity`, `other` for unknown kind; mock empty `items` array and verify `[]` returned

**Checkpoint**: User Story 4 is fully functional and independently testable.

---

## Phase 7: User Story 5 — Entity Status and Compliance Flags (Priority: P2)

**Goal**: KYC agents can retrieve a company's current operational status plus active compliance notices (insolvency history, liquidation, overdue filings) to determine risk posture.

**Independent Test**: Call `getEntityStatus` for a company known to have insolvency history and verify the response includes `status`, `accountsOverdue`, `annualReturnOverdue`, and `activeNotices` containing `'insolvency-history'`.

- [x] T017 [US5] Implement `getEntityStatus(companyNumber)` in `backend/src/data-sources/registry/companies-house.js` — call `_get('/company/' + companyNumber)`; build `notices = []` array: push `'previously-liquidated'` if `data.has_been_liquidated`, push `'insolvency-history'` if `data.has_insolvency_history`, push `data.company_status_detail` if status is `'active'` and detail is set; map to `EntityStatus` shape (status via `_mapStatus`, dissolvedDate = `data.date_of_cessation || undefined`, accountsOverdue = `data.accounts?.overdue === true`, annualReturnOverdue = `data.annual_return?.overdue === true || data.confirmation_statement?.overdue === true`, activeNotices = notices, rawData = data)

- [x] T018 [P] [US5] Write unit tests for `getEntityStatus` in `tests/backend/data-sources/companies-house.test.js` — `describe('getEntityStatus')` block: mock response with `accounts: { overdue: true }` and verify `accountsOverdue: true`; mock with `confirmation_statement: { overdue: true }` (no annual_return field) and verify `annualReturnOverdue: true`; mock with `has_been_liquidated: true` and verify `'previously-liquidated'` in `activeNotices`; mock with `has_insolvency_history: true` and verify `'insolvency-history'` in `activeNotices`; mock active company with `company_status_detail: 'first-gazette'` and verify it appears in `activeNotices`; mock 404 and verify `NOT_FOUND` propagates

**Checkpoint**: User Story 5 is fully functional and independently testable.

---

## Phase 8: User Story 6 — Retrieve Filing History (Priority: P3)

**Goal**: KYC agents can retrieve up to 25 recent company filings with type, description, date, and category for due diligence documentation.

**Independent Test**: Call `getFilingHistory` for a known company and verify an array of `Filing` objects is returned, each with `filingType`, `description`, `date`, and `rawData`. Verify `description` falls back to `filingType` when no description field is present in the registry response.

- [x] T019 [US6] Implement `getFilingHistory(companyNumber)` in `backend/src/data-sources/registry/companies-house.js` — call `_get('/company/' + companyNumber + '/filing-history?items_per_page=25')`; map each item in `data.items` to `Filing` shape (filingType = `item.type`, description = `item.description || item.type`, date = `item.date`, category = `item.category || undefined`, rawData = item); return `[]` on absent `data.items`

- [x] T020 [P] [US6] Write unit tests for `getFilingHistory` in `tests/backend/data-sources/companies-house.test.js` — `describe('getFilingHistory')` block: mock 3-item response and verify all `Filing` fields (filingType, description, date, category, rawData); mock an item with no `description` field and verify `description` equals `filingType`; mock empty `items` and verify `[]` returned

**Checkpoint**: All 6 user stories are fully functional and independently testable.

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Integration validation, integration test scaffold, and developer experience.

- [x] T021 [P] Create `tests/backend/data-sources/companies-house.integration.test.js` — all tests in this file MUST skip when `process.env.COMPANIES_HOUSE_API_KEY` is absent (use `beforeAll(() => { if (!process.env.COMPANIES_HOUSE_API_KEY) { return; } })`); write 4 integration tests against the live registry: `searchEntity({ name: 'Barclays' })` verifies results include an entry with name matching `/barclays/i`; `getEntityDetails('01026167')` verifies `status === 'active'` and `registeredAddress.country` is set; `getOfficers('01026167')` verifies array length > 0 and first entry has `role` and `appointedDate`; `getShareholders('01026167')` verifies response is an array (may be empty for listed companies — no error thrown)

- [x] T022 Validate `CompaniesHouseProvider` satisfies the `RegistryFactory` contract by adding a `describe('RegistryFactory registration')` block to `tests/backend/data-sources/companies-house.test.js` — import `RegistryFactory` from `backend/src/data-sources/registry-factory.js`, instantiate `new CompaniesHouseProvider({ apiKey: 'test' })`, call `factory.register(provider)`, and verify `factory.getProvider('GB')` returns the provider without throwing

- [x] T023 [P] Update `specs/012-companies-house-provider/quickstart.md` to reflect the final `config/data-sources.yaml` structure as implemented (confirm `timeout_ms`, `max_queue_wait_ms`, `retry_attempts` fields match exactly what was added in T001)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — **BLOCKS all user story phases**
- **US1 (Phase 3)**: Depends on Phase 2 — can begin in parallel with US2–US6 once Phase 2 complete
- **US2 (Phase 4)**: Depends on Phase 2 — can begin in parallel with US1, US3–US6
- **US3 (Phase 5)**: Depends on Phase 2 — can begin in parallel with US1–US2, US4–US6
- **US4 (Phase 6)**: Depends on Phase 2 — can begin in parallel with US1–US3, US5–US6
- **US5 (Phase 7)**: Depends on Phase 2 — can begin in parallel with US1–US4, US6
- **US6 (Phase 8)**: Depends on Phase 2 — can begin in parallel with US1–US5
- **Polish (Phase 9)**: Depends on all desired user stories being complete

### User Story Dependencies

All user stories are fully independent of each other — each implements a distinct method in the same class. The only shared dependency is the foundational `_get()` infrastructure (Phase 2).

### Within Each User Story

- Implementation task before test task (tests verify the implemented behaviour)
- Exception: T007 (foundational tests) can be written before or alongside T002–T006

### Parallel Opportunities per Phase

**Phase 2 (Foundational)**:
- T002 → T003 (helpers, after scaffold) → T004 + T005 (can overlap; different state) → T006 (after T004+T005)
- T007 (test file) can be written in parallel with T002–T006

**Phases 3–8 (User Stories, after Phase 2)**:
- All phases (3–8) can be started in parallel by different developers
- Within each phase: implementation task first, test task in parallel or after

---

## Parallel Example: Phase 2 + US1

```
# After Phase 1 completes:

# Phase 2 — sequential in implementation file, test file in parallel:
T002 → T003 → T004 → T005 → T006   (companies-house.js)
T007                                 (companies-house.test.js — write in parallel)

# After Phase 2 completes — all US phases can start simultaneously:
T008 + T009   (US1: searchEntity impl + test)
T010 + T011   (US2: getEntityDetails impl + test)
T012 → T013 + T014   (US3: officers — paginator, then getOfficers + test)
T015 + T016   (US4: getShareholders impl + test)
T017 + T018   (US5: getEntityStatus impl + test)
T019 + T020   (US6: getFilingHistory impl + test)
```

---

## Implementation Strategy

### MVP First (User Stories 1 & 2 Only)

1. Complete Phase 1: Config update (T001)
2. Complete Phase 2: Foundational infrastructure (T002–T007)
3. Complete Phase 3: searchEntity (T008–T009)
4. Complete Phase 4: getEntityDetails (T010–T011)
5. **STOP and VALIDATE**: Register provider with RegistryFactory, run tests for US1+US2
6. Entity Resolution Agent can now query UK company names and profiles — MVP delivered

### Full Delivery

1. Setup + Foundational → Foundation ready
2. US1 + US2 → Search and profiles working → MVP
3. US3 + US4 + US5 → Officers, PSC, entity status → PEP screening and UBO identification enabled
4. US6 → Filing history → Due diligence documentation complete
5. Polish (T021–T023) → Integration tests, contract validation, docs

---

## Notes

- All 6 public methods write to the same file (`companies-house.js`); implementation tasks are sequential within that file
- Test tasks marked [P] are parallel with their corresponding implementation tasks (different file: `companies-house.test.js`)
- The `rawData` field is required on every response shape — do not omit it (Constitution Principle I: Auditability)
- No new npm packages may be added (research decision 1)
- Integration tests (T021) run without the live API key in CI — they self-skip via env var check
