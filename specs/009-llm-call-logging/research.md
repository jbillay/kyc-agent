# Research: LLM Call Logging for Audit Trail

**Feature**: 009-llm-call-logging  
**Date**: 2026-04-22

## Current State Analysis

### What already exists in `llm-service.js`

`_logCall(request, response, context, attempt, fallbackProvider)` is called:
- After a **successful** provider response (line 122 in `complete()`)
- After a **successful fallback** response (line 354 in `_tryFallback()`)

Current payload logged:
```js
{
  provider: fallbackProvider || response.provider,
  model: response.model,
  taskType: request.taskType,
  attempt,
  request: { messages, temperature, maxTokens },
  response: { content, structured, usage, latencyMs },
}
```

### What is missing

| Gap | Location | Change Required |
|-----|----------|-----------------|
| `status` field | `_logCall()` payload | Add `status: 'success'` to all successful log entries |
| Failed call logging | `complete()` throw paths | Call `_logFailedCall()` before each `throw LLM_CALL_FAILED` |
| `error` field on failure | new `_logFailedCall()` | Include `error: lastError.message` |
| `originalProvider` field | `_logCall()` signature | Add when fallback is used (primary name ≠ responding provider) |
| Redaction support | `_logCall()` | Apply `_redactIfNeeded()` before writing payload |
| Redaction config | Constructor | Read `config.logging?.redact_prompts` / `redact_responses` |
| `config/llm.yaml` logging section | `config/llm.yaml` | Add `logging:` block with both flags defaulting to `false` |

## Design Decisions

### Decision 1: Separate `_logFailedCall()` vs. unified `_logCall()`

- **Decision**: Add a dedicated `_logFailedCall(request, context, attempt, provider, error)` method rather than overloading `_logCall()` with an optional response.
- **Rationale**: The shapes diverge significantly (no `response` object, different required fields). A unified method with many optional params would be harder to test and reason about. Two focused methods are cleaner.
- **Alternatives considered**: Unified `_logCall()` with `status` + optional `response` — rejected for readability; `_logCall(request, response | null, ...)` — rejected because null-checking throughout adds noise.

### Decision 2: `originalProvider` field only when fallback is used

- **Decision**: `originalProvider` is only present in the payload when the responding provider differs from the default provider. It is omitted (not `null`) when no fallback occurred.
- **Rationale**: Keeps the normal-path payload lean. Audit queries checking for fallback usage can filter on `data ? 'originalProvider'` in the JSONB column.
- **Alternatives considered**: Always include `originalProvider: null` for consistency — rejected to keep payload minimal.

### Decision 3: Failed call logging scope

- **Decision**: Log a `status: 'failed'` event at the two `LLM_CALL_FAILED` throw points in `complete()`, and **also** within `_tryFallback()` on fallback failure (to capture which fallback provider was attempted and failed). This means a fully-exhausted call (primary fails → fallback fails) produces **two** `llm_call` events: one for the primary failure and one for the fallback failure.
- **Rationale**: The fallback provider name is only known inside `_tryFallback()`. Bubbling it up to `complete()` for a single consolidated log would require API changes and state threading. Two events provide full traceability with no information loss.
- **Alternatives considered**: Single event logged in `complete()` after all paths exhausted — rejected because fallback provider identity is lost at that scope; modifying `_tryFallback()` return type to carry failure metadata — rejected as over-engineering for this story.

### Decision 4: `attempt` value in failed logs

- **Decision**: For primary failure, log `attempt` as the value from the retry loop at time of failure (1 for non-retryable, maxAttempts for exhausted retries). For fallback failure, log `attempt: 1` (fallback always starts fresh).
- **Rationale**: Matches the existing convention in `_tryFallback()` which passes `attempt: 1` for successful fallbacks.

### Decision 5: Redaction config loading

- **Decision**: Read `config.logging` in the `LLMService` constructor and store as `this._redactionConfig`. If `config.logging` is absent, `this._redactionConfig` is `null` and redaction is skipped entirely.
- **Rationale**: Matches the existing pattern in the constructor (all config read at init time). No runtime re-reads needed.

### Decision 6: `_logFailedCall()` is also fail-open

- **Decision**: `_logFailedCall()` wraps its `appendEvent` call in a try/catch identical to `_logCall()` — logging a failed call must not prevent the original error from being thrown.
- **Rationale**: Consistent with FR-004; a logging infrastructure failure should never swallow the root cause error.

## Config Schema Addition

```yaml
# config/llm.yaml — new section to add under top-level
llm:
  logging:
    redact_prompts: false
    redact_responses: false
```

Note: The existing `config/llm.yaml` does not have an `llm:` top-level wrapper — the file IS the LLM config. The `logging:` section is added at the top level of the file, consistent with the `providers:`, `routing:`, `default_provider:` keys already present.

## Test Coverage Plan

All tests extend the existing `describe('US4 — Full Audit Logging', ...)` block or add new describe blocks in `tests/backend/llm/llm-service.test.js`.

| Test ID | Scenario | FR |
|---------|----------|----|
| T-LOG-01 | Successful call includes `status: 'success'` | FR-001, FR-002 |
| T-LOG-02 | Failed call (all retries exhausted) writes `status: 'failed'` with `error` field | FR-001 |
| T-LOG-03 | Non-retryable failure writes `status: 'failed'` with `error` field | FR-001 |
| T-LOG-04 | Fallback success: `provider` = fallback, `originalProvider` = default | FR-002 |
| T-LOG-05 | No fallback (primary only): `originalProvider` absent from payload | FR-002 |
| T-LOG-06 | `attempt: 2` logged when call succeeds on second retry | FR-002 |
| T-LOG-07 | `redact_prompts: true` → message `content` = '[REDACTED]', `role` preserved | FR-007 |
| T-LOG-08 | `redact_responses: true` → response `content` = '[REDACTED]', `usage`/`latencyMs` unchanged | FR-008 |
| T-LOG-09 | No redaction config → full content logged | FR-007, FR-008 |
| T-LOG-10 | Fail-open: `_logFailedCall()` event store throw does not swallow LLM error | FR-004 |
