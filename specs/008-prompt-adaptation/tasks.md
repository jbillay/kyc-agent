# Tasks: Prompt Adaptation System

**Input**: Design documents from `/specs/008-prompt-adaptation/`  
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

**Tests**: Included — unit tests are explicitly required in the feature specification acceptance criteria.

**Organization**: Tasks grouped by user story. All changes are in `backend/src/llm/`; no new files created.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete task dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Tests use TDD: write failing test first, then implement, then verify

## Path Conventions

Web application layout. All source changes are backend-only.

---

## Phase 1: Setup (Baseline Verification)

**Purpose**: Confirm existing tests all pass before any modifications.

- [x] T001 Confirm test baseline passes — run `cd backend && npx jest ../tests/backend/llm/prompt-adapters/adapters.test.js` and verify all 17 existing tests pass with no failures

---

## Phase 2: Foundational (Blocking Prerequisites)

No foundational prerequisites — all files exist and no shared base needs to be created before user story work begins. Proceed directly to Phase 3.

---

## Phase 3: User Story 1 — Write Once, Run Anywhere (Priority: P1) 🎯 MVP

**Goal**: Standard messages are automatically formatted for Mistral and Llama model families. Two implementation gaps must be closed: LlamaAdapter must prepend a default system message when none is present; MistralAdapter must produce a valid user message when only system messages are provided.

**Independent Test**: Configure Mistral and Llama backends in LLMService, send a system + user message pair, and verify both receive valid, non-empty formatted output without any agent-side changes.

### Tests for User Story 1 ⚠️ Write first — must FAIL before implementation

- [x] T002 [US1] Add failing test: LlamaAdapter.formatMessages — messages array with no system role receives `{ role: 'system', content: 'You are a helpful assistant.' }` prepended in `tests/backend/llm/prompt-adapters/adapters.test.js`
- [x] T003 [US1] Add failing test: MistralAdapter.formatMessages — messages array containing only system roles (no user message) produces exactly one user message whose content contains the accumulated system text in `tests/backend/llm/prompt-adapters/adapters.test.js`

### Implementation for User Story 1

- [x] T004 [US1] Fix `LlamaAdapter.formatMessages` in `backend/src/llm/prompt-adapters/llama.js`: check `messages.some(m => m.role === 'system')`; if false, return `[{ role: 'system', content: 'You are a helpful assistant.' }, ...messages]`; otherwise return messages unchanged
- [x] T005 [US1] Fix `MistralAdapter.formatMessages` in `backend/src/llm/prompt-adapters/mistral.js`: after the loop, if `pendingSystem` is non-null, push `{ role: 'user', content: pendingSystem }` to result before returning
- [x] T006 [US1] Verify US1 tests pass — run `cd backend && npx jest ../tests/backend/llm/prompt-adapters/adapters.test.js` and confirm T002 and T003 tests now pass alongside all pre-existing tests

**Checkpoint**: LlamaAdapter and MistralAdapter format messages correctly for all input shapes. User Story 1 is independently testable.

---

## Phase 4: User Story 2 — Structured Output Instructions Across Models (Priority: P2)

**Goal**: Every adapter's `formatStructuredOutputInstruction` fails immediately with a descriptive error when given a null, undefined, or empty schema, rather than silently generating a broken instruction.

**Independent Test**: Call `formatStructuredOutputInstruction(null)`, `formatStructuredOutputInstruction(undefined)`, and `formatStructuredOutputInstruction({})` on each of the three adapter classes and confirm each throws `Error("schema is required")`.

### Tests for User Story 2 ⚠️ Write first — must FAIL before implementation

- [x] T007 [US2] Add failing tests for all three adapters: `formatStructuredOutputInstruction(null)` throws, `formatStructuredOutputInstruction(undefined)` throws, and `formatStructuredOutputInstruction({})` throws with message `"schema is required"` in `tests/backend/llm/prompt-adapters/adapters.test.js`

### Implementation for User Story 2

- [x] T008 [P] [US2] Add null/empty schema guard to `DefaultAdapter.formatStructuredOutputInstruction` in `backend/src/llm/prompt-adapters/default.js`: add `if (!schema || (typeof schema === 'object' && Object.keys(schema).length === 0)) throw new Error('schema is required');` before the existing return statement
- [x] T009 [P] [US2] Add null/empty schema guard to `MistralAdapter.formatStructuredOutputInstruction` in `backend/src/llm/prompt-adapters/mistral.js`: same guard as T008
- [x] T010 [P] [US2] Add null/empty schema guard to `LlamaAdapter.formatStructuredOutputInstruction` in `backend/src/llm/prompt-adapters/llama.js`: same guard as T008
- [x] T011 [US2] Verify US2 tests pass — run `cd backend && npx jest ../tests/backend/llm/prompt-adapters/adapters.test.js` and confirm T007 tests now pass alongside all prior tests

**Checkpoint**: All three adapters throw descriptive errors for invalid schemas. User Story 2 independently testable.

---

## Phase 5: User Story 3 — Adapter Selection by Model Name (Priority: P3)

**Goal**: The factory correctly routes `mixtral*` model names to MistralAdapter and handles mixed-case model names correctly via case-insensitive prefix matching.

**Independent Test**: Call `factory.getAdapter('mixtral:8x7b')` and `factory.getAdapter('Mistral-Nemo:12B')` and verify both return a `MistralAdapter` instance; call `factory.getAdapter('LLama3:8b')` and verify it returns a `LlamaAdapter` instance.

### Tests for User Story 3 ⚠️ Write first — must FAIL before implementation

- [x] T012 [US3] Add failing tests for factory: `getAdapter('mixtral:8x7b')` → `MistralAdapter`; `getAdapter('mixtral:8x22b')` → `MistralAdapter`; `getAdapter('Mistral-Nemo:12B')` → `MistralAdapter`; `getAdapter('LLama3:8b')` → `LlamaAdapter`; `getAdapter('mixtral:8x7b')` and `getAdapter('mistral:7b')` return the same instance in `tests/backend/llm/prompt-adapters/adapters.test.js`

### Implementation for User Story 3

- [x] T013 [US3] Fix `PromptAdapterFactory.getAdapter` in `backend/src/llm/prompt-adapter-factory.js`: change line 32 from `if (lower.startsWith('mistral'))` to `if (lower.startsWith('mistral') || lower.startsWith('mixtral'))`
- [x] T014 [US3] Verify US3 tests pass — run `cd backend && npx jest ../tests/backend/llm/prompt-adapters/adapters.test.js` and confirm T012 tests now pass alongside all prior tests

**Checkpoint**: Factory routes all Mistral/Mixtral and Llama variants correctly with case-insensitive matching. User Story 3 independently testable.

---

## Phase 6: User Story 4 — Multi-Turn Conversation Handling (Priority: P4)

**Goal**: Verify explicitly that all adapters correctly handle multi-turn conversations (system + alternating user/assistant exchanges). No new implementation is required — the Phase 3 fixes already cover multi-turn correctness — this phase adds explicit test coverage.

**Independent Test**: Pass a three-turn conversation `[system, user, assistant, user]` through each adapter and assert the output structure is valid: no messages dropped, assistant content unchanged, system content handled per adapter rules.

### Tests for User Story 4 ⚠️ Write first — should PASS after Phase 3 implementation is in place

- [x] T015 [US4] Add tests: `MistralAdapter.formatMessages` with `[system, user, assistant, user]` — system merged into first user only; second user message and assistant message pass through unchanged in `tests/backend/llm/prompt-adapters/adapters.test.js`
- [x] T016 [US4] Add tests: `MistralAdapter.formatMessages` with multiple consecutive system messages before first user — all system content concatenated (separated by newline) and prepended to first user message in `tests/backend/llm/prompt-adapters/adapters.test.js`
- [x] T017 [US4] Add tests: `LlamaAdapter.formatMessages` with `[system, user, assistant, user]` — messages returned unchanged (system present, no modification needed) in `tests/backend/llm/prompt-adapters/adapters.test.js`
- [x] T018 [US4] Verify US4 tests pass — run `cd backend && npx jest ../tests/backend/llm/prompt-adapters/adapters.test.js` and confirm all T015–T017 tests pass

**Checkpoint**: Multi-turn conversation handling is explicitly verified for all adapters. User Story 4 independently testable.

---

## Phase 7: Polish & Cross-Cutting Concerns (FR-011 Debug Logging)

**Purpose**: Add adapter-selection debug logging to `LLMService` per FR-011. This is a cross-cutting concern that does not belong to any single user story.

- [x] T019 Add failing test: `LLMService.complete()` calls the provided logger's `debug` method with `{ adapter, model }` shape after invoking `getAdapter`; add test to `tests/backend/llm/llm-service.test.js` using a mock logger (jest.fn() or spy)
- [x] T020 Extend `LLMService` in `backend/src/llm/llm-service.js`: add optional `logger = null` to the constructor destructuring; store as `this._logger`; after each `getAdapter(model)` call in `complete()` and `_tryFallback()`, add `if (this._logger) this._logger.debug({ adapter: adapter.constructor.name, model }, 'prompt adapter selected');`
- [x] T021 Verify T019 test passes — run `cd backend && npx jest ../tests/backend/llm/llm-service.test.js`
- [x] T022 [P] Run full test suite to confirm no regressions across all test files: `cd backend && npm test`
- [x] T023 [P] Run quickstart smoke test from `specs/008-prompt-adaptation/quickstart.md` to verify adapter selection produces correct output for mistral, mixtral, llama, and default model names

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Baseline)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Skipped — no blocking prerequisites
- **Phase 3 (US1)**: Depends on Phase 1 baseline confirmation
- **Phase 4 (US2)**: Independent of Phase 3 (different methods on different files) — can run in parallel with Phase 3 if staffed
- **Phase 5 (US3)**: Independent of Phases 3 and 4 (different file) — can run in parallel
- **Phase 6 (US4)**: Depends on Phase 3 (implementation must be in place before multi-turn tests can pass)
- **Phase 7 (Polish)**: Depends on all user story phases completing; T020 should come before T022

### User Story Dependencies

- **US1 (P1)**: Start after Phase 1; no story dependencies
- **US2 (P2)**: Can start after Phase 1; independent of US1
- **US3 (P3)**: Can start after Phase 1; independent of US1 and US2
- **US4 (P4)**: Depends on US1 (Phase 3) completing — multi-turn tests rely on Phase 3 fixes
- **Polish (FR-011)**: Depends on all user stories completing

### Within Each Phase

- Write failing tests BEFORE implementation tasks
- Implementation tasks T008/T009/T010 (US2 schema guards) are parallel — different files
- Verify step after each phase before proceeding

### Parallel Opportunities

- T002 + T003 are in the same test file — write sequentially
- T008 + T009 + T010 touch different files — can execute in parallel
- T022 + T023 (final verification) are independent — can run in parallel

---

## Parallel Example: User Story 2 (null schema guards)

```
# After T007 test task completes, launch implementations simultaneously:
Task A: "Add null schema guard to DefaultAdapter in backend/src/llm/prompt-adapters/default.js"
Task B: "Add null schema guard to MistralAdapter in backend/src/llm/prompt-adapters/mistral.js"
Task C: "Add null schema guard to LlamaAdapter in backend/src/llm/prompt-adapters/llama.js"
# Then run T011 verification once all three complete
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. T001 — verify baseline
2. T002–T006 — US1 (LlamaAdapter default system + MistralAdapter system-only flush)
3. **STOP and VALIDATE**: all existing tests still pass + 2 new US1 tests pass
4. Agents using Mistral and Llama models now work correctly with standard message format

### Incremental Delivery

1. Baseline (T001) → Foundation confirmed
2. US1 (T002–T006) → Message formatting correct for all model families
3. US2 (T007–T011) → Null schema errors surfaced cleanly
4. US3 (T012–T014) → Mixtral models route to Mistral adapter
5. US4 (T015–T018) → Multi-turn contracts explicitly verified
6. Polish (T019–T023) → Debug logging active; full suite clean

### Parallel Team Strategy

With two developers after Phase 1 baseline:

- Developer A: Phase 3 (US1) → Phase 6 (US4)
- Developer B: Phase 4 (US2) → Phase 5 (US3) → Phase 7 (Polish)

---

## Notes

- [P] tasks = different files, no pending dependencies — safe to parallelize
- [Story] label maps each task to a specific user story for traceability
- Each user story phase is independently completable and testable
- T008/T009/T010 are the only genuinely parallel implementation tasks in this feature
- Total: 23 tasks across 6 active phases
- No new files, no database changes, no Docker rebuild required
