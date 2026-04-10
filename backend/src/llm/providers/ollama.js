'use strict';

/**
 * OllamaProvider — LLMProvider implementation for local Ollama inference.
 *
 * Uses Ollama's /api/chat endpoint for completions and /api/tags for availability
 * and model listing. Ollama handles Llama 3 and Mistral chat template formatting
 * internally when using /api/chat — do not pre-apply template tokens.
 */
class OllamaProvider {
  /**
   * @param {Object} options
   * @param {string} [options.baseUrl='http://ollama:11434'] - Ollama server URL
   */
  constructor({ baseUrl = 'http://ollama:11434' } = {}) {
    this.name = 'ollama';
    this._baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Execute a chat completion via Ollama /api/chat.
   * @param {import('../types').LLMRequest} request
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

    const response = await fetch(`${this._baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const response = await fetch(`${this._baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models from /api/tags.
   * @returns {Promise<string[]>}
   */
  async listModels() {
    try {
      const response = await fetch(`${this._baseUrl}/api/tags`);
      if (!response.ok) return [];
      const data = await response.json();
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }
}

module.exports = { OllamaProvider };
