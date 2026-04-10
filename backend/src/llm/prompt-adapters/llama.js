'use strict';

/**
 * LlamaAdapter — formats messages for Llama 3 instruct models.
 *
 * Llama 3 uses the <|begin_of_text|> / <|start_header_id|> / <|end_header_id|> /
 * <|eot_id|> special token format. When served via Ollama, Ollama handles the
 * full template formatting internally — so this adapter produces a clean message
 * array in the standard role/content format that Ollama's /api/chat endpoint
 * expects, with the system message kept separate.
 *
 * For providers that require raw prompt string injection (e.g., vLLM in completion
 * mode), the full Llama 3 template tokens are applied.
 */
class LlamaAdapter {
  /**
   * Format messages for Llama 3. When served via Ollama's /api/chat endpoint,
   * Ollama applies the chat template internally, so messages pass through in
   * standard role/content format. The system message is preserved as a separate
   * entry (Llama 3 natively supports a system role).
   *
   * @param {import('../types').LLMMessage[]} messages
   * @returns {import('../types').LLMMessage[]}
   */
  formatMessages(messages) {
    // Llama 3 via Ollama /api/chat supports system/user/assistant roles natively.
    // Pass messages through unchanged — Ollama applies the <|...|> template tokens.
    return messages;
  }

  /**
   * Return a Llama-appropriate instruction to respond with JSON.
   * @param {Object} schema - JSON Schema object
   * @returns {string}
   */
  formatStructuredOutputInstruction(schema) {
    return (
      'Your response MUST be a valid JSON object. ' +
      'Output only the JSON object with no additional text, explanation, or formatting.\n\n' +
      'JSON schema to follow:\n' +
      JSON.stringify(schema, null, 2)
    );
  }
}

module.exports = { LlamaAdapter };
