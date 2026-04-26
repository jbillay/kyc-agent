# Tasks: Data Source Provider Interface and Registry Abstraction

**Input**: Design documents from `/specs/011-provider-interface-registry/`  
**Prerequisites**: plan.md ✅ | spec.md ✅ | research.md ✅ | data-model.md ✅ | contracts/ ✅

**Tests**: Test tasks included for the RegistryFactory (US1) — the only component with runtime logic.  
Type-definition files (`types.js`) are JSDoc only and verified by IDE/editor, not runtime tests.

**Organization**: Tasks grouped by user story in priority order.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to

## Path Conventions

Web application layout: `backend/src/`, `tests/backend/`

---

## Phase 1: Setup

**Purpose**: Ensure the test directory structure matches the project convention before any implementation begins.

- [x] T001 Create `tests/backend/data-sources/` directory to mirror the `tests/backend/llm/` pattern established in the project

**Checkpoint**: Directory exists — implementation can begin.

---

## Phase 3: User Story 1 — Route Data Requests by Jurisdiction (Priority: P1) 🎯 MVP

**Goal**: A working `RegistryFactory` that registers providers, routes by jurisdiction (case-insensitive), warns on duplicate registration, validates the provider contract at registration time, and throws typed errors for unsupported jurisdictions.

**Independent Test**: Register a mock provider for "GB", call `getProvider("GB")` and `getProvider("gb")` — both return the mock. Call `getProvider("XX")` — throws `NO_REGISTRY_PROVIDER`. Register provider covering ["GB","IE"] — both codes resolve. Pass an incomplete object to `register()` — throws `INVALID_PROVIDER`.

### Implementation for User Story 1

- [x] T002 [US1] Implement `RegistryFactory` class in `backend/src/data-sources/registry-factory.js`: `register()` with contract validation (FR-014) and overwrite warning (FR-013), `getProvider()` with typed `NO_REGISTRY_PROVIDER` error, `getSupportedJurisdictions()`; export `{ RegistryFactory }`
- [x] T003 [US1] Write Jest unit tests in `tests/backend/data-sources/registry-factory.test.js` covering: registration and retrieval, case-insensitive lookup ("gb"/"GB"), unknown jurisdiction error, multi-jurisdiction provider (["GB","IE"]), duplicate registration warning, and invalid provider rejection (missing methods/fields)

**Checkpoint**: `npx jest tests/backend/data-sources/registry-factory.test.js` passes — US1 is fully functional and independently verified.

---

## Phase 4: User Story 2 — Query Corporate Registry Data with Consistent Structure (Priority: P2)

**Goal**: All registry domain JSDoc typedefs defined in `registry/types.js` — every IDE autocomplete, field constraint, and `rawData` requirement is captured. The `RegistryProvider` interface contract is formally documented in code.

**Independent Test**: Open `backend/src/data-sources/registry/types.js` in an editor — all 8 typedefs (`RegistryProvider`, `EntitySearchQuery`, `EntitySearchResult`, `EntityDetails`, `Officer`, `Shareholder`, `Filing`, `EntityStatus`) are present with correct field types, required/optional markers, and `rawData: Object` on every response type.

### Implementation for User Story 2

- [x] T004 [US2] Fill `backend/src/data-sources/registry/types.js`: replace the `// TODO: implement` stub with JSDoc `@typedef` blocks for `RegistryProvider` (6 methods + `name` + `jurisdictions`), `EntitySearchQuery`, `EntitySearchResult` (with `rawData`), `EntityDetails` (with `registeredAddress` sub-shape, status enum, `rawData`), `Officer` (with optional `resignedDate`, `dateOfBirth` in YYYY-MM format, `rawData`), `Shareholder` (with `type: 'individual'|'corporate'|'other'`, string `ownershipPercentage`, `rawData`), `Filing` (with `rawData`), `EntityStatus` (with status enum, overdue flags, `activeNotices`, `rawData`); keep `module.exports = {}`

**Checkpoint**: All 8 registry typedefs defined with correct shapes; `rawData` present on all 6 response types; `Shareholder.type` distinguishes individual/corporate.

---

## Phase 5: User Story 3 — Screen Against Sanctions and Watch Lists (Priority: P2)

**Goal**: All screening domain JSDoc typedefs defined in `screening/types.js`. `ScreeningProvider` interface formally documented. US2 and US3 are independent and can proceed in parallel after Phase 1.

**Independent Test**: Open `backend/src/data-sources/screening/types.js` — all 5 typedefs (`ScreeningProvider`, `ScreeningQuery`, `ScreeningHit`, `ListMetadata`, `UpdateResult`) are present; `ScreeningHit.rawData` is present; `ScreeningHit.listEntry` has all sub-fields; `ScreeningHit.matchScore` is typed as `number` (0–100).

### Implementation for User Story 3

- [x] T005 [P] [US3] Fill `backend/src/data-sources/screening/types.js`: replace the `// TODO: implement` stub with JSDoc `@typedef` blocks for `ScreeningProvider` (`name`, `listType: 'sanctions'|'pep'|'adverse_media'`, 3 methods), `ScreeningQuery` (required `name` + `entityType`, optional `dateOfBirth`/`nationality`/`aliases`), `ScreeningHit` (with `matchScore: number`, `matchedFields`, nested `listEntry` sub-shape, `rawData`), `ListMetadata` (5 fields), `UpdateResult` (`updated: boolean`, 4 count/timestamp fields); keep `module.exports = {}`

**Checkpoint**: All 5 screening typedefs defined; `ScreeningHit.rawData` present; `listEntry` sub-shape complete.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Consistency and discoverability improvements across both type modules.

- [x] T006 [P] Add named exports for all error code string constants to `backend/src/data-sources/registry-factory.js` (e.g. `NO_REGISTRY_PROVIDER`, `INVALID_PROVIDER`) so callers can import and use them in switch/catch blocks without magic strings
- [x] T007 [P] Update `backend/src/data-sources/types.js` stub: add JSDoc re-export comments pointing to `registry/types.js` and `screening/types.js` so the top-level module documents where domain types live

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **US1 (Phase 3)**: Depends on Setup (T001) — `RegistryFactory` + tests
- **US2 (Phase 4)**: Depends on Setup only — registry typedefs; independent of US1
- **US3 (Phase 5)**: Depends on Setup only — screening typedefs; independent of US1 and US2
- **Polish (Phase 6)**: Depends on US1 (T002) for T006; T007 can run any time after Setup

### User Story Dependencies

- **US1 (P1)**: Can start after Setup — no dependency on US2 or US3
- **US2 (P2)**: Can start after Setup — no dependency on US1 or US3
- **US3 (P2)**: Can start after Setup — no dependency on US1 or US2; parallelizable with US2

### Parallel Opportunities

- After T001 completes, T002 (US1), T004 (US2), and T005 (US3) can all run simultaneously
- T003 (US1 tests) depends on T002 (factory implementation)
- T006 and T007 (Polish) can run in parallel once T002 is done

---

## Parallel Example: After Setup

```text
# All three story tasks can launch simultaneously after T001:

Task T002 [US1]: Implement RegistryFactory in backend/src/data-sources/registry-factory.js
Task T004 [US2]: Fill registry typedefs in backend/src/data-sources/registry/types.js
Task T005 [US3]: Fill screening typedefs in backend/src/data-sources/screening/types.js
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001)
2. Complete Phase 3: US1 — implement factory (T002) then tests (T003)
3. **STOP and VALIDATE**: `npx jest tests/backend/data-sources/registry-factory.test.js`
4. Factory is functional and tested — downstream registry/screening providers can now register against it

### Incremental Delivery

1. T001 — directory structure ready
2. T002 + T003 — RegistryFactory working and tested (MVP ✅)
3. T004 — registry typedefs complete (US2 ✅)
4. T005 — screening typedefs complete (US3 ✅)
5. T006 + T007 — polish (error code constants, top-level type docs)

### Parallel Team Strategy

With two developers after T001:
- Developer A: T002 → T003 (factory + tests)
- Developer B: T004 + T005 in sequence (type definitions, both files)

---

## Notes

- [P] tasks = different files, no dependencies on incomplete tasks
- [Story] label maps each task to its user story for traceability
- Type definition tasks (T004, T005) have no runtime tests — correctness is verified by IDE type checking and editor autocomplete
- `module.exports = {}` is intentional in types files — typedefs are consumed at compile/edit time, not runtime
- Commit after T003 passes (US1 MVP), then after T004, then after T005
- Error code constants in T006 must match the strings already used in T002's implementation
