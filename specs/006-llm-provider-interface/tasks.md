# Tasks: LLM Provider Interface and Routing Service

**Input**: Design documents from `/specs/006-llm-provider-interface/`  
**Prerequisites**: plan.md ✅ | spec.md ✅ | research.md ✅ | data-model.md ✅ | contracts/ ✅ | quickstart.md ✅

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)
- Exact file paths are included in every task description

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the test directory structure and the baseline configuration file needed before any implementation begins.

- [x] T001 Create test directories `tests/backend/llm/` and `tests/backend/llm/prompt-adapters/` (empty, with `.gitkeep` files following project convention)
- [x] T002 Create `config/llm.yaml` with the minimal Ollama-only configuration from `specs/006-llm-provider-interface/contracts/llm-yaml-schema.md` (single provider, all five task types mapped to `llama3.1:8b` as placeholder)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core type definitions and prompt adapter infrastructure that every user story depends on. All agents and providers import from these files.

**⚠️ CRITICAL**: No user story implementation can begin until this phase is complete.

- [x] T003 Implement `backend/src/llm/types.js` — define all JSDoc `@typedef` blocks (`LLMMessage`, `LLMRequest`, `LLMResponse`, `LLMStructuredOutput`, `LLMCallContext`, `LLMProvider`) and export the `TASK_TYPES` constant array `['reasoning','extraction','screening','classification','summarization']`
- [x] T004 [P] Implement `backend/src/llm/prompt-adapters/default.js` — `DefaultAdapter` class with `formatMessages(messages)` (passthrough, returns messages unchanged) and `formatStructuredOutputInstruction(schema)` (returns plain-English JSON instruction string)
- [x] T005 [P] Implement `backend/src/llm/prompt-adapters/mistral.js` — `MistralAdapter` class; `formatMessages` adds `[INST]`/`[/INST]` markers for user turns per Mistral instruct template; `formatStructuredOutputInstruction` adapts instruction wording for Mistral models
- [x] T006 [P] Implement `backend/src/llm/prompt-adapters/llama.js` — `LlamaAdapter` class; `formatMessages` applies Llama 3 `<|begin_of_text|>` / `<|start_header_id|>` chat template format; `formatStructuredOutputInstruction` adapts instruction wording for Llama models
- [x] T007 Implement `backend/src/llm/prompt-adapter-factory.js` — `PromptAdapterFactory` class; `getAdapter(modelName)` uses prefix matching: `modelName.startsWith('mistral')` → `MistralAdapter`, `modelName.startsWith('llama')` → `LlamaAdapter`, otherwise → `DefaultAdapter`; adapters are instantiated once and reused (singletons within the factory) (depends on T004, T005, T006)

**Checkpoint**: Foundation ready — all type definitions and adapters exist. User story implementation can now begin.

---

## Phase 3: User Story 1 — Unified LLM Access for Agents (Priority: P1) 🎯 MVP

**Goal**: Agents can submit any LLM request by task type and receive a valid response. The service selects the correct provider and model from configuration, applies the prompt adapter, and returns a response. No agent ever touches a provider directly.

**Independent Test**: Submit a mock request for each of the five task types using a mock provider. Verify the correct provider and model are selected, the default temperature (0.1) is applied, and an error is thrown for an unmapped task type.

### Implementation for User Story 1

- [x] T008 [P] [US1] Implement `backend/src/llm/providers/ollama.js` — `OllamaProvider` class; `name = 'ollama'`; `complete(request)` calls the Ollama `/api/chat` endpoint (via Node.js `http`/`fetch`) and maps the response to `LLMResponse`; `isAvailable()` pings `/api/tags`; `listModels()` returns model names from `/api/tags`; populate `usage` fields (Ollama exposes `prompt_eval_count` and `eval_count`)
- [x] T009 [P] [US1] Implement `backend/src/llm/providers/openai.js` — `OpenAIProvider` class; `name = 'openai'`; `complete(request)` calls OpenAI chat completions API; maps `finish_reason` and `usage` fields to `LLMResponse`; `isAvailable()` calls `/v1/models` and returns `true` on 200; `listModels()` returns model IDs
- [x] T010 [P] [US1] Implement `backend/src/llm/providers/openai-compatible.js` — `OpenAICompatibleProvider` class; `name` and `baseUrl` are constructor params; otherwise identical interface to OpenAI provider; reuse OpenAI request/response mapping logic
- [x] T011 [P] [US1] Implement `backend/src/llm/providers/anthropic.js` — `AnthropicProvider` class; `name = 'anthropic'`; `complete(request)` calls Anthropic Messages API (`/v1/messages`); maps system message from `messages[0]` if `role === 'system'`; maps `usage.input_tokens`/`output_tokens` to `LLMResponse.usage`; `isAvailable()` makes a minimal API call to verify connectivity
- [x] T012 [P] [US1] Implement `backend/src/llm/providers/vllm.js` — `VLLMProvider` class; `name = 'vllm'`; `baseUrl` is a constructor param; `complete(request)` uses OpenAI-compatible chat completions endpoint; `isAvailable()` pings `/health`; `listModels()` calls `/v1/models`
- [x] T013 [US1] Implement `backend/src/llm/llm-service.js` — `LLMService` class with: `constructor({ config, eventStore, promptAdapterFactory })` that loads `defaultProviderName`, `routing`, and `providerConfigs` from config; `registerProvider(provider)` that stores provider in a `Map`; core `complete(request, context)` method implementing the routing-only path (steps 1–4 from `contracts/llm-service-api.md`): resolve provider + model by task type, get prompt adapter, format messages, build adapted request, call `provider.complete()`; throw `NO_PROVIDER_AVAILABLE` if no provider found; apply default temperature 0.1; do NOT yet implement retry, fallback, structured output, or logging — those come in subsequent phases (depends on T007, T008–T012)
- [x] T014 [US1] Write routing unit tests in `tests/backend/llm/llm-service.test.js` covering: (a) correct provider and model selected for each of the five task types when two mock providers are configured; (b) default temperature 0.1 applied when request omits temperature; (c) `NO_PROVIDER_AVAILABLE` thrown for a task type with no routing entry; (d) `registerProvider` replaces a previously registered provider with the same name

**Checkpoint**: `LLMService.complete()` routes requests to the correct provider. Testable without retry or logging. **User Story 1 is independently functional.**

---

## Phase 4: User Story 2 — Automatic Retry and Provider Fallback (Priority: P2)

**Goal**: Transient failures are recovered transparently. The service retries failed requests with exponential backoff (2× for rate-limit errors), falls back to alternate providers when retries are exhausted, and surfaces a clear error only when all providers fail.

**Independent Test**: (a) Mock provider that fails twice then succeeds — verify 3 attempts and exponentially increasing delays. (b) Mock provider that always fails — verify fallback to the second provider. (c) Both providers fail — verify `LLM_CALL_FAILED` error with correct `cause`.

### Implementation for User Story 2

- [x] T015 [US2] Implement `backend/src/llm/semaphore.js` — `Semaphore` class with `constructor(limit)`, `async acquire()` (blocks if `active >= limit`, queues resolver), and `release()` (increments counter, dequeues next waiter if any); export as `{ Semaphore }`
- [x] T016 [US2] Add retry with exponential backoff to `backend/src/llm/llm-service.js` — implement `_isRetryable(err)` (returns true for `ECONNREFUSED`, `ECONNRESET`, `AbortError`, `statusCode >= 500`); wrap provider call in a `for` loop up to `max_attempts`; on retryable failure wait `backoffMs * Math.pow(2, attempt - 1)` ms before next attempt; throw `LLM_CALL_FAILED` after all attempts fail (depends on T013)
- [x] T017 [US2] Add rate-limit error detection and extended backoff to `backend/src/llm/llm-service.js` — implement `_isRateLimited(err)` (returns true for `statusCode === 429` or message/code contains `rate_limit` or `rate limit`, case-insensitive); in the retry loop, apply `backoffMs * 2 * Math.pow(2, attempt - 1)` for rate-limited retries; rate-limited errors count against the same `max_attempts` budget (depends on T016)
- [x] T018 [US2] Add provider fallback logic to `backend/src/llm/llm-service.js` — implement `_tryFallback(request, context, startTime)` that iterates registered providers (skipping the default provider), checks availability (with timeout), gets adapter, adapts request, and calls `provider.complete()`; invoked from `complete()` when all retries on the primary provider are exhausted; returns `null` if no fallback succeeds (depends on T016)
- [x] T019 [US2] Add configurable availability check timeout to `backend/src/llm/llm-service.js` — in `_resolveProviderAndModel()` and `_tryFallback()`, wrap `provider.isAvailable()` in a `Promise.race()` against a timeout rejection using `availability_timeout_ms` from provider config (default 3000ms); a timed-out check treats the provider as unavailable (depends on T013)
- [x] T020 [US2] Integrate per-provider concurrency limiting into `backend/src/llm/llm-service.js` — on `registerProvider()`, create a `Semaphore` instance sized by `providerConfigs[name].max_concurrent ?? 4` and store alongside the provider; in `complete()`, call `semaphore.acquire()` before `provider.complete()` and `semaphore.release()` in a `finally` block (depends on T015, T013)
- [x] T021 [US2] Extend `tests/backend/llm/llm-service.test.js` with retry/fallback/concurrency/timeout tests covering: (a) mock provider fails twice then succeeds — verify attempt count and delay timing; (b) rate-limit error triggers 2× extended backoff; (c) non-retryable error (4xx) does not retry; (d) default provider unavailable — fallback provider called and response returned; (e) all providers fail — `LLM_CALL_FAILED` thrown with `cause`; (f) availability check that exceeds `availability_timeout_ms` treats provider as unavailable; (g) concurrent requests beyond `max_concurrent` queue and complete in order

**Checkpoint**: Retry, rate-limit backoff, fallback, and concurrency limiting all functional. **User Story 2 is independently testable.**

---

## Phase 5: User Story 3 — Structured Output Extraction (Priority: P2)

**Goal**: Agents can attach a JSON schema to a request and receive a fully parsed JavaScript object in `response.structured`. The service handles JSON embedded in markdown code blocks. Invalid JSON produces a clear `STRUCTURED_OUTPUT_PARSE_ERROR`.

**Independent Test**: Submit three requests with `structuredOutput`: (a) AI returns plain JSON — verify `response.structured` matches; (b) AI returns JSON in a ` ```json ``` ` code block — verify extraction and parse; (c) AI returns non-JSON text — verify `STRUCTURED_OUTPUT_PARSE_ERROR` thrown with `rawContent` field.

### Implementation for User Story 3

- [x] T022 [US3] Implement `_injectStructuredOutputInstruction(messages, instruction)` in `backend/src/llm/llm-service.js` — locates the system message in the array (by `role === 'system'`) and appends `'\n\n' + instruction` to its content; if no system message exists, prepends one; returns a new array (immutable); wire this into `complete()` when `request.structuredOutput` is present (depends on T013)
- [x] T023 [US3] Implement `_parseStructuredOutput(content, spec)` in `backend/src/llm/llm-service.js` — extract JSON from raw text by first trying to match a ` ```json ... ``` ` or ` ``` ... ``` ` code block (regex: `/```(?:json)?\s*([\s\S]*?)```/`); if no code block, treat full content as JSON string; `JSON.parse()` the extracted string; on parse failure throw `Object.assign(new Error(...), { code: 'STRUCTURED_OUTPUT_PARSE_ERROR', rawContent: content })`; wire result into `complete()` as `response.structured` (depends on T013)
- [x] T024 [US3] Extend `tests/backend/llm/llm-service.test.js` with structured output tests covering: (a) plain JSON response → `response.structured` is a parsed object; (b) JSON wrapped in ` ```json ``` ` block → extracted and parsed correctly; (c) JSON wrapped in plain ` ``` ``` ` block (no language tag) → extracted and parsed correctly; (d) non-JSON text → `STRUCTURED_OUTPUT_PARSE_ERROR` thrown with `rawContent` equal to the raw response; (e) structured output instruction is injected into system message when schema is provided; (f) structured output instruction creates a new system message when none exists in the request

**Checkpoint**: Structured output parsing is fully functional for all three response formats. **User Story 3 is independently testable.**

---

## Phase 6: User Story 4 — Full Audit Logging of Every LLM Call (Priority: P3)

**Goal**: Every successful LLM call produces an immutable `llm_call` event in the event store. The log entry contains full unredacted request and response content. Logging failures are silently swallowed and never surface to the caller.

**Independent Test**: (a) Submit request with valid `caseId` — verify `eventStore.appendEvent` called once with correct payload shape. (b) `eventStore.appendEvent` throws — verify `complete()` still returns the LLM response without error. (c) Fallback provider used — verify log records fallback provider name, not default.

### Implementation for User Story 4

- [x] T025 [US4] Implement `_logCall(request, response, context, attempt, fallbackProvider)` in `backend/src/llm/llm-service.js` — call `this.eventStore.appendEvent(context.caseId, context.agentType ?? 'unknown', context.stepId ?? 'unknown', 'llm_call', payload)` where payload matches the shape in `specs/006-llm-provider-interface/contracts/event-log-shape.md`; wrap the entire method body in `try/catch` and swallow errors with `console.error`; skip logging silently if `context.caseId` is falsy; wire into `complete()` after a successful response (depends on T013)
- [x] T026 [US4] Extend `tests/backend/llm/llm-service.test.js` with logging tests covering: (a) `eventStore.appendEvent` is called exactly once per successful call with correct `caseId`, `agentType`, `stepId`, event type `'llm_call'`, provider, model, taskType, attempt, full messages, response content, usage, and latencyMs; (b) `eventStore.appendEvent` throws an error — `complete()` still returns the LLM response without throwing; (c) fallback provider used — log entry records fallback provider `name`, not the default provider name; (d) `context.caseId` is absent — `eventStore.appendEvent` is NOT called

**Checkpoint**: Every call is fully logged. Logging is resilient to event store failures. **User Story 4 is independently testable. All four user stories are now complete.**

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Adapter tests, end-to-end smoke test, and verification against documentation.

- [x] T027 [P] Write prompt adapter formatting tests in `tests/backend/llm/prompt-adapters/adapters.test.js` — test `formatMessages` for each adapter (`DefaultAdapter`, `MistralAdapter`, `LlamaAdapter`) with a mix of system/user/assistant messages; test `formatStructuredOutputInstruction` returns a non-empty string containing the schema; test `PromptAdapterFactory.getAdapter()` returns the correct adapter class for `mistral:7b`, `llama3.1:70b`, and `gpt-4o` model names
- [x] T028 Write an end-to-end smoke test in `tests/backend/llm/llm-service.test.js` that exercises the full `complete()` pipeline using a mock Ollama provider: routing → adapter formatting → structured output instruction injection → mock provider response → structured output parsing → event store log entry → returned `LLMResponse` shape (all fields populated correctly)
- [x] T029 [P] Verify all five provider implementations (`ollama.js`, `openai.js`, `openai-compatible.js`, `anthropic.js`, `vllm.js`) return `usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }` when the provider API does not include token counts in the response (handles providers that omit usage data)
- [x] T030 Review `specs/006-llm-provider-interface/quickstart.md` wiring guide and confirm all code examples match the final implemented API signatures (constructor params, method names, error codes, response field names)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 — **blocks all user story phases**
- **Phase 3 (US1)**: Depends on Phase 2 — no dependencies on US2, US3, US4
- **Phase 4 (US2)**: Depends on Phase 3 (US1 routing must exist before retry wraps it)
- **Phase 5 (US3)**: Depends on Phase 3 (US1 complete() must exist); independent from US2
- **Phase 6 (US4)**: Depends on Phase 3 (US1 complete() must exist); independent from US2 and US3
- **Phase 7 (Polish)**: Depends on all user story phases being complete

### User Story Dependencies

- **US1 (P1)**: Starts after Foundational — no other story dependencies
- **US2 (P2)**: Starts after US1 — wraps the routing logic built in US1
- **US3 (P2)**: Starts after US1 — adds to the `complete()` pipeline; independent from US2
- **US4 (P3)**: Starts after US1 — adds to the `complete()` pipeline; independent from US2 and US3

> US3 and US4 can be worked in parallel once US1 is complete. US2 can also run in parallel with US3/US4 since they touch different methods in `llm-service.js`.

### Within Each User Story

- Providers (T008–T012) are all parallel with each other
- Providers must exist before the `LLMService` core (T013)
- `LLMService` core (T013) must exist before tests (T014)
- Semaphore (T015) can be implemented in parallel with retry logic (T016–T017)
- Tests always after implementation within each story

### Parallel Opportunities

| Group | Tasks | Parallelizable? |
|-------|-------|-----------------|
| Adapters | T004, T005, T006 | ✅ All parallel |
| Providers | T008, T009, T010, T011, T012 | ✅ All parallel |
| US3 + US4 | Phases 5 and 6 | ✅ Parallel after US1 |
| US2 methods | T015, T016 | ✅ Parallel |
| Polish | T027, T029 | ✅ Parallel |

---

## Parallel Example: User Story 1

```
# All providers can be implemented simultaneously (all different files):
T008: backend/src/llm/providers/ollama.js
T009: backend/src/llm/providers/openai.js
T010: backend/src/llm/providers/openai-compatible.js
T011: backend/src/llm/providers/anthropic.js
T012: backend/src/llm/providers/vllm.js

# Then (sequentially, depends on all providers):
T013: backend/src/llm/llm-service.js  →  T014: tests/backend/llm/llm-service.test.js
```

## Parallel Example: After US1 (US2 + US3 + US4 simultaneously)

```
# US2 track:
T015 → T016 → T017 → T018 → T019 → T020 → T021

# US3 track (parallel with US2):
T022 → T023 → T024

# US4 track (parallel with US2 and US3):
T025 → T026
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational (T003–T007)
3. Complete Phase 3: User Story 1 (T008–T014)
4. **STOP and VALIDATE**: Run `cd backend && npx jest tests/backend/llm/llm-service.test.js` — all routing tests pass
5. Agents can now be wired to `LLMService` for basic routing (no resilience yet)

### Incremental Delivery

1. Setup + Foundational → skeleton exists
2. US1 → routing works, agents can call LLM → **MVP**
3. US2 → add resilience (retry, fallback, concurrency) → production-ready
4. US3 → add structured output → agents receive typed data
5. US4 → add audit logging → compliance requirement satisfied
6. Polish → adapter tests, smoke test, doc review

### Parallel Team Strategy

With multiple developers after Phase 2 is complete:

- **Developer A**: US2 track (T015–T021) — retry/fallback
- **Developer B**: US3 track (T022–T024) — structured output
- **Developer C**: US4 track (T025–T026) — audit logging

All three tracks modify `llm-service.js` — coordinate via feature branches or clear method-level separation to avoid merge conflicts.

---

## Notes

- [P] tasks = different files, no shared state — safe to implement simultaneously
- [Story] label maps every task to a specific user story for traceability
- No test tasks are marked TDD (spec did not request it) — tests are written after implementation in each story phase
- Each user story phase ends with a **Checkpoint** — stop and validate before moving on
- All five provider files follow the same `LLMProvider` interface — implement one first and use it as the template for the others
- `llm-service.js` is extended incrementally across phases 3–6 — each phase adds methods without modifying existing ones (except wiring calls in `complete()`)
- Commit after each task or logical group; the feature branch is `006-llm-provider-interface`
