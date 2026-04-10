# Research: LLM Provider Interface and Routing Service

**Branch**: `006-llm-provider-interface` | **Date**: 2026-04-10

## Decision 1: Concurrency Limiting Without a New Dependency

**Decision**: Implement a minimal in-process `Semaphore` class using a counter and a Promise queue. No external library (e.g., `p-limit`, `async`) added.

**Rationale**: The project has no existing concurrency primitives in `package.json`. Adding `p-limit` for a single use case is speculative infrastructure. A counter-based semaphore is ~20 lines, has zero transitive dependencies, and is straightforward to test. The pattern is:
- `acquire()` → if slots available, decrement counter and resolve immediately; else enqueue a resolver
- `release()` → increment counter; dequeue and resolve the next waiter if any

**Alternatives considered**:
- `p-limit` (popular npm package) — rejected; adds a transitive dependency for functionality already expressible in plain JS
- BullMQ job limiting — rejected; this is intra-process limiting within a single worker, not cross-worker job throttling
- No limiting at all — rejected; per clarification Q3, a configurable limit is required to protect the local Ollama GPU instance from concurrent request flooding

**Where used**: `llm-service.js` — one `Semaphore` instance per registered provider, sized by `providers.<name>.max_concurrent` from `config/llm.yaml`.

---

## Decision 2: Rate-Limit Error Detection and Extended Backoff

**Decision**: Detect rate-limit errors by checking for HTTP status code `429` (from providers that surface it), or error messages/codes matching `RATE_LIMIT`, `rate_limit`, `rate limit` (case-insensitive substring). Apply `2×` the standard backoff multiplier for rate-limit retries. Count against the same retry budget as other transient errors.

**Rationale**: Per clarification Q1, rate-limit errors are retryable with extended backoff and count against the retry budget. A `2×` multiplier on top of the normal exponential schedule (e.g., base 1000ms → attempt 1: 2000ms, attempt 2: 4000ms) gives the provider additional recovery time without requiring provider-specific `Retry-After` header parsing (Ollama does not emit these headers). If all retries are exhausted under rate-limiting, fallback to the next provider activates normally.

**Alternatives considered**:
- Parse `Retry-After` header — rejected; Ollama (the primary provider) does not return this header; other providers may, but uniform treatment avoids per-provider special casing in the routing layer
- Treat as non-retryable — rejected; rate limits are transient and recoverable with appropriate wait time
- Same backoff as standard transient errors — rejected; insufficient differentiation risks exhausting the retry budget too quickly under sustained quota pressure

**Error classification summary**:

| Error type | Retryable | Backoff multiplier | Triggers fallback on budget exhaustion |
|---|---|---|---|
| Network (ECONNREFUSED, ECONNRESET) | Yes | 1× standard | Yes |
| Timeout / AbortError | Yes | 1× standard | Yes |
| Server error (5xx equivalent) | Yes | 1× standard | Yes |
| Rate limit (429 / rate_limit code) | Yes | 2× standard | Yes |
| Client error (4xx, non-429) | No | — | No |
| Invalid request / parse error | No | — | No |

---

## Decision 3: Availability Check Timeout Implementation

**Decision**: Implement availability check timeouts using `Promise.race()` between the provider's `isAvailable()` call and a `setTimeout`-based rejection. Timeout duration sourced from `providers.<name>.availability_timeout_ms` in `config/llm.yaml`, defaulting to `3000` (3 seconds) if not specified.

**Rationale**: Per clarification Q4, a timed-out availability check must be treated as "provider unavailable" to prevent routing stalls. `Promise.race()` is the idiomatic Node.js pattern for this — no external library required. The 3-second default is generous enough to account for cold Ollama model loading while tight enough to keep routing decisions fast during degraded conditions.

**Alternatives considered**:
- `AbortController` — rejected for availability checks specifically; adds boilerplate with no benefit since `isAvailable()` implementations are expected to be simple HTTP pings, not streaming operations
- No timeout (hang indefinitely) — rejected per clarification Q4; a hung check blocks all routing for that provider
- Skip availability checks, rely on request-level errors — deferred; this is the Option C from Q4 but not selected; request-level retry/fallback already exists as a safety net, but proactive availability checks prevent wasted retry budget

---

## Decision 4: Prompt Adapter Factory Pattern

**Decision**: `PromptAdapterFactory` maps model names to adapter instances using prefix matching:
- Model name starts with `mistral` → `MistralAdapter`
- Model name starts with `llama` or `llama2` or `llama3` → `LlamaAdapter`
- All others → `DefaultAdapter`

Adapters are singletons within the factory (instantiated once, reused).

**Rationale**: The SPEC.md specifies this exact mapping. Prefix matching is the most stable approach since model versions (e.g., `llama3.1:70b`, `mistral:7b-instruct`) vary but share consistent name prefixes. The factory pattern keeps adapter selection out of `llm-service.js` and makes adding new adapters a one-line factory change.

**Alternatives considered**:
- Exact model name matching — rejected; too brittle across model version strings
- Configuration-driven adapter mapping in YAML — considered but deferred; prefix matching covers all current models without requiring operators to specify adapters per model in config
- Dynamic `require()` by model name — rejected; removes static analyzability and complicates testing

---

## Decision 5: Structured Output Instruction Injection

**Decision**: When `request.structuredOutput` is provided, the prompt adapter appends a JSON instruction to the system message (or creates one). The instruction format is: `"Respond with valid JSON matching this schema: <schema as JSON string>. Do not include any text outside the JSON object."` This is injected before the request is sent, ensuring all models receive the instruction regardless of provider.

**Rationale**: Centralizing this in the adapter layer (via `formatStructuredOutputInstruction`) means each adapter can tune the instruction wording for its model family while the injection logic in `llm-service.js` remains uniform. The response parser then extracts JSON from the text, handling markdown code block wrappers.

**Alternatives considered**:
- Provider-native structured output (e.g., OpenAI `response_format: json_object`) — deferred to provider implementations; Ollama supports this natively via `format: json` but other providers vary; the instruction-injection approach works uniformly across all providers as the baseline
- Per-request instruction customization by agents — rejected; defeats centralization and creates inconsistent structured output behavior across agents

---

## No NEEDS CLARIFICATION items remain

All five research decisions resolve the technical unknowns identified during planning. No external documentation lookups were required — all patterns are expressible using existing Node.js standard library and project dependencies.
