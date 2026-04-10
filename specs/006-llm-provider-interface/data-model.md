# Data Model: LLM Provider Interface and Routing Service

**Branch**: `006-llm-provider-interface` | **Date**: 2026-04-10

All types are defined in `backend/src/llm/types.js` as JSDoc `@typedef` blocks. There is no database schema for this layer — the only persisted output is the `llm_call` event written to the existing `decision_events` table via `event-store.js`.

---

## Core Request/Response Types

### `LLMMessage`

A single turn in a conversation.

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `role` | `'system' \| 'user' \| 'assistant'` | Yes | Enum — one of three values |
| `content` | `string` | Yes | Non-empty |

---

### `LLMStructuredOutput`

Attached to a request when the caller wants a parsed JSON object back.

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `schema` | `Object` | Yes | — | Valid JSON Schema object |
| `strict` | `boolean` | No | `true` | When true, validate parsed object against schema |

---

### `LLMRequest`

Submitted by an agent to `LLMService.complete()`.

| Field | Type | Required | Default | Constraints |
|-------|------|----------|---------|-------------|
| `messages` | `LLMMessage[]` | Yes | — | Non-empty array |
| `taskType` | `LLMTaskType` | Yes | — | Must be a valid task type |
| `temperature` | `number` | No | `0.1` | Range: 0.0–2.0 |
| `maxTokens` | `number` | No | — | Provider-specific limit applies |
| `structuredOutput` | `LLMStructuredOutput` | No | — | Omit for free-text responses |

---

### `LLMResponse`

Returned by `LLMService.complete()` to the agent.

| Field | Type | Always present | Notes |
|-------|------|---------------|-------|
| `content` | `string` | Yes | Raw text response from the model |
| `structured` | `Object` | Only if `structuredOutput` was requested | Parsed JSON object |
| `usage.promptTokens` | `number` | Yes | Input token count |
| `usage.completionTokens` | `number` | Yes | Output token count |
| `usage.totalTokens` | `number` | Yes | Sum of prompt + completion |
| `model` | `string` | Yes | Actual model name used (e.g., `llama3.1:70b`) |
| `provider` | `string` | Yes | Provider name (e.g., `ollama`) |
| `latencyMs` | `number` | Yes | Wall-clock time from request start to response |

---

### `LLMCallContext`

Metadata attached to every `complete()` call for audit logging. Not forwarded to the provider.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `caseId` | `string` | Yes | UUID of the KYC case being processed |
| `agentType` | `string` | Yes | Agent identifier (e.g., `entity-resolution`, `screening`) |
| `stepId` | `string` | Yes | Step identifier within the agent's execution sequence |

---

## Task Type Enum

Defined as both a JSDoc typedef and a runtime constant array (`TASK_TYPES`).

| Value | Semantic |
|-------|----------|
| `reasoning` | Complex analysis, risk assessment, narrative generation |
| `extraction` | Structured data extraction from documents or text |
| `screening` | Sanctions/PEP/adverse media hit evaluation |
| `classification` | Risk classification, entity type detection |
| `summarization` | Summary and narrative generation |

---

## Provider Interface

Not a persisted entity — a runtime contract every provider must satisfy.

| Member | Kind | Signature | Notes |
|--------|------|-----------|-------|
| `name` | property | `string` | Unique identifier used in config and logs |
| `complete` | method | `(request: LLMRequest) => Promise<LLMResponse>` | Core inference call |
| `isAvailable` | method | `() => Promise<boolean>` | Health check — must resolve within `availability_timeout_ms` |
| `listModels` | method | `() => Promise<string[]>` | Returns model names the provider can serve |

---

## Configuration Schema (`config/llm.yaml`)

The YAML file consumed by `LLMService` at startup (pre-loaded by the config loader dependency).

```yaml
# config/llm.yaml — annotated schema

default_provider: ollama          # string — must match a key in providers

providers:
  <provider-name>:                # string key — must match LLMProvider.name
    retry:
      max_attempts: 3             # integer — default 3
      backoff_ms: 1000            # integer (ms) — base wait for first retry
    timeout_ms: 120000            # integer (ms) — per-request execution timeout
    max_concurrent: 4             # integer — max simultaneous requests (concurrency limit)
    availability_timeout_ms: 3000 # integer (ms) — availability check timeout; default 3000

routing:
  <provider-name>:
    reasoning: <model-string>      # string — model name passed to provider.complete()
    extraction: <model-string>
    screening: <model-string>
    classification: <model-string>
    summarization: <model-string>
```

**Example** (Ollama as default, OpenAI as fallback):

```yaml
default_provider: ollama

providers:
  ollama:
    retry:
      max_attempts: 3
      backoff_ms: 1000
    timeout_ms: 120000
    max_concurrent: 4
    availability_timeout_ms: 3000
  openai:
    retry:
      max_attempts: 2
      backoff_ms: 500
    timeout_ms: 30000
    max_concurrent: 20
    availability_timeout_ms: 2000

routing:
  ollama:
    reasoning: llama3.1:70b
    extraction: llama3.1:8b
    screening: llama3.1:8b
    classification: llama3.1:8b
    summarization: llama3.1:8b
  openai:
    reasoning: gpt-4o
    extraction: gpt-4o-mini
    screening: gpt-4o-mini
    classification: gpt-4o-mini
    summarization: gpt-4o-mini
```

---

## Event Store Entry Shape

Written to `decision_events` via `event-store.js` for every completed LLM call. See `contracts/event-log-shape.md` for the full shape.

**Event type**: `llm_call`

Key fields logged:
- `provider` — provider name used (fallback provider name if fallback activated)
- `model` — exact model string
- `taskType` — task type from the request
- `attempt` — which attempt succeeded (1 = first try)
- `request.messages` — full message array (unredacted)
- `request.temperature`, `request.maxTokens`
- `response.content` — full raw response text (unredacted)
- `response.structured` — parsed object if structured output was requested
- `response.usage` — token counts
- `response.latencyMs` — end-to-end latency
