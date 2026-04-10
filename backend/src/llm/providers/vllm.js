'use strict';

/**
 * VLLMProvider — LLMProvider implementation for vLLM self-hosted inference.
 *
 * vLLM exposes an OpenAI-compatible /v1/chat/completions endpoint and a
 * /health endpoint for availability checks. Uses the same request/response
 * mapping as the OpenAI provider.
 */
class VLLMProvider {
  /**
   * @param {Object} options
   * @param {string} options.baseUrl - vLLM server URL (e.g., 'http://vllm:8000')
   * @param {string} [options.apiKey=''] - API key (optional for local deployments)
   */
  constructor({ baseUrl, apiKey = '' } = {}) {
    this.name = 'vllm';
    this._baseUrl = (baseUrl || '').replace(/\/$/, '');
    this._apiKey = apiKey;
  }

  _headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this._apiKey) headers['Authorization'] = `Bearer ${this._apiKey}`;
    return headers;
  }

  /**
   * Execute a chat completion via vLLM /v1/chat/completions.
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
      const err = new Error(`vLLM error ${response.status}: ${text}`);
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
   * Check availability by pinging /health.
   * @returns {Promise<boolean>}
   */
  async isAvailable() {
    try {
      const response = await fetch(`${this._baseUrl}/health`);
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

module.exports = { VLLMProvider };
