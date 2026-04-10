'use strict';

const ANTHROPIC_API_BASE = 'https://api.anthropic.com';
const ANTHROPIC_API_VERSION = '2023-06-01';

/**
 * AnthropicProvider — LLMProvider implementation for the Anthropic Messages API.
 *
 * Anthropic's API separates system prompts from the messages array. This provider
 * extracts system messages from the message list and passes them via the top-level
 * `system` parameter.
 */
class AnthropicProvider {
  /**
   * @param {Object} options
   * @param {string} options.apiKey - Anthropic API key
   * @param {string} [options.baseUrl='https://api.anthropic.com'] - API base URL
   */
  constructor({ apiKey, baseUrl = ANTHROPIC_API_BASE } = {}) {
    this.name = 'anthropic';
    this._apiKey = apiKey;
    this._baseUrl = baseUrl.replace(/\/$/, '');
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this._apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    };
  }

  /**
   * Execute a completion via Anthropic /v1/messages.
   *
   * System messages are extracted and passed as the top-level `system` parameter.
   * The remaining messages must alternate user/assistant.
   *
   * @param {import('../types').LLMRequest} request
   * @returns {Promise<import('../types').LLMResponse>}
   */
  async complete(request) {
    const systemMessages = request.messages.filter((m) => m.role === 'system');
    const conversationMessages = request.messages.filter((m) => m.role !== 'system');

    const body = {
      model: request.model,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.1,
      messages: conversationMessages,
      ...(systemMessages.length > 0
        ? { system: systemMessages.map((m) => m.content).join('\n\n') }
        : {}),
    };

    const response = await fetch(`${this._baseUrl}/v1/messages`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err = new Error(`Anthropic error ${response.status}: ${text}`);
      err.statusCode = response.status;
      throw err;
    }

    const data = await response.json();
    const content = data.content?.find((c) => c.type === 'text')?.text ?? '';

    return {
      content,
      usage: {
        promptTokens: data.usage?.input_tokens ?? 0,
        completionTokens: data.usage?.output_tokens ?? 0,
        totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
      },
      model: data.model ?? request.model,
      provider: this.name,
    };
  }

  /**
   * Check availability by making a minimal API call.
   * Uses /v1/models if available, otherwise checks connectivity via a low-cost probe.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const response = await fetch(`${this._baseUrl}/v1/models`, {
        headers: this._headers(),
      });
      // Anthropic returns 200 or 404 depending on API version — either means reachable
      return response.status < 500;
    } catch {
      return false;
    }
  }

  /**
   * List available Anthropic models.
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

module.exports = { AnthropicProvider };
