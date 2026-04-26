# Tasks: LLM Call Logging for Audit Trail

**Input**: Design documents from `/specs/009-llm-call-logging/`  
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files or no shared dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Exact file paths are included in every task description

## Path Conventions

Web app layout — all source changes are in `backend/`:

```
backend/src/llm/llm-service.js       ← sole implementation file
tests/backend/llm/llm-service.test.js ← sole test file
config/llm.yaml                       ← config addition
```

---

## Phase 1: Setup (Config)

**Purpose**: Add logging configuration entry that all user stories depend on.

- [x] T001 Add `logging:` section with `redact_prompts: false` and `redact_responses: false` under the top-level keys in `config/llm.yaml`

**Checkpoint**: Config file contains the logging block. `LLMService` can now read `config.logging` without errors.

---

## Phase 2: Foundational (New Method Infrastructure)

**Purpose**: Core additions to `LLMService` that all four user stories depend on. No user story implementation can begin until this phase is complete.

**⚠️ CRITICAL**: These three tasks create the building blocks used by every subsequent phase.

- [x] T002 Read `config.logging ?? null` into `this._redactionConfig` in the `LLMService` constructor in `backend/src/llm/llm-service.js`
- [x] T003 [P] Add `_redactIfNeeded(data)` instance method to `LLMService` in `backend/src/llm/llm-service.js` — checks `this._redactionConfig`; if `redact_prompts` is true, replaces each message's `content` with `'[REDACTED]'` while preserving `role`; if `redact_responses` is true, replaces `content` and truthy `structured` with `'[REDACTED]'`; always preserves `usage` and `latencyMs`; returns input unchanged when `this._redactionConfig` is null
- [x] T004 [P] Add `_logFailedCall(request, context, attempt, provider, model, taskType, errorMessage)` instance method to `LLMService` in `backend/src/llm/llm-service.js` — guards on `this._eventStore && context?.caseId`; builds payload with `status: 'failed'`, `provider`, `model`, `taskType`, `attempt`, `error: errorMessage`, and `request` (messages, temperature, maxTokens); calls `this._eventStore.appendEvent(...)`; wraps the entire call in try/catch that emits `console.error` on failure (fail-open — must never throw)

**Checkpoint**: `LLMService` constructor accepts `config.logging`; `_redactIfNeeded()` and `_logFailedCall()` methods exist and are callable.

---

## Phase 3: User Story 1 — Automatic LLM Call Recording (Priority: P1) 🎯 MVP

**Goal**: Every successful and failed `LLMService.complete()` call with a valid `caseId` writes a complete, correctly-shaped `llm_call` event. Each failed provider attempt (primary failure and each fallback failure) produces its own discrete event.

**Independent Test**: Call `LLMService.complete()` with a mock event store; verify `appendEvent` is called once with `status: 'success'` and the correct payload shape. Then mock the provider to fail all retries and verify `appendEvent` is called with `status: 'failed'`. Then configure primary to fail and fallback to also fail; verify `appendEvent` is called twice — once per provider.

### Implementation for User Story 1

- [x] T005 [US1] Add `status: 'success'` to the payload object inside `_logCall()` in `backend/src/llm/llm-service.js`
- [x] T006 [US1] Add `originalProvider` field to the `_logCall()` payload in `backend/src/llm/llm-service.js`: when the `fallbackProvider` parameter is present, set `originalProvider: this._defaultProviderName`; when absent, omit the field entirely (do not set to null)
- [x] T007 [US1] Call `this._logFailedCall(request, context, attempt, provider.name, adaptedRequest.model, request.taskType, lastError?.message)` immediately before the `nonRetryable` throw in `complete()` in `backend/src/llm/llm-service.js` — capture `provider` from `_resolveProviderAndModel` at the top of `complete()` so it is in scope
- [x] T008 [US1] Call `this._logFailedCall(request, context, maxAttempts, provider.name, adaptedRequest.model, request.taskType, lastError?.message)` immediately before the all-retries-exhausted `LLM_CALL_FAILED` throw (point 9 in `complete()`) in `backend/src/llm/llm-service.js`

### Tests for User Story 1

- [x] T009 [P] [US1] Add test T-LOG-01 to `describe('US4 — Full Audit Logging', ...)` in `tests/backend/llm/llm-service.test.js`: successful call payload includes `status: 'success'`
- [x] T010 [P] [US1] Add test T-LOG-02 to `tests/backend/llm/llm-service.test.js`: provider failing all retries writes an `llm_call` event with `status: 'failed'` and an `error` string field before throwing `LLM_CALL_FAILED`
- [x] T011 [P] [US1] Add test T-LOG-03 to `tests/backend/llm/llm-service.test.js`: non-retryable 4xx error writes an `llm_call` event with `status: 'failed'` before throwing `LLM_CALL_FAILED`
- [x] T012 [P] [US1] Add test T-LOG-04 to `tests/backend/llm/llm-service.test.js`: when primary fails and fallback succeeds, the logged payload has `provider` equal to the fallback provider name and `originalProvider` equal to the default provider name
- [x] T013 [P] [US1] Add test T-LOG-05 to `tests/backend/llm/llm-service.test.js`: when no fallback is involved, the logged payload does not contain an `originalProvider` field
- [x] T026 [P] [US1] Add test T-LOG-11 to `tests/backend/llm/llm-service.test.js`: when primary provider fails and fallback provider also fails, verify `appendEvent` is called exactly twice — once with primary provider name and once with fallback provider name, both with `status: 'failed'`; verifies per-attempt event semantics from FR-001

**Checkpoint**: `llm_call` events are written for all successful calls and for every individual failed provider attempt (primary + each fallback). Run `cd backend && npx jest tests/backend/llm/llm-service.test.js` — all US1 tests pass.

---

## Phase 4: User Story 2 — Resilient Logging That Never Blocks Decisions (Priority: P2)

**Goal**: A logging failure — whether on a successful or failed call — never prevents the LLM response (or LLM error) from reaching the caller. Logging is also silently skipped when no `caseId` is present or no event store is configured.

**Independent Test**: Mock `appendEvent` to throw; call `LLMService.complete()` on both a succeeding and a failing provider; verify the LLM response / error still propagates correctly and a `console.error` is emitted. Separately verify that calling with no `caseId` or no event store produces no call to `appendEvent` and no error.

### Implementation for User Story 2

- [x] T014 [US2] Inside `_tryFallback()` in `backend/src/llm/llm-service.js`, in the existing `catch` block that silently `continue`s on fallback provider failure: before the `continue`, call `this._logFailedCall(request, context, 1, name, model, request.taskType, err?.message)` so failed fallback attempts are also recorded

### Tests for User Story 2

- [x] T015 [P] [US2] Add test T-LOG-10 to `tests/backend/llm/llm-service.test.js`: mock `appendEvent` to throw; call `LLMService.complete()` on a succeeding provider; verify the LLM response is still returned and `console.error` was called
- [x] T016 [P] [US2] Add test to `tests/backend/llm/llm-service.test.js`: mock `appendEvent` to throw on a failing call; verify the original `LLM_CALL_FAILED` error is thrown (not swallowed) and `console.error` was called
- [x] T027 [P] [US2] Add test T-LOG-12 to `tests/backend/llm/llm-service.test.js`: construct `LLMService` with a valid event store but call `complete()` with `context = {}` (no `caseId`); verify `appendEvent` is never called and the LLM response is returned normally — covers FR-005
- [x] T028 [P] [US2] Add test T-LOG-13 to `tests/backend/llm/llm-service.test.js`: construct `LLMService` without an event store (event store dependency absent/null); call `complete()` with a valid `caseId` in context; verify no error is thrown and the LLM response is returned normally — covers FR-006

**Checkpoint**: Logging failures on both success and failure paths are swallowed; original results always propagate. Logging is silently skipped for missing `caseId` and missing event store. Run `cd backend && npx jest tests/backend/llm/llm-service.test.js`.

---

## Phase 5: User Story 3 — Retry Attempt Tracking (Priority: P2)

**Goal**: The `attempt` field in logged events correctly reflects the retry attempt number, enabling operational diagnosis of retry patterns.

**Independent Test**: Configure a provider to fail once then succeed; verify the logged event has `attempt: 2`. No implementation change is required — this phase is test coverage only.

### Tests for User Story 3

- [x] T017 [P] [US3] Add test T-LOG-06 to `tests/backend/llm/llm-service.test.js`: provider fails on attempt 1 (retryable error), succeeds on attempt 2; verify `appendEvent` is called once with `attempt: 2`
- [x] T018 [P] [US3] Add test to `tests/backend/llm/llm-service.test.js`: provider configured with `max_attempts: 3` fails all 3 attempts; verify the `status: 'failed'` event logged before throw has `attempt: 3`

**Checkpoint**: Attempt numbers are verified by tests for both success and failure paths. Run `cd backend && npx jest tests/backend/llm/llm-service.test.js`.

---

## Phase 6: User Story 4 — Sensitive Data Redaction (Priority: P3)

**Goal**: When redaction is enabled via `config/llm.yaml`, prompt content and/or response content is replaced with `'[REDACTED]'` before writing to the event store; metadata is always preserved.

**Independent Test**: Construct `LLMService` with `config.logging = { redact_prompts: true, redact_responses: true }`; make a call; verify logged messages have `content: '[REDACTED]'` with `role` intact, response has `content: '[REDACTED]'`, and `usage`/`latencyMs` are unchanged.

### Implementation for User Story 4

- [x] T019 [US4] In `_logCall()` in `backend/src/llm/llm-service.js`, wrap the `request` object passed to the payload with `this._redactIfNeeded(...)` before the `appendEvent` call
- [x] T020 [US4] In `_logCall()` in `backend/src/llm/llm-service.js`, wrap the `response` object passed to the payload with `this._redactIfNeeded(...)` before the `appendEvent` call

### Tests for User Story 4

- [x] T021 [P] [US4] Add test T-LOG-07 to `tests/backend/llm/llm-service.test.js`: service constructed with `config.logging = { redact_prompts: true }`; logged request messages have `content: '[REDACTED]'`; `role` fields are preserved
- [x] T022 [P] [US4] Add test T-LOG-08 to `tests/backend/llm/llm-service.test.js`: service constructed with `config.logging = { redact_responses: true }`; logged response has `content: '[REDACTED]'`; `usage` and `latencyMs` are unchanged
- [x] T023 [P] [US4] Add test T-LOG-09 to `tests/backend/llm/llm-service.test.js`: service constructed with no `config.logging` (null); logged messages and response content are stored verbatim

**Checkpoint**: Redaction works for prompts, responses, both, or neither based solely on config. Run `cd backend && npx jest tests/backend/llm/llm-service.test.js`.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation, architectural verification, and documentation.

- [x] T024 Run full backend test suite to confirm no regressions: `cd backend && npm test`
- [x] T029 Verify FR-003 (agents MUST NOT call logging functions directly): run `grep -r "_logCall\|_logFailedCall" backend/src/agents/ backend/src/workers/ backend/src/data-sources/ backend/src/services/` — confirm zero matches; if any found, investigate and remove the direct call (logging must remain internal to `LLMService`)
- [x] T025 [P] Update `specs/009-llm-call-logging/checklists/requirements.md` — mark any items that required post-implementation review and confirm all acceptance criteria are met; note that FR-009 RBAC enforcement (`compliance_officer`/`admin` only) is out of scope for this layer and must be tracked in the API layer (Layer 5) implementation

---

## Out of Scope (This Tasks List)

- **FR-009 RBAC enforcement**: The access policy (restricting `llm_call` reads to `compliance_officer` and `admin`) is implemented in the audit trail API endpoint (Layer 5 — Fastify route handler). Tasks for that enforcement belong in the API feature branch, not here.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 (T001) — blocks US1–US4
- **Phase 3 (US1)**: Depends on Phase 2 complete — T005/T006/T007/T008 before T009–T013, T026
- **Phase 4 (US2)**: Depends on Phase 2 complete — T014 before T015/T016/T027/T028
- **Phase 5 (US3)**: Depends on Phase 2 complete — tests only, no prior phase required
- **Phase 6 (US4)**: Depends on Phase 2 complete (T002 + T003 specifically)
- **Phase 7 (Polish)**: Depends on all desired phases complete

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2. Foundational to all other stories (status field, failed logging).
- **US2 (P2)**: Can start after Phase 2. No dependency on US1, but logically tested together.
- **US3 (P2)**: Can start after Phase 2. Test-only phase — no dependency on US1 or US2.
- **US4 (P3)**: Can start after Phase 2 (T002 + T003). No dependency on US1–US3.

### Within Each Phase

- Implementation tasks before test tasks within a story
- All `[P]`-marked test tasks within a story can be written in parallel (different `describe` blocks)
- T007 and T008 both modify `complete()` — write sequentially to avoid conflicts in the same file

### Parallel Opportunities

- T003 and T004 (Phase 2): different methods, independently reviewable
- T009–T013, T026 (US1 tests): all `[P]` — can be written simultaneously as separate `test()` blocks
- T015/T016/T027/T028 (US2 tests): `[P]` — independent test blocks
- T017/T018 (US3 tests): `[P]` — independent test blocks
- T021/T022/T023 (US4 tests): `[P]` — independent test blocks

---

## Implementation Strategy

### Remaining Work (T026–T029)

All previously completed tasks (T001–T025) are done. Four tasks remain:

1. **T026** [US1]: Per-attempt event test — primary + fallback both fail → 2 events
2. **T027** [US2]: No `caseId` skip test (FR-005)
3. **T028** [US2]: No event store skip test (FR-006)
4. **T029** (Polish): FR-003 static grep check

Run order: T026–T028 in parallel (all test additions to existing file), then T029 (grep check, no file edits).

### Incremental Delivery (Historical)

1. Setup + Foundational → Infrastructure ready (T001–T004) ✅
2. US1 → Correct event shape for all call outcomes → **MVP complete** ✅
3. US2 → Verified fail-open for failed-call logging path ✅
4. US3 → Verified attempt-number accuracy ✅
5. US4 → Redaction support enabled for sensitive deployments ✅
6. Polish → Full regression pass ✅
7. **Gap closure** → Per-attempt test, FR-005/FR-006 tests, FR-003 static check (T026–T029)

---

## Notes

- All 29 tasks modify at most 3 source files: `backend/src/llm/llm-service.js`, `tests/backend/llm/llm-service.test.js`, `config/llm.yaml`
- No new source files are created — this feature is entirely additive to existing files
- `[P]` test tasks share the same test file but write independent `test()` blocks — no conflict
- T007 and T008 both edit `complete()` — handle sequentially or in a single editing session
- FR-009 RBAC enforcement is explicitly out of scope; noted in T025 checklist update and plan.md
