# Contract: LLMProvider Interface

**File**: `backend/src/llm/types.js`  
**Type**: Internal service contract (Layer 1)  
**Consumers**: `LLMService`, provider implementations, tests

Every AI provider registered with `LLMService` MUST implement this interface. Providers are registered via `llmService.registerProvider(provider)` at application startup.

---

## Interface Members

### `name: string`

Unique string identifier for this provider. Must match the key used in `config/llm.yaml` under `providers` and `routing`.

- Must be non-empty
- Should use kebab-case (e.g., `ollama`, `openai`, `openai-compatible`)
- Used in audit log entries and error messages

---

### `complete(request: LLMRequest): Promise<LLMResponse>`

Execute an LLM inference call. The request passed to this method has already been adapted (messages formatted for the model, structured output instruction injected) by `LLMService`. Providers must NOT re-format messages.

**Contract obligations**:
- MUST return a valid `LLMResponse` on success
- MUST populate `response.model` with the actual model string used
- MUST populate `response.provider` with `this.name`
- MUST populate `response.usage` with token counts (use `0` if the provider does not expose token counts)
- MUST throw an error on failure — do not return a partial response
- Error objects SHOULD include `statusCode` (HTTP status, if applicable) and `code` (string error code) to enable retry classification

**Error codes that trigger retry**:
- `ECONNREFUSED`, `ECONNRESET` — network errors
- `AbortError` — request timeout
- `statusCode >= 500` — server-side errors
- `statusCode === 429` or message contains `rate_limit` / `rate limit` — rate limiting (extended backoff)

**Error codes that do NOT trigger retry**:
- `statusCode >= 400 && statusCode < 429` — client errors (bad request, auth failure)
- `STRUCTURED_OUTPUT_PARSE_ERROR` — post-processing failure

---

### `isAvailable(): Promise<boolean>`

Check whether the provider is reachable and ready to serve requests. Called by `LLMService` before routing a request.

**Contract obligations**:
- MUST resolve to `true` if the provider can accept requests
- MUST resolve to `false` (not throw) if the provider is known to be unavailable
- SHOULD complete within `availability_timeout_ms` (enforced externally by `LLMService` via `Promise.race()`)
- Typical implementation: a lightweight HTTP ping to the provider's health or models endpoint

---

### `listModels(): Promise<string[]>`

Return the list of model names this provider can serve.

**Contract obligations**:
- MUST return an array of strings (may be empty if models cannot be enumerated)
- Strings should match the format used in `config/llm.yaml` routing values
- Used for diagnostic and admin purposes only — not called on the critical request path

---

## Example Stub Implementation

```javascript
'use strict';

class MyProvider {
  constructor({ apiKey, baseUrl }) {
    this.name = 'my-provider';
    // ...
  }

  async complete(request) {
    // request.model is set by LLMService before calling this method
    // request.messages are already formatted by the prompt adapter
    throw new Error('Not implemented');
  }

  async isAvailable() {
    try {
      // ping health endpoint
      return true;
    } catch {
      return false;
    }
  }

  async listModels() {
    return [];
  }
}

module.exports = { MyProvider };
```
