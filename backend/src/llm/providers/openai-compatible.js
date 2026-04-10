'use strict';

const { OpenAIProvider } = require('./openai');

/**
 * OpenAICompatibleProvider — LLMProvider for any OpenAI-compatible API endpoint.
 *
 * Many self-hosted or third-party inference servers (e.g., LM Studio, LocalAI,
 * Together AI) expose an OpenAI-compatible /v1/chat/completions endpoint.
 * This provider reuses OpenAI's request/response mapping with a configurable
 * base URL and provider name.
 */
class OpenAICompatibleProvider extends OpenAIProvider {
  /**
   * @param {Object} options
   * @param {string} options.name - Unique provider identifier (required — no default)
   * @param {string} options.baseUrl - API base URL (required — no default)
   * @param {string} [options.apiKey=''] - API key (optional for local servers)
   */
  constructor({ name, baseUrl, apiKey = '' } = {}) {
    super({ apiKey, baseUrl });
    this.name = name;
  }
}

module.exports = { OpenAICompatibleProvider };
