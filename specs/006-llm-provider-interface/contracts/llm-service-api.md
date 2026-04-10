# Contract: LLMService Public API

**File**: `backend/src/llm/llm-service.js`  
**Type**: Internal service contract (Layer 1)  
**Consumers**: All agents (Layer 3), Core Services (Layer 4) — via dependency injection only

`LLMService` is a singleton. It is instantiated once at application startup and shared across all agents. Agents MUST NOT import `LLMService` directly — it is injected via the agent constructor or worker bootstrap.

---

## Constructor

```
new LLMService({ config, eventStore, promptAdapterFactory })
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config` | `Object` | Yes | Parsed `config/llm.yaml` contents (pre-loaded by config loader) |
| `eventStore` | `Object` | Yes | Event store service instance (for audit logging) |
| `promptAdapterFactory` | `PromptAdapterFactory` | Yes | Factory that maps model names to adapters |

The constructor does not perform I/O. Config is validated on construction; invalid config throws synchronously.

---

## `registerProvider(provider: LLMProvider): void`

Register a provider instance with the service. Called once per provider at startup, before any `complete()` calls.

- Providers must be registered before the first request arrives
- Registering a provider with a duplicate `name` replaces the previous registration
- Does not validate provider availability at registration time

---

## `complete(request: LLMRequest, context: LLMCallContext): Promise<LLMResponse>`

The single entry point for all LLM calls across the platform. Routes the request, handles retries and fallback, parses structured output, and logs the call.

**Execution sequence**:
1. Resolve provider + model from `request.taskType` (default provider first, then fallback)
2. Check provider availability (with timeout)
3. Get prompt adapter for the resolved model
4. Format messages via adapter
5. Inject structured output instruction if `request.structuredOutput` is provided
6. Acquire concurrency slot for the provider (blocks if at limit)
7. Execute `provider.complete(adaptedRequest)` with request-level timeout
8. On success: parse structured output (if requested), calculate latency, log to event store, return response
9. On transient failure: retry with exponential backoff (rate-limit errors use 2× backoff multiplier)
10. On retry budget exhaustion: attempt fallback providers (same flow from step 2)
11. On all providers exhausted: throw `LLM_CALL_FAILED`

**Error codes thrown**:

| Code | Condition |
|------|-----------|
| `NO_PROVIDER_AVAILABLE` | No registered provider has a route for the requested task type, or all available providers are unavailable |
| `LLM_CALL_FAILED` | All retries and fallback attempts failed; `cause` contains the last error |
| `STRUCTURED_OUTPUT_PARSE_ERROR` | Provider returned content that could not be parsed as JSON; `rawContent` field contains the raw response |

**Guaranteed behaviors**:
- A logging failure NEVER causes `complete()` to throw or return an error — the LLM response is always returned if the provider call succeeded
- `response.latencyMs` reflects total wall-clock time from `complete()` entry to return, including all retry delays
- `response.provider` reflects the provider that ultimately succeeded (fallback provider name, not default, if fallback was used)
- `response.model` reflects the model that was actually used

---

## Concurrency Behavior

Each provider has a configurable maximum concurrent slot count (`max_concurrent` in YAML). When all slots are occupied:
- New `complete()` calls for that provider wait (queue) until a slot is released
- Queued calls respect the same timeout budget as active calls
- If the primary provider's queue is full and a fallback provider has available slots, routing does NOT automatically skip to fallback — the request waits for a slot on the primary provider first (fallback activates only on error, not on queue saturation)

> Note: This behavior may be revisited in a future iteration if queue saturation under high load becomes a problem. Document any changes in a spec amendment.
