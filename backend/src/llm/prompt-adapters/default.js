'use strict';

/**
 * DefaultAdapter — passthrough adapter for models that use standard OpenAI-style
 * message formatting. Messages are returned unchanged.
 */
class DefaultAdapter {
  /**
   * Return messages unchanged — standard chat format works as-is.
   * @param {import('../types').LLMMessage[]} messages
   * @returns {import('../types').LLMMessage[]}
   */
  formatMessages(messages) {
    return messages;
  }

  /**
   * Return a plain-English instruction to respond with JSON matching the schema.
   * @param {Object} schema - JSON Schema object
   * @returns {string}
   */
  formatStructuredOutputInstruction(schema) {
    return (
      'Respond with valid JSON that matches the following schema. ' +
      'Do not include any text outside the JSON object.\n\n' +
      'Schema:\n' +
      JSON.stringify(schema, null, 2)
    );
  }
}

module.exports = { DefaultAdapter };
