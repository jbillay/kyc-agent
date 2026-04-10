# Feature Specification: Ollama LLM Provider

**Feature Branch**: `007-ollama-provider`  
**Created**: 2026-04-10  
**Status**: Draft  
**Input**: User description: "@specifications/epic-02-llm-abstraction/ollama-provider/SPEC.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Chat Completion via Ollama (Priority: P1)

A backend service sends a chat completion request through the LLM abstraction layer. The system routes the request to the `OllamaProvider`, which forwards it to a locally running Ollama instance and returns a structured response including the generated text and token usage counts.

**Why this priority**: Core capability — without a working completion method, no AI agents can function. This is the most critical capability in the provider.

**Independent Test**: Can be fully tested by calling the completion method against a running Ollama instance and verifying the returned object contains the generated text, token counts, model name, provider name, and response latency.

**Acceptance Scenarios**:

1. **Given** a running Ollama instance with a model available, **When** a completion request is sent with a valid messages array and model name, **Then** the response contains non-empty generated text, accurate token counts (prompt and completion), the correct model name, the provider identifier `ollama`, and a positive latency measurement.
2. **Given** Ollama returns a non-200 HTTP status, **When** a completion request is made, **Then** an error is thrown with a status code property matching the HTTP status code.
3. **Given** Ollama does not respond within the configured timeout, **When** a completion request is made, **Then** the request is aborted and a timeout error is raised.

---

### User Story 2 - Health Check and Availability (Priority: P2)

A service startup routine checks whether the Ollama backend is reachable before routing requests to it. The check must be fast and must not throw even when Ollama is unreachable.

**Why this priority**: Availability detection is required for the provider routing logic to classify providers correctly. Without it, the LLM service cannot make informed routing decisions.

**Independent Test**: Can be fully tested by calling the availability check against both a reachable and an unreachable Ollama endpoint and verifying it returns `true` or `false` without throwing in either case.

**Acceptance Scenarios**:

1. **Given** Ollama is running and responding at the configured URL, **When** the availability check is called, **Then** it returns `true` within 5 seconds.
2. **Given** nothing is running at the configured URL, **When** the availability check is called, **Then** it returns `false` without throwing an error.

---

### User Story 3 - Model Enumeration (Priority: P2)

An admin tool or service startup routine queries which models are locally available on the Ollama instance, so the system can verify readiness or report available models.

**Why this priority**: Required for the auto-pull initialization flow and for verifying configured models are present before routing completions.

**Independent Test**: Can be fully tested by calling the model listing method against a running Ollama instance with at least one model pulled and verifying a non-empty array of model name strings is returned.

**Acceptance Scenarios**:

1. **Given** Ollama has one or more models pulled locally, **When** the model list is requested, **Then** an array of model name strings is returned (e.g., `["mistral-nemo:12b", "llama3:8b"]`).
2. **Given** Ollama is unreachable, **When** the model list is requested, **Then** an empty array is returned without throwing an error.

---

### User Story 4 - Automatic Model Pull on Initialization (Priority: P3)

At application startup, the system ensures all models required by the configuration are locally available on Ollama, pulling any that are missing. This prevents per-request failures caused by missing models.

**Why this priority**: Important for a reliable first-run experience but not required to test the core completion flow when the Ollama instance already has models available.

**Independent Test**: Can be fully tested by configuring a required model that is not yet pulled, running initialization, and verifying the model appears in the local model list afterward.

**Acceptance Scenarios**:

1. **Given** the required models list includes a model not locally available, **When** initialization is run, **Then** the missing model is pulled from the Ollama registry and becomes available for use.
2. **Given** all required models are already locally available, **When** initialization is run, **Then** no pull requests are made and initialization completes without error.
3. **Given** a model pull fails due to a network error or unknown model name, **When** initialization is run, **Then** initialization stops immediately and an error is raised identifying the failed model name; any remaining models in the list are not attempted.

---

### Edge Cases

- What happens when Ollama returns a response with missing generated text? The provider must return an empty string rather than throwing.
- What happens when token count fields are absent from the Ollama response? Token counts must default to `0` rather than producing undefined or NaN values.
- What happens if a model pull exceeds 10 minutes? The pull operation must be aborted with a timeout error.
- What happens if the required models list is empty? Initialization must complete immediately with no pull attempts.
- What happens when temperature is explicitly set to `0`? The value `0` must be forwarded to Ollama rather than being omitted as a falsy value.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The provider MUST implement the LLM provider interface with `complete`, `isAvailable`, and `listModels` operations.
- **FR-002**: The provider MUST accept a configurable base URL at construction time, defaulting to `http://ollama:11434`.
- **FR-003**: The completion operation MUST send requests to the Ollama chat endpoint with non-streaming mode and return a structured response containing generated text, token usage, model name, provider name, and response latency.
- **FR-004**: Token usage MUST be extracted from the Ollama response: prompt token count maps to `promptTokens`, completion token count maps to `completionTokens`, and their sum maps to `totalTokens`.
- **FR-005**: The availability check MUST return `true` when Ollama responds successfully, `false` when unreachable — without throwing an error in either case.
- **FR-006**: The model listing operation MUST return an array of model name strings from the Ollama tags endpoint, or an empty array if Ollama is unreachable.
- **FR-007**: Initialization MUST auto-pull any required models that are not already locally available and MUST be safe to call at startup. The provider MUST emit a console log message at the start of each model pull and upon successful completion (e.g., `Pulling model X...` / `Model X ready`).
- **FR-008**: All requests to Ollama MUST enforce a configurable per-request timeout (default: 120 seconds), aborting the request if exceeded.
- **FR-009**: Model pull requests MUST use a separate, fixed 10-minute timeout independent of the per-request timeout.
- **FR-010**: HTTP errors from Ollama MUST result in thrown errors with a `statusCode` property set to the HTTP status code, enabling retry classification by the calling service.
- **FR-011**: Optional temperature and max token parameters passed in a completion request MUST be forwarded to Ollama; temperature `0` must be treated as a valid value and forwarded.

### Key Entities

- **OllamaProvider**: The concrete provider class. Holds connection configuration (base URL, timeout) and the list of required models. Exposes the LLM provider interface plus an initialization method.
- **LLM Request**: Input to the completion operation — contains model name, messages array, optional temperature, optional max tokens.
- **LLM Response**: Output of the completion operation — contains generated text content, token usage breakdown (prompt, completion, total), model name, provider identifier, and response latency in milliseconds.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A chat completion request to a running Ollama instance returns a valid response with non-zero token counts; the operation completes within 3 minutes on CPU-only hardware.
- **SC-002**: Availability checks complete within 5 seconds regardless of Ollama state (running or unreachable).
- **SC-003**: Model listing returns the correct set of locally available models within 10 seconds on a healthy Ollama instance.
- **SC-004**: Auto-pull of a missing model during initialization succeeds within 10 minutes and the model is usable immediately afterward.
- **SC-005**: All unit test scenarios pass with mocked HTTP responses, covering the happy path, HTTP error responses, and request timeouts.
- **SC-006**: Integration tests against a real Ollama instance pass for availability check, model listing, and at least one completion request using a small model.

## Clarifications

### Session 2026-04-10

- Q: When `initialize()` is pulling a required model, what should the provider communicate about its progress? → A: Console log at pull start and completion (e.g., `Pulling model X...` / `Model X ready`).
- Q: If one model pull fails during `initialize()`, should the provider fail fast or continue pulling remaining models? → A: Fail fast — stop on first error and throw immediately with the failed model name.

## Assumptions

- Ollama runs as a Docker service accessible within the compose network; external DNS or network configuration is outside this feature's scope.
- The LLM provider interface contract (`complete`, `isAvailable`, `listModels`) is already defined and stable (depends on feature #8 — provider interface).
- The calling LLM service is responsible for retry logic and backoff; the provider only needs to expose status codes on errors to support retry classification.
- Response streaming is not required for MVP; all completion requests use non-streaming mode. The design should not preclude adding streaming in a future iteration.
- Model pull operations are expected to be slow (potentially several minutes); a 10-minute timeout is acceptable and expected.
- The runtime environment provides native HTTP fetch capability.
- Temperature `0` is a valid, meaningful value (deterministic output) and must be forwarded — it must not be treated as absent or falsy.
