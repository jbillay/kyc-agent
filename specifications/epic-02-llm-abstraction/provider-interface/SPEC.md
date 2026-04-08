# LLM Provider Interface and Routing Service

> GitHub Issue: [#8](https://github.com/jbillay/kyc-agent/issues/8)
> Epic: LLM Abstraction Layer (#7)
> Size: L (3-5 days) | Priority: Critical

## Context

The `LLMService` is the single entry point for all LLM interactions across the platform. Agents call `LLMService.complete(request, context)` — they never instantiate providers directly. The service is responsible for:

1. Loading provider configuration from YAML
2. Routing requests to the correct provider based on `taskType`
3. Selecting the appropriate model per task type per provider
4. Adapting prompts to the target model format
5. Handling retries with exponential backoff
6. Falling back to alternate providers if the primary is unavailable
7. Logging every call to the event store

## Requirements

### Functional

1. `LLMProvider` interface defined with JSDoc: `complete(request)`, `isAvailable()`, `listModels()`
2. `LLMService` class loads provider config and routes by task type
3. Request/response types fully specified: `LLMMessage`, `LLMRequest`, `LLMResponse`, `LLMTaskType`
4. Structured output: pass a JSON schema, get a parsed object back
5. Retry with exponential backoff on transient failures
6. Fallback to alternate provider if primary is unavailable

### Non-Functional

- Default temperature: 0.1 (deterministic KYC work)
- Maximum retry attempts: 3 (configurable per provider)
- Backoff: exponential starting at 1000ms (configurable)
- Single-instance `LLMService` (singleton pattern)

## Technical Design

### File: `backend/src/llm/types.js`

```javascript
/**
 * @typedef {Object} LLMMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {Object} LLMStructuredOutput
 * @property {Object} schema - JSON Schema for the expected output
 * @property {boolean} [strict=true] - Whether to enforce schema compliance
 */

/**
 * @typedef {'reasoning'|'extraction'|'screening'|'classification'|'summarization'} LLMTaskType
 *
 * Task type semantics:
 * - reasoning:       Complex analysis, risk assessment, narrative generation
 * - extraction:      Data extraction from documents, structured parsing
 * - screening:       Sanctions/PEP/adverse media analysis
 * - classification:  Risk classification, entity type detection
 * - summarization:   Generating summaries, narratives
 */

/**
 * @typedef {Object} LLMRequest
 * @property {LLMMessage[]} messages
 * @property {LLMStructuredOutput} [structuredOutput]
 * @property {number} [temperature=0.1]
 * @property {number} [maxTokens]
 * @property {LLMTaskType} taskType
 */

/**
 * @typedef {Object} LLMResponse
 * @property {string} content - Raw text response
 * @property {Object} [structured] - Parsed structured output (if schema was provided)
 * @property {{ promptTokens: number, completionTokens: number, totalTokens: number }} usage
 * @property {string} model - Actual model used
 * @property {string} provider - Provider name
 * @property {number} latencyMs
 */

/**
 * Context passed alongside every LLM request for logging purposes.
 *
 * CANONICAL CALLING CONVENTION:
 *   llmService.complete(request, context)
 *
 *   Where `request` is an LLMRequest (with taskType, messages, and optionally
 *   structuredOutput for JSON responses), and `context` is an LLMCallContext.
 *
 *   All agents MUST use `structuredOutput` (not `responseFormat` or `json`)
 *   when requesting structured JSON output from the LLM.
 *
 * @typedef {Object} LLMCallContext
 * @property {string} caseId
 * @property {string} agentType
 * @property {string} stepId
 */

/**
 * LLM Provider Interface — every provider must implement these methods.
 * @typedef {Object} LLMProvider
 * @property {string} name
 * @property {(request: LLMRequest) => Promise<LLMResponse>} complete
 * @property {() => Promise<boolean>} isAvailable
 * @property {() => Promise<string[]>} listModels
 */

const TASK_TYPES = ['reasoning', 'extraction', 'screening', 'classification', 'summarization'];

module.exports = { TASK_TYPES };
```

### File: `backend/src/llm/llm-service.js`

```javascript
const { TASK_TYPES } = require('./types');

/**
 * LLMService — single entry point for all LLM calls.
 *
 * Responsibilities:
 * - Provider management and health checking
 * - Task-type-to-model routing
 * - Prompt adaptation via adapters
 * - Retry with exponential backoff
 * - Provider fallback
 * - Call logging to the event store
 */
class LLMService {
  /**
   * @param {Object} options
   * @param {Object} options.config - Parsed LLM configuration from config/llm.yaml
   * @param {Object} options.eventStore - Event store service for logging
   * @param {Object} options.promptAdapterFactory - Factory to get adapter by model name
   */
  constructor({ config, eventStore, promptAdapterFactory }) {
    /** @type {Map<string, LLMProvider>} */
    this.providers = new Map();

    /** @type {string} */
    this.defaultProviderName = config.default_provider;

    /** @type {Object} routing config from YAML */
    this.routing = config.routing;

    /** @type {Object} provider configs from YAML */
    this.providerConfigs = config.providers;

    this.eventStore = eventStore;
    this.promptAdapterFactory = promptAdapterFactory;
  }

  /**
   * Register a provider instance.
   * @param {LLMProvider} provider
   */
  registerProvider(provider) {
    this.providers.set(provider.name, provider);
  }

  /**
   * Main entry point — complete an LLM request with routing, retry, and logging.
   *
   * @param {LLMRequest} request
   * @param {LLMCallContext} context
   * @returns {Promise<LLMResponse>}
   */
  async complete(request, context) {
    const startTime = Date.now();

    // 1. Resolve provider and model
    const { provider, model } = await this._resolveProviderAndModel(request.taskType);

    // 2. Adapt prompt for target model
    const adapter = this.promptAdapterFactory.getAdapter(model);
    const adaptedMessages = adapter.formatMessages(request.messages);

    // 3. Inject structured output instruction if needed
    let messages = adaptedMessages;
    if (request.structuredOutput) {
      const instruction = adapter.formatStructuredOutputInstruction(request.structuredOutput.schema);
      messages = this._injectStructuredOutputInstruction(messages, instruction);
    }

    // 4. Build adapted request
    const adaptedRequest = {
      ...request,
      messages,
      model,
      temperature: request.temperature ?? 0.1,
    };

    // 5. Execute with retry
    const providerConfig = this.providerConfigs[provider.name] || {};
    const maxAttempts = providerConfig.retry?.max_attempts ?? 3;
    const backoffMs = providerConfig.retry?.backoff_ms ?? 1000;

    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this._executeWithTimeout(
          provider,
          adaptedRequest,
          providerConfig.timeout_ms ?? 120000
        );

        // 6. Parse structured output if schema was provided
        if (request.structuredOutput && response.content) {
          response.structured = this._parseStructuredOutput(response.content, request.structuredOutput);
        }

        response.latencyMs = Date.now() - startTime;

        // 7. Log the call
        await this._logCall(request, response, context, attempt);

        return response;
      } catch (err) {
        lastError = err;
        if (attempt < maxAttempts && this._isRetryable(err)) {
          const delay = backoffMs * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // 8. All retries failed — try fallback provider
    const fallbackResponse = await this._tryFallback(request, context, startTime);
    if (fallbackResponse) return fallbackResponse;

    // 9. No fallback available
    throw Object.assign(
      new Error(`LLM call failed after ${maxAttempts} attempts: ${lastError?.message}`),
      { code: 'LLM_CALL_FAILED', cause: lastError }
    );
  }

  /**
   * Resolve the provider instance and model name for a given task type.
   * @param {LLMTaskType} taskType
   * @returns {Promise<{ provider: LLMProvider, model: string }>}
   */
  async _resolveProviderAndModel(taskType) {
    // Try default provider first
    const defaultProvider = this.providers.get(this.defaultProviderName);
    if (defaultProvider && (await defaultProvider.isAvailable())) {
      const model = this.routing[this.defaultProviderName]?.[taskType];
      if (model) return { provider: defaultProvider, model };
    }

    // Fall through to any available provider with a route for this task
    for (const [name, provider] of this.providers) {
      if (name === this.defaultProviderName) continue;
      const model = this.routing[name]?.[taskType];
      if (model && (await provider.isAvailable())) {
        return { provider, model };
      }
    }

    throw Object.assign(
      new Error(`No available provider for task type: ${taskType}`),
      { code: 'NO_PROVIDER_AVAILABLE' }
    );
  }

  /**
   * Execute a request against a provider with a timeout.
   * @param {LLMProvider} provider
   * @param {Object} request
   * @param {number} timeoutMs
   * @returns {Promise<LLMResponse>}
   */
  async _executeWithTimeout(provider, request, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await provider.complete(request);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse structured JSON output from LLM response text.
   * @param {string} content
   * @param {LLMStructuredOutput} spec
   * @returns {Object}
   */
  _parseStructuredOutput(content, spec) {
    // Extract JSON from response — handle markdown code blocks
    let jsonStr = content;
    const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    try {
      const parsed = JSON.parse(jsonStr);
      // TODO: validate against spec.schema with Joi/ajv if spec.strict
      return parsed;
    } catch (err) {
      throw Object.assign(
        new Error(`Failed to parse structured output: ${err.message}`),
        { code: 'STRUCTURED_OUTPUT_PARSE_ERROR', rawContent: content }
      );
    }
  }

  /**
   * Inject structured output instruction into the message list.
   * Appends to the system message or creates one.
   */
  _injectStructuredOutputInstruction(messages, instruction) {
    const result = [...messages];
    const systemIdx = result.findIndex((m) => m.role === 'system');
    if (systemIdx >= 0) {
      result[systemIdx] = {
        ...result[systemIdx],
        content: result[systemIdx].content + '\n\n' + instruction,
      };
    } else {
      result.unshift({ role: 'system', content: instruction });
    }
    return result;
  }

  /**
   * Attempt fallback to a non-default provider.
   */
  async _tryFallback(request, context, startTime) {
    for (const [name, provider] of this.providers) {
      if (name === this.defaultProviderName) continue;
      const model = this.routing[name]?.[request.taskType];
      if (!model) continue;
      try {
        if (!(await provider.isAvailable())) continue;
        const adapter = this.promptAdapterFactory.getAdapter(model);
        const adaptedRequest = {
          ...request,
          messages: adapter.formatMessages(request.messages),
          model,
          temperature: request.temperature ?? 0.1,
        };
        const response = await provider.complete(adaptedRequest);
        response.latencyMs = Date.now() - startTime;
        await this._logCall(request, response, context, 1, name);
        return response;
      } catch {
        continue; // Try next provider
      }
    }
    return null;
  }

  /**
   * Determine if an error is retryable (network, timeout, 5xx).
   */
  _isRetryable(err) {
    if (err.name === 'AbortError') return true;
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') return true;
    if (err.statusCode && err.statusCode >= 500) return true;
    return false;
  }

  /**
   * Log an LLM call to the event store.
   */
  async _logCall(request, response, context, attempt, fallbackProvider) {
    if (!this.eventStore || !context?.caseId) return;

    try {
      await this.eventStore.appendEvent(
        context.caseId,
        context.agentId || 'unknown',
        context.stepId || 'unknown',
        'llm_call',
        {
          provider: fallbackProvider || response.provider,
          model: response.model,
          taskType: request.taskType,
          attempt,
          request: {
            messages: request.messages,
            temperature: request.temperature ?? 0.1,
            maxTokens: request.maxTokens,
          },
          response: {
            content: response.content,
            structured: response.structured,
            usage: response.usage,
            latencyMs: response.latencyMs,
          },
        }
      );
    } catch (logErr) {
      // Logging failure must not break the LLM call
      console.error('Failed to log LLM call:', logErr.message);
    }
  }
}

module.exports = { LLMService };
```

### Routing Flow

```
Agent calls LLMService.complete(request, context)
  │
  ├─ 1. Resolve provider + model (by taskType + config)
  │     ├─ Try default_provider first
  │     └─ Fall through to any available provider
  │
  ├─ 2. Get prompt adapter for model
  │     └─ Model name → adapter (mistral*, llama*, default)
  │
  ├─ 3. Format messages + inject structured output instruction
  │
  ├─ 4. Execute with timeout
  │     ├─ Success → parse structured output → log → return
  │     └─ Failure → retry with backoff (up to max_attempts)
  │
  ├─ 5. All retries failed → try fallback providers
  │     └─ Same flow for each alternate provider
  │
  └─ 6. No provider succeeded → throw LLM_CALL_FAILED
```

### Structured Output Parsing

When `request.structuredOutput` is provided:

1. The prompt adapter appends schema instructions to the system message
2. After receiving the response, `LLMService` extracts JSON from the raw text
3. JSON is parsed — handles responses wrapped in markdown code blocks (` ```json ... ``` `)
4. If `strict: true`, the parsed object is validated against the JSON Schema (via Joi/ajv)
5. The parsed object is available as `response.structured`

## Interfaces

### LLMService Public API

| Method | Signature | Purpose |
|--------|-----------|---------|
| `constructor` | `({ config, eventStore, promptAdapterFactory })` | Initialize with loaded config |
| `registerProvider` | `(provider: LLMProvider) => void` | Register a provider instance |
| `complete` | `(request: LLMRequest, context: LLMCallContext) => Promise<LLMResponse>` | Route and execute LLM call |

### LLMProvider Contract

| Method | Signature | Purpose |
|--------|-----------|---------|
| `name` | `string` | Unique provider identifier |
| `complete` | `(request: LLMRequest) => Promise<LLMResponse>` | Execute a completion |
| `isAvailable` | `() => Promise<boolean>` | Health check |
| `listModels` | `() => Promise<string[]>` | List available models |

### Type Summary

| Type | Key Fields |
|------|-----------|
| `LLMMessage` | `role` (system/user/assistant), `content` |
| `LLMRequest` | `messages`, `taskType`, `temperature`, `maxTokens`, `structuredOutput` |
| `LLMResponse` | `content`, `structured`, `usage`, `model`, `provider`, `latencyMs` |
| `LLMCallContext` | `caseId`, `agentId`, `stepId` |
| `LLMStructuredOutput` | `schema` (JSON Schema), `strict` |

## Acceptance Criteria

- [ ] `LLMProvider` interface defined in `types.js` with JSDoc: `complete`, `isAvailable`, `listModels`
- [ ] `LLMService` loads provider configuration from config object (loaded from YAML)
- [ ] `LLMService.complete()` routes to correct provider based on `taskType` and `default_provider`
- [ ] Correct model is selected per task type per provider (from `routing` config)
- [ ] Retry with exponential backoff on transient errors (network, timeout, 5xx)
- [ ] Graceful fallback to alternate provider if default is unavailable
- [ ] Structured output: JSON Schema passed → parsed object returned in `response.structured`
- [ ] Handles responses wrapped in markdown code blocks
- [ ] Every call logged to event store with full request/response
- [ ] Logging failures do not break the LLM call
- [ ] All types exported from `types.js`: `LLMMessage`, `LLMRequest`, `LLMResponse`, `LLMTaskType`, `LLMCallContext`
- [ ] Unit tests for routing logic, retry behavior, structured output parsing, and fallback

## Dependencies

- **Depends on**: #12 (YAML config loader — provides config object), #3 (Database — event store for logging)
- **Blocks**: #9 (Ollama provider), #10 (Prompt adaptation), #11 (Call logging), and all agent stories

## Testing Strategy

1. **Routing test**: Configure 2 providers with different task routing, verify correct provider/model selected per task type
2. **Retry test**: Mock provider that fails twice then succeeds — verify 3 attempts with increasing delays
3. **Fallback test**: Mock default provider as unavailable — verify fallback to second provider
4. **Timeout test**: Mock slow provider — verify timeout triggers retry
5. **Structured output parse test**: Test with raw JSON, JSON in code blocks, and invalid JSON
6. **No provider test**: No providers registered — verify `NO_PROVIDER_AVAILABLE` error
7. **Logging test**: Verify event store receives correct `llm_call` event shape
8. **Logging failure test**: Mock event store failure — verify LLM response still returns
