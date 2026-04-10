'use strict';

/**
 * MistralAdapter — formats messages for Mistral instruct models.
 *
 * Mistral instruct models use the [INST] / [/INST] token format for user turns.
 * System prompts are prepended to the first user message.
 */
class MistralAdapter {
  /**
   * Format messages for Mistral instruct template.
   *
   * Mistral does not have a dedicated system role — system content is prepended
   * to the first user message content, separated by a newline.
   *
   * @param {import('../types').LLMMessage[]} messages
   * @returns {import('../types').LLMMessage[]}
   */
  formatMessages(messages) {
    const result = [];
    let pendingSystem = null;

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Accumulate system content to prepend to the next user message
        pendingSystem = pendingSystem ? pendingSystem + '\n' + msg.content : msg.content;
      } else if (msg.role === 'user') {
        const content = pendingSystem
          ? `${pendingSystem}\n\n${msg.content}`
          : msg.content;
        pendingSystem = null;
        result.push({ role: 'user', content });
      } else {
        // assistant messages pass through unchanged
        result.push(msg);
      }
    }

    return result;
  }

  /**
   * Return a Mistral-appropriate instruction to respond with JSON.
   * @param {Object} schema - JSON Schema object
   * @returns {string}
   */
  formatStructuredOutputInstruction(schema) {
    return (
      'You must respond with a valid JSON object and nothing else. ' +
      'Do not add any explanation, markdown, or text outside the JSON.\n\n' +
      'Required JSON schema:\n' +
      JSON.stringify(schema, null, 2)
    );
  }
}

module.exports = { MistralAdapter };
