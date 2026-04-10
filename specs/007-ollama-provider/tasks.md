# Tasks: Ollama LLM Provider

**Input**: Design documents from `/specs/007-ollama-provider/`  
**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/ ✓, quickstart.md ✓

**Tests**: Included — acceptance criteria in spec.md explicitly require unit tests with mocked HTTP and integration tests against a real Ollama instance.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (no dependencies on incomplete tasks — typically different concerns within the same story)
- **[Story]**: Which user story this task belongs to (US1–US4)

## Path Conventions

Web app layout — `backend/src/` for source, `tests/backend/` for tests (Jest root per `backend/package.json`).

---

## Phase 1: Setup

**Purpose**: Create the test directory structure required by all subsequent test tasks.

- [x] T001 Create directory `tests/backend/llm/providers/` (Jest root is `tests/backend/` per `backend/package.json`)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Update the constructor and add the `_fetch()` helper that every method in the provider depends on. These tasks MUST complete before any user story work begins.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T002 Update `OllamaProvider` constructor in `backend/src/llm/providers/ollama.js` to accept `timeoutMs` (default `120000`) and `requiredModels` (default `[]`) alongside the existing `baseUrl` — support both camelCase and snake_case keys for YAML compatibility
- [x] T003 Implement `_fetch(path, options, timeoutMs)` private helper in `backend/src/llm/providers/ollama.js` — creates an `AbortController`, sets `setTimeout` with the provided or instance `timeoutMs`, passes `signal` to `fetch()`, clears timeout in `finally`, sets `Content-Type: application/json` header

**Checkpoint**: Constructor and `_fetch()` ready — all user story phases can now proceed.

---

## Phase 3: User Story 1 — Chat Completion (Priority: P1) 🎯 MVP

**Goal**: `complete()` sends a chat request to `/api/chat`, returns a valid `LLMResponse` with content and token usage, throws with `statusCode` on HTTP errors, and aborts on timeout.

**Independent Test**: Call `complete({ model: 'llama3.1:8b', messages: [...], taskType: 'extraction' })` against a running Ollama instance — verify response has non-empty `content`, non-zero token counts, `model`, and `provider: 'ollama'`.

### Tests — User Story 1

- [x] T004 [US1] Write unit test `describe('complete()')` in `tests/backend/llm/providers/ollama.test.js` — happy path: mock `fetch` returning valid `/api/chat` response, assert `content`, `usage.promptTokens`, `usage.completionTokens`, `usage.totalTokens`, `model`, `provider: 'ollama'`; confirm `latencyMs` is NOT set by the provider
- [x] T005 [US1] Extend `describe('complete()')` in `tests/backend/llm/providers/ollama.test.js` — error scenarios: (a) mock `fetch` returning HTTP 503 → assert thrown error has `statusCode: 503`; (b) mock `fetch` returning HTTP 400 → assert `statusCode: 400`; (c) mock slow fetch that never resolves → assert `AbortError` is thrown within timeout window; (d) mock response with missing `message.content` → assert `content: ''`; (e) mock response with missing token count fields → assert `promptTokens: 0`, `completionTokens: 0`

### Implementation — User Story 1

- [x] T006 [US1] Update `complete()` in `backend/src/llm/providers/ollama.js` to call `this._fetch('/api/chat', { method: 'POST', body: JSON.stringify(body) })` instead of calling `fetch()` directly
- [x] T007 [US1] Fix temperature handling in `complete()` in `backend/src/llm/providers/ollama.js` — use `request.temperature ?? 0.1` (nullish coalescing, NOT `|| 0.1`) so `temperature: 0` is forwarded correctly; apply same `??` pattern to all token count fields (`data.prompt_eval_count ?? 0`, `data.eval_count ?? 0`) and `data.message?.content ?? ''`
- [x] T008 [US1] Run unit tests for `complete()` — `cd backend && npx jest tests/backend/llm/providers/ollama.test.js` — confirm all T004/T005 tests pass

**Checkpoint**: `complete()` is fully functional and tested. User Story 1 is independently deliverable.

---

## Phase 4: User Story 2 — Health Check (Priority: P2) & User Story 3 — Model Enumeration (Priority: P2)

US2 and US3 are both P2 and touch the same source file and test file. They are presented together and can be tackled in either order, or in parallel by two developers.

### Goal — US2

`isAvailable()` returns `true` when Ollama responds at `/api/tags`, `false` when unreachable — never throws.

### Goal — US3

`listModels()` returns an array of model name strings from `/api/tags`, or `[]` if unreachable — never throws.

### Tests — User Story 2

- [x] T009 [P] [US2] Write unit test `describe('isAvailable()')` in `tests/backend/llm/providers/ollama.test.js` — (a) mock `fetch` returning HTTP 200 → assert `true`; (b) mock `fetch` throwing a network error → assert `false`; (c) mock `fetch` returning HTTP 500 → assert `false`

### Tests — User Story 3

- [x] T010 [P] [US3] Write unit test `describe('listModels()')` in `tests/backend/llm/providers/ollama.test.js` — (a) mock `/api/tags` returning `{ models: [{ name: 'llama3.1:8b' }, { name: 'llama3.1:70b' }] }` → assert `['llama3.1:8b', 'llama3.1:70b']`; (b) mock network error → assert `[]`; (c) mock HTTP 500 → assert `[]`; (d) mock `{ models: null }` → assert `[]`

### Implementation — User Story 2

- [x] T011 [P] [US2] Update `isAvailable()` in `backend/src/llm/providers/ollama.js` to call `this._fetch('/api/tags', { method: 'GET' }, 5000)` instead of calling `fetch()` directly — keep the existing try/catch returning `false` on any error

### Implementation — User Story 3

- [x] T012 [P] [US3] Update `listModels()` in `backend/src/llm/providers/ollama.js` to call `this._fetch('/api/tags', { method: 'GET' }, 10000)` instead of calling `fetch()` directly — use `data.models ?? []` to guard against null/missing field

- [x] T013 Run unit tests for `isAvailable()` and `listModels()` — `cd backend && npx jest tests/backend/llm/providers/ollama.test.js` — confirm T009/T010 tests pass

**Checkpoint**: `isAvailable()` and `listModels()` are functional and tested. US2 and US3 are independently deliverable.

---

## Phase 5: User Story 4 — Automatic Model Pull on Initialization (Priority: P3)

**Goal**: `initialize()` checks `requiredModels` against locally available models, pulls missing ones with a 10-minute timeout, emits console logs at pull start and completion, and fails fast (throws immediately) on the first pull error.

**Independent Test**: Construct provider with `requiredModels: ['llama3.1:8b']`, confirm the model is not available, call `initialize()`, verify `listModels()` now includes `'llama3.1:8b'`.

### Tests — User Story 4

- [x] T014 [US4] Write unit test `describe('initialize()')` in `tests/backend/llm/providers/ollama.test.js`: (a) empty `requiredModels` → resolves without any `_pullModel` calls; (b) all models already available → resolves without `_pullModel` calls; (c) one model missing → `_pullModel` called once, `console.log` emitted at start and on success; (d) two models missing, first pull succeeds, second fails → first model pulled successfully, error thrown immediately, second model NOT attempted; (e) pull fails with HTTP error → error message includes the failed model name
- [x] T015 [US4] Write unit test `describe('_pullModel()')` in `tests/backend/llm/providers/ollama.test.js`: (a) mock `/api/pull` returning HTTP 200 → resolves; (b) mock `/api/pull` returning HTTP 404 → throws error containing model name and HTTP body

### Implementation — User Story 4

- [x] T016 [US4] Implement `_pullModel(modelName)` in `backend/src/llm/providers/ollama.js` — calls `this._fetch('/api/pull', { method: 'POST', body: JSON.stringify({ name: modelName, stream: false }) }, 600000)`; if response is not ok, reads body text and throws `new Error(\`Failed to pull model \${modelName}: \${errorText}\`)`
- [x] T017 [US4] Implement `initialize()` in `backend/src/llm/providers/ollama.js` — calls `this.listModels()` to get available list; iterates `this._requiredModels`; for each model not in available list: `console.log(\`[OllamaProvider] Pulling model: \${model} (this may take several minutes)...\`)`, awaits `this._pullModel(model)`, then `console.log(\`[OllamaProvider] Model ready: \${model}\`)`; any error from `_pullModel` propagates immediately (fail fast — no try/catch around individual pulls)
- [x] T018 [US4] Run unit tests for `initialize()` and `_pullModel()` — `cd backend && npx jest tests/backend/llm/providers/ollama.test.js` — confirm T014/T015 tests pass

**Checkpoint**: All four user stories are implemented and unit-tested. Full provider is ready.

---

## Phase 6: Polish & Integration

**Purpose**: Integration tests against a real Ollama instance, full test suite run, and interface compliance verification.

- [x] T019 Write integration test file `tests/backend/llm/providers/ollama.integration.test.js` — guard all tests with `if (!process.env.OLLAMA_INTEGRATION_TEST) { test.skip(...) }` at the describe level; include: (a) `isAvailable()` returns `true` against real Ollama; (b) `listModels()` returns a non-empty array; (c) `complete()` with a small model (e.g., `tinyllama`) returns non-empty `content` and non-zero token counts; (d) `initialize()` with a model already present completes without error
- [x] T020 [P] Run the full unit test suite — `cd backend && npm test` — confirm all tests pass with zero failures
- [x] T021 [P] Verify `OllamaProvider` interface compliance against the `LLMProvider` typedef in `backend/src/llm/types.js` — confirm `name`, `complete`, `isAvailable`, `listModels` are all present and match expected signatures; confirm `initialize()` is present (extends the interface for startup use)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — **blocks all user story phases**
- **US1 (Phase 3)**: Depends on Phase 2
- **US2 + US3 (Phase 4)**: Depends on Phase 2 — can proceed in parallel with Phase 3
- **US4 (Phase 5)**: Depends on Phase 2 — can proceed after Phase 3 completes (relies on working `listModels()` from US3)
- **Polish (Phase 6)**: Depends on all story phases

### User Story Dependencies

- **US1 (P1)**: Only depends on Foundational — no dependency on US2/US3/US4
- **US2 (P2)**: Only depends on Foundational — no dependency on US1/US3/US4
- **US3 (P2)**: Only depends on Foundational — no dependency on US1/US2/US4
- **US4 (P3)**: Depends on Foundational + US3 must be complete (`initialize()` calls `listModels()` internally)

### Within Each Phase

- Write tests before implementation (TDD)
- For US4: `_pullModel()` (T016) must complete before `initialize()` (T017)

### Parallel Opportunities

- After Phase 2: US1 (Phase 3) and US2+US3 (Phase 4) can run in parallel
- Within Phase 4: US2 tests (T009) and US3 tests (T010) can be written in parallel; US2 impl (T011) and US3 impl (T012) can be implemented in parallel
- In Phase 6: T020 and T021 can run in parallel

---

## Parallel Example: US2 + US3 (Phase 4)

```
# With two developers after Phase 2 completes:

Developer A (US2):                    Developer B (US3):
T009 — isAvailable() tests            T010 — listModels() tests
T011 — isAvailable() impl             T012 — listModels() impl
                  ↘                  ↙
              T013 — run all tests together
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001)
2. Complete Phase 2: Foundational (T002, T003)
3. Complete Phase 3: User Story 1 (T004–T008)
4. **STOP and VALIDATE**: `cd backend && npx jest tests/backend/llm/providers/ollama.test.js`
5. `complete()` is functional — LLMService can route requests through Ollama

### Incremental Delivery

1. Setup + Foundational → constructor and `_fetch()` ready
2. Add US1 → `complete()` works → agents can call LLMs through Ollama (MVP)
3. Add US2 + US3 → `isAvailable()` and `listModels()` work → provider routing and health checks work
4. Add US4 → `initialize()` works → startup auto-pull ensures models are ready before first request
5. Polish → integration tests validate against real Ollama

### Parallel Team Strategy

With two developers after Phase 2:
- Developer A: US1 (Phase 3) — core completion flow
- Developer B: US2 + US3 (Phase 4) — availability + model listing

---

## Notes

- **Do NOT set `latencyMs`** in `complete()` — `LLMService` injects it after `complete()` returns (see `llm-service.js:115`)
- **Use `??` not `||`** for temperature and token fields — `temperature: 0` is valid and must be forwarded
- **`isAvailable()` and `listModels()` must NEVER throw** — all errors caught, return `false`/`[]`
- **`initialize()` must fail fast** — no try/catch around individual `_pullModel()` calls
- **Layer 1 constraint** — do not import anything from `backend/src/services/`, `backend/src/agents/`, or any other project layer
- **Integration tests** require `OLLAMA_INTEGRATION_TEST=1` environment variable — skip by default in CI
