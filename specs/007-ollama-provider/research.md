# Research: Ollama LLM Provider

**Branch**: `007-ollama-provider` | **Date**: 2026-04-10

## Findings

### 1. Existing OllamaProvider stub (feature 006)

**Decision**: Extend the existing `backend/src/llm/providers/ollama.js` rather than replace it.

**Rationale**: Feature 006 created a minimal stub that is already registered in `LLMService`. The stub correctly implements `complete()`, `isAvailable()`, and `listModels()` at a basic level. Feature 007 adds the missing capabilities: `initialize()`, `requiredModels`, per-request `AbortController` timeout, and `_pullModel()` with console logging. Replacing the file wholesale would be safe, but extending it avoids any risk of diverging from the constructor shape already referenced at startup.

**Gap summary**:
| Capability | Status in 006 | Required by 007 |
|---|---|---|
| `complete()` | ✓ (no internal timeout) | ✓ + AbortController |
| `isAvailable()` | ✓ (pings `/api/tags`) | ✓ (acceptable — `/api/tags` is a valid health indicator) |
| `listModels()` | ✓ | ✓ |
| `initialize()` | ✗ missing | ✓ |
| `requiredModels` config | ✗ missing | ✓ |
| `timeoutMs` config | ✗ missing | ✓ |
| `_fetch()` with AbortController | ✗ missing | ✓ |
| `_pullModel()` | ✗ missing | ✓ |
| Console logging on pull | ✗ missing | ✓ |
| `latencyMs` in response | ✗ (added by LLMService) | N/A — LLMService injects it |

---

### 2. Timeout responsibility split

**Decision**: The provider's internal `_fetch()` wrapper owns per-request timeout via `AbortController`. `LLMService._executeWithTimeout()` also wraps `complete()`, creating a two-layer safety net.

**Rationale**: `LLMService` creates an `AbortController` but does not pass the signal to `provider.complete()`. This means the provider's internal `fetch` call is not cancelled when `LLMService` aborts — the HTTP request would keep running until the OS TCP timeout. Adding `AbortController` inside the provider's `_fetch()` ensures the actual HTTP request is cancelled. The two timeouts are independent; the provider timeout is the inner guard, the service timeout is the outer guard.

**How to apply**: `_fetch(path, options, timeoutMs)` creates its own `AbortController`, sets a `setTimeout`, and passes `signal` to `fetch()`. The `_pullModel()` call passes `600000` (10 min) explicitly; `complete()` and `listModels()` use `this.timeoutMs`.

---

### 3. `latencyMs` in LLMResponse

**Decision**: `OllamaProvider.complete()` does NOT add `latencyMs` to the response.

**Rationale**: `LLMService` already injects `latencyMs` at line 115: `response.latencyMs = Date.now() - startTime`. If the provider also sets it, the service would overwrite it anyway. The existing stub omits it correctly. The spec's `latencyMs` requirement is satisfied at the service layer.

---

### 4. `isAvailable()` endpoint choice

**Decision**: Keep using `/api/tags` for `isAvailable()` (not `/`).

**Rationale**: The SPEC.md suggests pinging `/` (returns `"Ollama is running"`), but the existing 006 implementation uses `/api/tags`. Both are valid. `/api/tags` is slightly more informative (confirms the model-serving path is up) and the existing test expectations will be based on it. No reason to change.

---

### 5. Test location and structure

**Decision**: Tests go in `tests/backend/llm/providers/ollama.test.js` and `tests/backend/llm/providers/ollama.integration.test.js`.

**Rationale**: Jest is configured with `roots: ["<rootDir>/../tests/backend"]` (from `backend/package.json`). No existing test files were found — this feature creates the first tests. Unit tests use Jest's `jest.spyOn(global, 'fetch')` to mock HTTP. Integration tests require a running Ollama instance and should be skippable via `OLLAMA_INTEGRATION_TEST=1` env guard.

---

### 6. Model names in config

**Decision**: Use the models already in `config/llm.yaml` (`llama3.1:70b`, `llama3.1:8b`) rather than the models listed in the original SPEC.md (`mistral-nemo:12b`, `llama3:8b`).

**Rationale**: `config/llm.yaml` is the authoritative source for model routing (Constitution Principle V). The SPEC.md model suggestions are informational defaults. The `requiredModels` list passed to `OllamaProvider` at startup will be derived from the routing config, not hardcoded in the provider.

---

### 7. Fail-fast behaviour in `initialize()`

**Decision**: Stop on the first pull failure and rethrow immediately.

**Rationale**: Confirmed via clarification session (2026-04-10). Partial initialization state (some models pulled, some not) is harder to reason about than a clean failure. The operator must fix configuration and restart.

---

### 8. Console logging format

**Decision**: Use `console.log` with a consistent prefix for pull start/completion.

**Rationale**: Confirmed via clarification session (2026-04-10). The project uses `pino` for structured logging in services, but the provider is Layer 1 (no service dependencies). `console.log` avoids importing a logger into the LLM abstraction layer. Format: `[OllamaProvider] Pulling model: <name> (this may take several minutes)...` and `[OllamaProvider] Model ready: <name>`.

---

### 9. Node.js native APIs

**Decision**: Use native `fetch` and `AbortController` — no polyfills needed.

**Rationale**: `backend/package.json` declares `engines: { node: ">=22.0.0" }`. Both `fetch` (since Node 18) and `AbortController` (since Node 15) are stable globals in Node 22.
