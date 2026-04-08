# Ollama LLM Provider

> GitHub Issue: [#9](https://github.com/jbillay/kyc-agent/issues/9)
> Epic: LLM Abstraction Layer (#7)
> Size: M (1-3 days) | Priority: Critical

## Context

Ollama is the default LLM runtime for the KYC Agent platform. It runs locally in Docker, requires no API keys, and supports a wide range of open-source models. The `OllamaProvider` is the first concrete implementation of the `LLMProvider` interface and the only one required for MVP.

Key Ollama behaviors this provider must handle:
- Models must be pulled before first use — the provider should auto-pull configured models
- The `/api/chat` endpoint accepts a messages array and returns a completion
- Token usage is reported in the response metadata
- Ollama can be slow on CPU-only hardware — timeout handling is critical

## Requirements

### Functional

1. Implements the `LLMProvider` interface: `complete`, `isAvailable`, `listModels`
2. Connects to Ollama at a configurable base URL (default `http://ollama:11434`)
3. Uses the `/api/chat` endpoint for completions
4. Auto-pulls models that are not locally available
5. Extracts token usage from the Ollama response
6. Configurable timeout per request

### Non-Functional

- Auto-pull should happen at service initialization (not per-request) to avoid blocking
- Response streaming support designed-in (not required for MVP but the interface should accommodate it)
- Timeout defaults to 120 seconds (large models on CPU can be slow)

## Technical Design

### File: `backend/src/llm/providers/ollama.js`

```javascript
/**
 * OllamaProvider — LLM provider for local Ollama instances.
 *
 * Ollama API Reference:
 * - Chat: POST /api/chat
 * - List models: GET /api/tags
 * - Pull model: POST /api/pull
 * - Health: GET /
 *
 * @implements {LLMProvider}
 */
class OllamaProvider {
  /**
   * @param {Object} config
   * @param {string} [config.baseUrl='http://ollama:11434']
   * @param {number} [config.timeoutMs=120000]
   * @param {string[]} [config.requiredModels] - Models to ensure are pulled on init
   */
  constructor(config = {}) {
    this.name = 'ollama';
    this.baseUrl = config.baseUrl || config.base_url || 'http://ollama:11434';
    this.timeoutMs = config.timeoutMs || config.timeout_ms || 120000;
    this.requiredModels = config.requiredModels || [];
  }

  /**
   * Ensure required models are available locally, pulling if necessary.
   * Call this once at startup — not per request.
   */
  async initialize() {
    const available = await this.listModels();
    for (const model of this.requiredModels) {
      if (!available.includes(model)) {
        console.log(`Pulling Ollama model: ${model} (this may take a while)...`);
        await this._pullModel(model);
        console.log(`Model ${model} pulled successfully.`);
      }
    }
  }

  /**
   * Execute a chat completion.
   *
   * @param {LLMRequest & { model: string }} request
   * @returns {Promise<LLMResponse>}
   */
  async complete(request) {
    const startTime = Date.now();

    const body = {
      model: request.model,
      messages: request.messages,
      stream: false,
      options: {},
    };

    if (request.temperature !== undefined) {
      body.options.temperature = request.temperature;
    }
    if (request.maxTokens) {
      body.options.num_predict = request.maxTokens;
    }

    const response = await this._fetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw Object.assign(
        new Error(`Ollama API error (${response.status}): ${errorText}`),
        { statusCode: response.status }
      );
    }

    const data = await response.json();
    const latencyMs = Date.now() - startTime;

    return {
      content: data.message?.content || '',
      usage: {
        promptTokens: data.prompt_eval_count || 0,
        completionTokens: data.eval_count || 0,
        totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0),
      },
      model: data.model || request.model,
      provider: this.name,
      latencyMs,
    };
  }

  /**
   * Check if Ollama is reachable.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const response = await this._fetch('/', { method: 'GET' }, 5000);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List locally available models.
   * @returns {Promise<string[]>}
   */
  async listModels() {
    try {
      const response = await this._fetch('/api/tags', { method: 'GET' }, 10000);
      if (!response.ok) return [];
      const data = await response.json();
      return (data.models || []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Pull a model from the Ollama registry.
   * @param {string} modelName
   */
  async _pullModel(modelName) {
    const response = await this._fetch('/api/pull', {
      method: 'POST',
      body: JSON.stringify({ name: modelName, stream: false }),
    }, 600000); // 10 minute timeout for model pulls

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to pull model ${modelName}: ${errorText}`);
    }
  }

  /**
   * Internal fetch wrapper with timeout and base URL.
   * @param {string} path
   * @param {RequestInit} options
   * @param {number} [timeoutMs]
   * @returns {Promise<Response>}
   */
  async _fetch(path, options = {}, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs || this.timeoutMs
    );

    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { OllamaProvider };
```

### Ollama API Mapping

| Operation | Ollama Endpoint | Method | Notes |
|-----------|----------------|--------|-------|
| Chat completion | `/api/chat` | POST | `stream: false` for non-streaming |
| Health check | `/` | GET | Returns `200 Ollama is running` |
| List models | `/api/tags` | GET | Returns `{ models: [{ name, ... }] }` |
| Pull model | `/api/pull` | POST | `stream: false`, can take minutes |

### Ollama Response Format

```json
{
  "model": "mistral-nemo:12b",
  "message": {
    "role": "assistant",
    "content": "The response text..."
  },
  "done": true,
  "total_duration": 5000000000,
  "load_duration": 1000000000,
  "prompt_eval_count": 150,
  "prompt_eval_duration": 2000000000,
  "eval_count": 200,
  "eval_duration": 3000000000
}
```

### Token Usage Extraction

| Ollama Field | Maps To |
|-------------|---------|
| `prompt_eval_count` | `usage.promptTokens` |
| `eval_count` | `usage.completionTokens` |
| Sum of both | `usage.totalTokens` |

### Configuration

From `config/llm.yaml` (the `providers.ollama` section):

| Field | Default | Purpose |
|-------|---------|---------|
| `base_url` | `http://ollama:11434` | Ollama API endpoint |
| `timeout_ms` | `120000` | Per-request timeout (ms) |
| `retry.max_attempts` | `3` | Max retries (handled by LLMService) |
| `retry.backoff_ms` | `1000` | Base backoff delay (handled by LLMService) |

### Default Models

| Task Type | Model | Size | Why |
|-----------|-------|------|-----|
| reasoning | `mistral-nemo:12b` | 12B | Best reasoning at this size class, good instruction following |
| extraction | `llama3:8b` | 8B | Fast, reliable structured extraction |
| screening | `mistral-nemo:12b` | 12B | Needs reasoning for hit evaluation |
| classification | `llama3:8b` | 8B | Fast classification tasks |
| summarization | `mistral-nemo:12b` | 12B | Quality narrative generation |

### Initialization Flow

```
App startup
  │
  ├─ Create OllamaProvider with config
  ├─ Register with LLMService
  ├─ Call provider.initialize()
  │   ├─ List locally available models
  │   ├─ For each configured model not available:
  │   │   └─ Pull model (may take several minutes)
  │   └─ Log success/failure
  └─ Ready to accept requests
```

## Interfaces

### OllamaProvider Public API

| Method | Signature | Purpose |
|--------|-----------|---------|
| `constructor` | `(config: { baseUrl?, timeoutMs?, requiredModels? })` | Create provider |
| `initialize` | `() => Promise<void>` | Pull any missing required models |
| `complete` | `(request: LLMRequest & { model }) => Promise<LLMResponse>` | Execute chat completion |
| `isAvailable` | `() => Promise<boolean>` | Check Ollama health |
| `listModels` | `() => Promise<string[]>` | List local models |

## Acceptance Criteria

- [ ] `OllamaProvider` implements the `LLMProvider` interface (`complete`, `isAvailable`, `listModels`)
- [ ] Connects to configurable base URL (default `http://ollama:11434`)
- [ ] `complete()` calls `/api/chat` with `stream: false` and returns parsed `LLMResponse`
- [ ] Token usage extracted: `prompt_eval_count` → `promptTokens`, `eval_count` → `completionTokens`
- [ ] `isAvailable()` returns `true` when Ollama is running, `false` when unreachable
- [ ] `listModels()` returns array of model names from `/api/tags`
- [ ] `initialize()` auto-pulls models from `requiredModels` list if not already available
- [ ] Configurable timeout (default 120s) with `AbortController`
- [ ] Timeout on pull operations set to 10 minutes
- [ ] HTTP errors throw with `statusCode` for retry classification
- [ ] Integration test with a real Ollama instance

## Dependencies

- **Depends on**: #8 (Provider interface defines the contract), #2 (Docker Compose — Ollama container)
- **Blocks**: All agent stories (agents need a working LLM provider)

## Testing Strategy

1. **Unit tests (mocked HTTP)**:
   - `complete()`: Mock `/api/chat` response, verify `LLMResponse` shape and token extraction
   - `isAvailable()`: Mock healthy/unhealthy Ollama, verify boolean return
   - `listModels()`: Mock `/api/tags` response, verify model name extraction
   - `initialize()`: Mock `listModels` + `_pullModel`, verify pull called for missing models only
   - Timeout: Mock a slow response, verify `AbortError` is thrown
   - HTTP error: Mock 500 response, verify error has `statusCode`

2. **Integration tests (requires running Ollama)**:
   - Health check against real Ollama
   - List models from real Ollama
   - Complete a simple prompt with a small model (e.g., `tinyllama`)
   - Verify token usage is non-zero
