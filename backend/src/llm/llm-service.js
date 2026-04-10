'use strict';

const { Semaphore } = require('./semaphore');

/**
 * LLMService — single entry point for all LLM calls across the platform.
 *
 * Responsibilities:
 * - Provider management and health checking (with configurable timeout)
 * - Task-type-to-model routing (from config/llm.yaml)
 * - Prompt adaptation via adapters
 * - Retry with exponential backoff (standard and rate-limit extended)
 * - Provider fallback
 * - Per-provider concurrency limiting
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
    /** @type {Map<string, { provider: import('./types').LLMProvider, semaphore: Semaphore }>} */
    this._providers = new Map();

    /** @type {string} */
    this._defaultProviderName = config.default_provider;

    /** @type {Object} routing config: { providerName: { taskType: modelString } } */
    this._routing = config.routing || {};

    /** @type {Object} provider configs: { providerName: { retry, timeout_ms, max_concurrent, ... } } */
    this._providerConfigs = config.providers || {};

    this._eventStore = eventStore;
    this._promptAdapterFactory = promptAdapterFactory;
  }

  /**
   * Register a provider instance. Creates a concurrency Semaphore sized by
   * the provider's max_concurrent config (default: 4).
   * @param {import('./types').LLMProvider} provider
   */
  registerProvider(provider) {
    const cfg = this._providerConfigs[provider.name] || {};
    const limit = cfg.max_concurrent ?? 4;
    this._providers.set(provider.name, {
      provider,
      semaphore: new Semaphore(limit),
    });
  }

  /**
   * Main entry point — complete an LLM request with routing, retry, and logging.
   *
   * @param {import('./types').LLMRequest} request
   * @param {import('./types').LLMCallContext} context
   * @returns {Promise<import('./types').LLMResponse>}
   */
  async complete(request, context) {
    const startTime = Date.now();

    // 1. Resolve provider and model
    const { provider, model, semaphore } = await this._resolveProviderAndModel(request.taskType);

    // 2. Adapt prompt for target model
    const adapter = this._promptAdapterFactory.getAdapter(model);
    let messages = adapter.formatMessages(request.messages);

    // 3. Inject structured output instruction if needed
    if (request.structuredOutput) {
      const instruction = adapter.formatStructuredOutputInstruction(
        request.structuredOutput.schema
      );
      messages = this._injectStructuredOutputInstruction(messages, instruction);
    }

    // 4. Build adapted request
    const adaptedRequest = {
      ...request,
      messages,
      model,
      temperature: request.temperature ?? 0.1,
    };

    // 5. Execute with retry and concurrency control
    const providerConfig = this._providerConfigs[provider.name] || {};
    const maxAttempts = providerConfig.retry?.max_attempts ?? 3;
    const backoffMs = providerConfig.retry?.backoff_ms ?? 1000;
    const timeoutMs = providerConfig.timeout_ms ?? 120000;

    let lastError;
    let nonRetryable = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await semaphore.acquire();
        let response;
        try {
          response = await this._executeWithTimeout(provider, adaptedRequest, timeoutMs);
        } finally {
          semaphore.release();
        }

        // 6. Parse structured output if schema was provided
        if (request.structuredOutput && response.content) {
          response.structured = this._parseStructuredOutput(
            response.content,
            request.structuredOutput
          );
        }

        response.latencyMs = Date.now() - startTime;

        // 7. Log the call
        await this._logCall(request, response, context, attempt);

        return response;
      } catch (err) {
        // Structured output parse errors propagate directly — no retry, no fallback
        if (err.code === 'STRUCTURED_OUTPUT_PARSE_ERROR') throw err;

        lastError = err;
        const isRetryable = this._isRetryable(err);
        const isRateLimited = this._isRateLimited(err);

        if (isRetryable || isRateLimited) {
          if (attempt < maxAttempts) {
            const multiplier = isRateLimited ? 2 : 1;
            const delay = multiplier * backoffMs * Math.pow(2, attempt - 1);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        } else {
          // Non-retryable client error — fail immediately, no fallback
          nonRetryable = true;
          break;
        }
      }
    }

    // Non-retryable errors fail immediately without attempting fallback
    if (nonRetryable) {
      throw Object.assign(
        new Error(`LLM call failed (non-retryable): ${lastError?.message}`),
        { code: 'LLM_CALL_FAILED', cause: lastError }
      );
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
   * Resolve the provider entry and model name for a given task type.
   * Checks provider availability with a configurable timeout.
   *
   * @param {import('./types').LLMTaskType} taskType
   * @returns {Promise<{ provider: import('./types').LLMProvider, model: string, semaphore: Semaphore }>}
   */
  async _resolveProviderAndModel(taskType) {
    // Try default provider first
    const defaultEntry = this._providers.get(this._defaultProviderName);
    if (defaultEntry) {
      const cfg = this._providerConfigs[this._defaultProviderName] || {};
      const available = await this._checkAvailability(
        defaultEntry.provider,
        cfg.availability_timeout_ms ?? 3000
      );
      if (available) {
        const model = this._routing[this._defaultProviderName]?.[taskType];
        if (model) {
          return { provider: defaultEntry.provider, model, semaphore: defaultEntry.semaphore };
        }
      }
    }

    // Fall through to any available provider with a route for this task
    for (const [name, entry] of this._providers) {
      if (name === this._defaultProviderName) continue;
      const model = this._routing[name]?.[taskType];
      if (!model) continue;
      const cfg = this._providerConfigs[name] || {};
      const available = await this._checkAvailability(
        entry.provider,
        cfg.availability_timeout_ms ?? 3000
      );
      if (available) {
        return { provider: entry.provider, model, semaphore: entry.semaphore };
      }
    }

    throw Object.assign(
      new Error(`No available provider for task type: ${taskType}`),
      { code: 'NO_PROVIDER_AVAILABLE' }
    );
  }

  /**
   * Check provider availability with a configurable timeout.
   * A timed-out check returns false (treat as unavailable).
   *
   * @param {import('./types').LLMProvider} provider
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  async _checkAvailability(provider, timeoutMs) {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Availability check timed out')), timeoutMs)
    );
    try {
      return await Promise.race([provider.isAvailable(), timeoutPromise]);
    } catch {
      return false;
    }
  }

  /**
   * Execute a request against a provider with a timeout.
   * @param {import('./types').LLMProvider} provider
   * @param {Object} request
   * @param {number} timeoutMs
   * @returns {Promise<import('./types').LLMResponse>}
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
   * Handles raw JSON and JSON wrapped in markdown code blocks.
   *
   * @param {string} content
   * @param {import('./types').LLMStructuredOutput} spec
   * @returns {Object}
   */
  _parseStructuredOutput(content, spec) {
    let jsonStr = content.trim();

    // Extract JSON from markdown code blocks (```json ... ``` or ``` ... ```)
    const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    try {
      return JSON.parse(jsonStr);
    } catch (err) {
      throw Object.assign(
        new Error(`Failed to parse structured output: ${err.message}`),
        { code: 'STRUCTURED_OUTPUT_PARSE_ERROR', rawContent: content }
      );
    }
  }

  /**
   * Inject structured output instruction into the message list.
   * Appends to the system message or creates one if absent.
   *
   * @param {import('./types').LLMMessage[]} messages
   * @param {string} instruction
   * @returns {import('./types').LLMMessage[]}
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
   * Attempt fallback to non-default providers.
   *
   * @param {import('./types').LLMRequest} request
   * @param {import('./types').LLMCallContext} context
   * @param {number} startTime
   * @returns {Promise<import('./types').LLMResponse|null>}
   */
  async _tryFallback(request, context, startTime) {
    for (const [name, entry] of this._providers) {
      if (name === this._defaultProviderName) continue;
      const model = this._routing[name]?.[request.taskType];
      if (!model) continue;

      const cfg = this._providerConfigs[name] || {};
      const available = await this._checkAvailability(
        entry.provider,
        cfg.availability_timeout_ms ?? 3000
      );
      if (!available) continue;

      try {
        const adapter = this._promptAdapterFactory.getAdapter(model);
        let messages = adapter.formatMessages(request.messages);
        if (request.structuredOutput) {
          const instruction = adapter.formatStructuredOutputInstruction(
            request.structuredOutput.schema
          );
          messages = this._injectStructuredOutputInstruction(messages, instruction);
        }

        const adaptedRequest = {
          ...request,
          messages,
          model,
          temperature: request.temperature ?? 0.1,
        };

        await entry.semaphore.acquire();
        let response;
        try {
          const timeoutMs = cfg.timeout_ms ?? 120000;
          response = await this._executeWithTimeout(entry.provider, adaptedRequest, timeoutMs);
        } finally {
          entry.semaphore.release();
        }

        if (request.structuredOutput && response.content) {
          response.structured = this._parseStructuredOutput(
            response.content,
            request.structuredOutput
          );
        }

        response.latencyMs = Date.now() - startTime;
        await this._logCall(request, response, context, 1, name);
        return response;
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Determine if an error is retryable (network, timeout, 5xx).
   * Rate-limit errors (429) are handled separately via _isRateLimited.
   *
   * @param {Error} err
   * @returns {boolean}
   */
  _isRetryable(err) {
    if (err.name === 'AbortError') return true;
    if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') return true;
    if (err.statusCode && err.statusCode >= 500) return true;
    return false;
  }

  /**
   * Determine if an error is a rate-limit error (429 or rate_limit in message/code).
   * Rate-limit errors use 2× the standard backoff multiplier.
   *
   * @param {Error} err
   * @returns {boolean}
   */
  _isRateLimited(err) {
    if (err.statusCode === 429) return true;
    const msg = (err.message || '').toLowerCase();
    const code = (err.code || '').toLowerCase();
    return msg.includes('rate_limit') || msg.includes('rate limit') ||
           code.includes('rate_limit') || code.includes('rate limit');
  }

  /**
   * Log an LLM call to the event store.
   * Logging failures are silently swallowed — they must not break the LLM response.
   *
   * @param {import('./types').LLMRequest} request
   * @param {import('./types').LLMResponse} response
   * @param {import('./types').LLMCallContext} context
   * @param {number} attempt
   * @param {string} [fallbackProvider]
   */
  async _logCall(request, response, context, attempt, fallbackProvider) {
    if (!this._eventStore || !context?.caseId) return;

    try {
      await this._eventStore.appendEvent(
        context.caseId,
        context.agentType ?? 'unknown',
        context.stepId ?? 'unknown',
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
