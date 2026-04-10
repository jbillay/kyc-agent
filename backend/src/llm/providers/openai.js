'use strict';

/**
 * OpenAIProvider — LLMProvider implementation for the OpenAI API.
 */
class OpenAIProvider {
  /**
   * @param {Object} options
   * @param {string} options.apiKey - OpenAI API key
   * @param {string} [options.baseUrl='https://api.openai.com'] - API base URL
   */
  constructor({ apiKey, baseUrl = 'https://api.openai.com' } = {}) {
    this.name = 'openai';
    this._apiKey = apiKey;
    this._baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * @returns {Object} Common request headers
   */
  _headers() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this._apiKey}`,
    };
  }

  /**
   * Execute a chat completion via OpenAI /v1/chat/completions.
   * @param {import('../types').LLMRequest} request
   * @returns {Promise<import('../types').LLMResponse>}
   */
  async complete(request) {
    const body = {
      model: request.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.1,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
    };

    const response = await fetch(`${this._baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(`OpenAI error ${response.status}: ${text}`);
      err.statusCode = response.status;
      throw err;
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content ?? '',
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      model: data.model ?? request.model,
      provider: this.name,
    };
  }

  /**
   * Check availability by calling /v1/models.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const response = await fetch(`${this._baseUrl}/v1/models`, {
        headers: this._headers(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models from /v1/models.
   * @returns {Promise<string[]>}
   */
  async listModels() {
    try {
      const response = await fetch(`${this._baseUrl}/v1/models`, {
        headers: this._headers(),
      });
      if (!response.ok) return [];
      const data = await response.json();
      return (data.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }
}

module.exports = { OpenAIProvider };
