'use strict';

const { DefaultAdapter } = require('./prompt-adapters/default');
const { MistralAdapter } = require('./prompt-adapters/mistral');
const { LlamaAdapter } = require('./prompt-adapters/llama');

/**
 * PromptAdapterFactory — maps model names to prompt adapter instances.
 *
 * Uses prefix matching to select the appropriate adapter:
 * - "mistral*" → MistralAdapter
 * - "llama*"   → LlamaAdapter
 * - all others → DefaultAdapter
 *
 * Adapters are singletons within the factory (instantiated once, reused).
 */
class PromptAdapterFactory {
  constructor() {
    this._default = new DefaultAdapter();
    this._mistral = new MistralAdapter();
    this._llama = new LlamaAdapter();
  }

  /**
   * Return the appropriate adapter for the given model name.
   *
   * @param {string} modelName - Model name as configured in llm.yaml routing
   * @returns {DefaultAdapter|MistralAdapter|LlamaAdapter}
   */
  getAdapter(modelName) {
    const lower = (modelName || '').toLowerCase();
    if (lower.startsWith('mistral')) return this._mistral;
    if (lower.startsWith('llama')) return this._llama;
    return this._default;
  }
}

module.exports = { PromptAdapterFactory };
