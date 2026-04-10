'use strict';

/**
 * OllamaProvider — LLMProvider implementation for local Ollama inference.
 *
 * Ollama API Reference:
 * - Chat:        POST /api/chat
 * - List models: GET  /api/tags
 * - Pull model:  POST /api/pull
 * - Health:      GET  /api/tags  (also used for isAvailable)
 *
 * @implements {import('../types').LLMProvider}
 */
class OllamaProvider {
  /**
   * @param {Object} [options]
   * @param {string} [options.baseUrl]       - Ollama server URL (also: base_url)
   * @param {number} [options.timeoutMs]     - Per-request timeout ms (also: timeout_ms), default 120000
   * @param {string[]} [options.requiredModels] - Models to ensure are pulled on initialize()
   */
  constructor({ baseUrl, base_url, timeoutMs, timeout_ms, requiredModels } = {}) {
    this.name = 'ollama';
    this._baseUrl = (baseUrl || base_url || 'http://ollama:11434').replace(/\/$/, '');
    this._timeoutMs = timeoutMs || timeout_ms || 120000;
    this._requiredModels = requiredModels || [];
  }

  /**
   * Ensure all required models are available locally, pulling any that are missing.
   * Fails fast on the first pull error — remaining models are not attempted.
   * Call once at application startup, not per request.
   *
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._requiredModels.length === 0) return;

    const available = await this.listModels();

    for (const model of this._requiredModels) {
      if (available.includes(model)) continue;

      console.log(`[OllamaProvider] Pulling model: ${model} (this may take several minutes)...`);
      await this._pullModel(model);
      console.log(`[OllamaProvider] Model ready: ${model}`);
    }
  }

  /**
   * Execute a chat completion via Ollama /api/chat.
   *
   * @param {import('../types').LLMRequest & { model: string }} request
   * @returns {Promise<import('../types').LLMResponse>}
   */
  async complete(request) {
    const body = {
      model: request.model,
      messages: request.messages,
      stream: false,
      options: {
        temperature: request.temperature ?? 0.1,
        ...(request.maxTokens ? { num_predict: request.maxTokens } : {}),
      },
    };

    const response = await this._fetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(`Ollama error ${response.status}: ${text}`);
      err.statusCode = response.status;
      throw err;
    }

    const data = await response.json();

    return {
      content: data.message?.content ?? '',
      usage: {
        promptTokens: data.prompt_eval_count ?? 0,
        completionTokens: data.eval_count ?? 0,
        totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
      },
      model: data.model ?? request.model,
      provider: this.name,
    };
  }

  /**
   * Check availability by pinging /api/tags.
   * Never throws — returns false on any error.
   *
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const response = await this._fetch('/api/tags', { method: 'GET' }, 5000);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List locally available model names from /api/tags.
   * Never throws — returns [] on any error.
   *
   * @returns {Promise<string[]>}
   */
  async listModels() {
    try {
      const response = await this._fetch('/api/tags', { method: 'GET' }, 10000);
      if (!response.ok) return [];
      const data = await response.json();
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  /**
   * Pull a model from the Ollama registry.
   * Uses a fixed 10-minute timeout — model downloads can be slow.
   *
   * @param {string} modelName
   * @returns {Promise<void>}
   */
  async _pullModel(modelName) {
    const response = await this._fetch(
      '/api/pull',
      {
        method: 'POST',
        body: JSON.stringify({ name: modelName, stream: false }),
      },
      600000 // 10 minutes
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`Failed to pull model ${modelName}: ${errorText}`);
    }
  }

  /**
   * Internal fetch wrapper with timeout (AbortController) and base URL.
   *
   * @param {string} path
   * @param {RequestInit} [options]
   * @param {number} [timeoutMs] - Overrides instance default
   * @returns {Promise<Response>}
   */
  async _fetch(path, options = {}, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs !== undefined ? timeoutMs : this._timeoutMs
    );

    try {
      return await fetch(`${this._baseUrl}${path}`, {
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
