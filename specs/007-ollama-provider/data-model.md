# Data Model: Ollama LLM Provider

**Branch**: `007-ollama-provider` | **Date**: 2026-04-10

This feature adds no new database tables or persistent storage. All data shapes are in-memory types defined in `backend/src/llm/types.js` (already established by feature 006).

## OllamaProvider Instance Shape

The provider holds the following internal state after construction:

| Field | Type | Default | Purpose |
|---|---|---|---|
| `name` | `string` | `'ollama'` | Provider identifier used by LLMService routing |
| `_baseUrl` | `string` | `'http://ollama:11434'` | Ollama server URL (trailing slash stripped) |
| `_timeoutMs` | `number` | `120000` | Per-request AbortController timeout in ms |
| `_requiredModels` | `string[]` | `[]` | Models to ensure are pulled during `initialize()` |

## Constructor Config Shape

```
{
  baseUrl?:        string   — Ollama server URL (also accepts base_url for YAML compat)
  timeoutMs?:      number   — Per-request timeout ms (also accepts timeout_ms)
  requiredModels?: string[] — Model names to auto-pull at startup
}
```

## LLMRequest (consumed by `complete()`)

Defined in `backend/src/llm/types.js`. The provider receives the full `LLMRequest` with a `model` field injected by `LLMService` before calling `complete()`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `model` | `string` | yes | Injected by LLMService from routing config |
| `messages` | `LLMMessage[]` | yes | Array of `{ role: 'system'|'user'|'assistant', content: string }` |
| `temperature` | `number` | no | Defaults to `0.1` in LLMService before reaching provider; `0` is valid |
| `maxTokens` | `number` | no | Maps to Ollama `options.num_predict` |
| `taskType` | `LLMTaskType` | yes | Used by LLMService for routing; provider ignores it |

## LLMResponse (returned by `complete()`)

| Field | Type | Notes |
|---|---|---|
| `content` | `string` | From `data.message?.content` — empty string if absent |
| `usage.promptTokens` | `number` | From `data.prompt_eval_count` — `0` if absent |
| `usage.completionTokens` | `number` | From `data.eval_count` — `0` if absent |
| `usage.totalTokens` | `number` | Sum of prompt + completion tokens |
| `model` | `string` | From `data.model` — falls back to `request.model` |
| `provider` | `string` | Always `'ollama'` |
| `latencyMs` | `number` | **Injected by LLMService** after `complete()` returns — provider does NOT set this |

## Ollama API Request/Response Shapes (external dependency)

### POST /api/chat (request)

```json
{
  "model": "llama3.1:8b",
  "messages": [{ "role": "user", "content": "Hello" }],
  "stream": false,
  "options": {
    "temperature": 0.1,
    "num_predict": 512
  }
}
```

### POST /api/chat (response)

```json
{
  "model": "llama3.1:8b",
  "message": { "role": "assistant", "content": "Hi there!" },
  "done": true,
  "prompt_eval_count": 15,
  "eval_count": 8
}
```

### GET /api/tags (response)

```json
{
  "models": [
    { "name": "llama3.1:8b", "size": 4661211136 },
    { "name": "llama3.1:70b", "size": 39969095936 }
  ]
}
```

### POST /api/pull (request)

```json
{
  "name": "llama3.1:8b",
  "stream": false
}
```

## State Transitions: initialize()

```
initialize() called
  │
  ├─ listModels() → [available model names]
  │
  ├─ For each model in requiredModels:
  │   ├─ Already available? → skip (no log)
  │   └─ Missing?
  │       ├─ console.log "[OllamaProvider] Pulling model: <name>..."
  │       ├─ _pullModel(name) [10-min timeout]
  │       │   ├─ Success → console.log "[OllamaProvider] Model ready: <name>"
  │       │   └─ Failure → throw Error (STOP — remaining models not attempted)
  │
  └─ Resolves void (all required models are now available)
```
