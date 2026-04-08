# Prompt Adaptation System

> GitHub Issue: [#10](https://github.com/jbillay/kyc-agent/issues/10)
> Epic: LLM Abstraction Layer (#7)
> Size: M (1-3 days) | Priority: High

## Context

Different LLM families expect different prompt formats. Mistral uses `[INST]` tags, Llama 3 uses `<|start_header_id|>` headers, and OpenAI-compatible APIs accept raw message arrays. The prompt adaptation system lets agents write prompts once using the standard `LLMMessage` format (`system`/`user`/`assistant` roles), and the correct adapter transforms them to the target model's native format automatically.

The adapter is selected by matching the model name against known patterns. The `LLMService` calls the adapter before forwarding the request to the provider.

## Requirements

### Functional

1. `PromptAdapter` interface with `formatMessages` and `formatStructuredOutputInstruction`
2. Mistral adapter: `[INST]` tag formatting
3. Llama 3 adapter: `<|start_header_id|>` formatting
4. Default adapter: pass-through (messages array as-is)
5. Automatic adapter selection based on model name pattern
6. Structured output instructions formatted per model family

### Non-Functional

- Adapter selection must be O(1) — pattern matching, not iteration
- Adapters are stateless and safe for concurrent use

## Technical Design

### Adapter Selection

| Model Name Pattern | Adapter | Rationale |
|-------------------|---------|-----------|
| `mistral*`, `mixtral*` | `MistralAdapter` | Mistral instruct format |
| `llama*` | `LlamaAdapter` | Llama 3 chat format |
| Everything else | `DefaultAdapter` | OpenAI-compatible message arrays |

Selection is by prefix match — `model.startsWith('mistral')` or `model.startsWith('llama')`.

### File: `backend/src/llm/prompt-adapters/default.js`

```javascript
/**
 * DefaultAdapter — passes messages through unchanged.
 * Used for OpenAI-compatible APIs that accept the standard messages array.
 *
 * @implements {PromptAdapter}
 */
class DefaultAdapter {
  /**
   * Pass messages through unchanged.
   * @param {LLMMessage[]} messages
   * @returns {LLMMessage[]}
   */
  formatMessages(messages) {
    return messages;
  }

  /**
   * Format structured output instruction for OpenAI-compatible models.
   * @param {Object} schema - JSON Schema
   * @returns {string}
   */
  formatStructuredOutputInstruction(schema) {
    return [
      'You must respond with a valid JSON object that conforms to this schema:',
      '```json',
      JSON.stringify(schema, null, 2),
      '```',
      'Respond ONLY with the JSON object. Do not include any other text, explanation, or markdown formatting outside the JSON.',
    ].join('\n');
  }
}

module.exports = { DefaultAdapter };
```

### File: `backend/src/llm/prompt-adapters/mistral.js`

```javascript
/**
 * MistralAdapter — formats prompts for Mistral instruct models.
 *
 * Mistral instruct format:
 *   <s>[INST] {system}\n{user} [/INST] {assistant}</s> [INST] {user} [/INST]
 *
 * When Ollama handles Mistral models, it often applies the template itself.
 * This adapter supports both cases:
 * - For raw HTTP APIs: returns a formatted string
 * - For Ollama/OpenAI-compatible: returns messages array (Ollama applies template)
 *
 * For Ollama usage, we return messages array and let Ollama handle the template.
 *
 * @implements {PromptAdapter}
 */
class MistralAdapter {
  /**
   * Format messages for Mistral instruct models.
   *
   * For Ollama: returns the messages array directly, since Ollama applies
   * the Mistral chat template internally via its modelfile.
   *
   * @param {LLMMessage[]} messages
   * @returns {LLMMessage[]}
   */
  formatMessages(messages) {
    // Ollama applies the Mistral template automatically.
    // We normalize system + first user into a single system message
    // to improve Mistral instruction following.
    const result = [];
    let systemContent = '';

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemContent += (systemContent ? '\n\n' : '') + msg.content;
      } else {
        // If we accumulated system content and this is the first user message,
        // prepend system content to the user message
        if (systemContent && msg.role === 'user' && result.length === 0) {
          result.push({
            role: 'user',
            content: systemContent + '\n\n' + msg.content,
          });
          systemContent = '';
        } else {
          if (systemContent) {
            result.push({ role: 'system', content: systemContent });
            systemContent = '';
          }
          result.push(msg);
        }
      }
    }

    // Edge case: only system messages
    if (systemContent) {
      result.push({ role: 'user', content: systemContent });
    }

    return result;
  }

  /**
   * Format structured output instruction for Mistral models.
   * Mistral responds well to explicit JSON-only instructions.
   * @param {Object} schema - JSON Schema
   * @returns {string}
   */
  formatStructuredOutputInstruction(schema) {
    return [
      'IMPORTANT: Your response must be a single valid JSON object conforming to this schema:',
      JSON.stringify(schema, null, 2),
      '',
      'Rules:',
      '- Output ONLY the JSON object',
      '- Do NOT wrap it in markdown code blocks',
      '- Do NOT include any text before or after the JSON',
      '- Ensure all required fields are present',
    ].join('\n');
  }
}

module.exports = { MistralAdapter };
```

### File: `backend/src/llm/prompt-adapters/llama.js`

```javascript
/**
 * LlamaAdapter — formats prompts for Llama 3 instruct models.
 *
 * Llama 3 chat format (applied by Ollama internally):
 *   <|begin_of_text|>
 *   <|start_header_id|>system<|end_header_id|>\n{system}<|eot_id|>
 *   <|start_header_id|>user<|end_header_id|>\n{user}<|eot_id|>
 *   <|start_header_id|>assistant<|end_header_id|>
 *
 * Like Mistral, Ollama applies the template automatically. This adapter
 * normalizes the message structure for optimal Llama 3 behavior.
 *
 * @implements {PromptAdapter}
 */
class LlamaAdapter {
  /**
   * Format messages for Llama 3 instruct models.
   *
   * Llama 3 handles system messages well natively, so we keep them separate.
   * We ensure there's always a system message (even if empty) because
   * Llama 3 performs better with an explicit system role.
   *
   * @param {LLMMessage[]} messages
   * @returns {LLMMessage[]}
   */
  formatMessages(messages) {
    const hasSystem = messages.some((m) => m.role === 'system');

    if (!hasSystem) {
      return [
        { role: 'system', content: 'You are a helpful assistant.' },
        ...messages,
      ];
    }

    return messages;
  }

  /**
   * Format structured output instruction for Llama 3 models.
   * Llama 3 follows JSON instructions reliably when given explicit formatting.
   * @param {Object} schema - JSON Schema
   * @returns {string}
   */
  formatStructuredOutputInstruction(schema) {
    return [
      'You must respond with valid JSON matching this exact schema:',
      '```json',
      JSON.stringify(schema, null, 2),
      '```',
      '',
      'Output ONLY the JSON object with no additional text or explanation.',
    ].join('\n');
  }
}

module.exports = { LlamaAdapter };
```

### Adapter Factory

The factory is used by `LLMService` to get the correct adapter for a model name.

```javascript
// backend/src/llm/prompt-adapters/factory.js

const { DefaultAdapter } = require('./default');
const { MistralAdapter } = require('./mistral');
const { LlamaAdapter } = require('./llama');

const defaultAdapter = new DefaultAdapter();
const mistralAdapter = new MistralAdapter();
const llamaAdapter = new LlamaAdapter();

/**
 * Prompt adapter factory — returns the correct adapter based on model name.
 */
const promptAdapterFactory = {
  /**
   * Get the appropriate prompt adapter for a model.
   * @param {string} modelName
   * @returns {PromptAdapter}
   */
  getAdapter(modelName) {
    const name = modelName.toLowerCase();

    if (name.startsWith('mistral') || name.startsWith('mixtral')) {
      return mistralAdapter;
    }

    if (name.startsWith('llama')) {
      return llamaAdapter;
    }

    // Default: OpenAI-compatible, Anthropic, or unknown models
    return defaultAdapter;
  },
};

module.exports = { promptAdapterFactory };
```

## Interfaces

### PromptAdapter Contract

| Method | Signature | Purpose |
|--------|-----------|---------|
| `formatMessages` | `(messages: LLMMessage[]) => LLMMessage[] \| string` | Adapt messages to model format |
| `formatStructuredOutputInstruction` | `(schema: Object) => string` | Generate schema instruction text |

### Adapter Factory

| Method | Signature | Purpose |
|--------|-----------|---------|
| `getAdapter` | `(modelName: string) => PromptAdapter` | Select adapter by model name |

### Adapter Selection Rules

| Input Pattern | Adapter | formatMessages Behavior |
|---------------|---------|------------------------|
| `mistral-nemo:12b` | Mistral | Merges system into first user message |
| `mixtral:8x7b` | Mistral | Merges system into first user message |
| `llama3:8b` | Llama | Ensures system message exists |
| `llama3.1:70b` | Llama | Ensures system message exists |
| `gpt-4o` | Default | Pass-through |
| `claude-sonnet-4-20250514` | Default | Pass-through |
| `anything-else` | Default | Pass-through |

## Acceptance Criteria

- [ ] `PromptAdapter` interface defined with JSDoc: `formatMessages(messages)`, `formatStructuredOutputInstruction(schema)`
- [ ] `MistralAdapter`: merges system content into first user message for better instruction following
- [ ] `LlamaAdapter`: ensures a system message is always present
- [ ] `DefaultAdapter`: passes messages through unchanged
- [ ] `promptAdapterFactory.getAdapter(modelName)` returns correct adapter by prefix matching
- [ ] `mistral*` and `mixtral*` → MistralAdapter
- [ ] `llama*` → LlamaAdapter
- [ ] Everything else → DefaultAdapter
- [ ] Structured output instructions appended in model-appropriate format
- [ ] All adapters are stateless singletons (reused across requests)
- [ ] Unit tests for each adapter with sample multi-turn conversations
- [ ] Unit tests for factory selection with various model names

## Dependencies

- **Depends on**: #8 (Provider interface — defines `LLMMessage` type)
- **Blocks**: #8 (LLMService uses the adapter factory)

## Testing Strategy

1. **MistralAdapter tests**:
   - System + user messages → system merged into user
   - Multi-turn conversation → system prepended correctly
   - Only system messages → converted to single user message
   - Structured output instruction → no code blocks, explicit rules

2. **LlamaAdapter tests**:
   - Messages without system → default system message prepended
   - Messages with system → passed through unchanged
   - Structured output instruction → includes code blocks

3. **DefaultAdapter tests**:
   - Messages pass through unchanged (identity transform)
   - Structured output instruction → standard format with code blocks

4. **Factory tests**:
   - `mistral-nemo:12b` → MistralAdapter
   - `mixtral:8x7b` → MistralAdapter
   - `llama3:8b` → LlamaAdapter
   - `llama3.1:70b` → LlamaAdapter
   - `gpt-4o` → DefaultAdapter
   - `claude-sonnet-4-20250514` → DefaultAdapter
   - Case insensitivity: `Mistral-Nemo:12B` → MistralAdapter
