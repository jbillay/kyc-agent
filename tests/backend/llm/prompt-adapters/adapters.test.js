'use strict';

const { DefaultAdapter } = require('../../../../backend/src/llm/prompt-adapters/default');
const { MistralAdapter } = require('../../../../backend/src/llm/prompt-adapters/mistral');
const { LlamaAdapter } = require('../../../../backend/src/llm/prompt-adapters/llama');
const { PromptAdapterFactory } = require('../../../../backend/src/llm/prompt-adapter-factory');

const schema = { type: 'object', properties: { name: { type: 'string' } } };

// ---------------------------------------------------------------------------
// DefaultAdapter
// ---------------------------------------------------------------------------

describe('DefaultAdapter', () => {
  const adapter = new DefaultAdapter();

  test('formatMessages returns messages unchanged (passthrough)', () => {
    const messages = [
      { role: 'system', content: 'You are a KYC agent.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    expect(adapter.formatMessages(messages)).toEqual(messages);
  });

  test('formatMessages does not mutate the input array', () => {
    const messages = [{ role: 'user', content: 'test' }];
    const result = adapter.formatMessages(messages);
    expect(result).toBe(messages); // passthrough returns same reference
  });

  test('formatStructuredOutputInstruction returns a non-empty string', () => {
    const instruction = adapter.formatStructuredOutputInstruction(schema);
    expect(typeof instruction).toBe('string');
    expect(instruction.length).toBeGreaterThan(0);
  });

  test('formatStructuredOutputInstruction includes the schema', () => {
    const instruction = adapter.formatStructuredOutputInstruction(schema);
    expect(instruction).toContain('"type"');
    expect(instruction).toContain('"object"');
  });

  test('formatStructuredOutputInstruction mentions JSON', () => {
    const instruction = adapter.formatStructuredOutputInstruction(schema);
    expect(instruction.toLowerCase()).toContain('json');
  });

  // T007 [US2] — null/empty schema guard
  test('formatStructuredOutputInstruction throws for null schema', () => {
    expect(() => adapter.formatStructuredOutputInstruction(null)).toThrow('schema is required');
  });

  test('formatStructuredOutputInstruction throws for undefined schema', () => {
    expect(() => adapter.formatStructuredOutputInstruction(undefined)).toThrow('schema is required');
  });

  test('formatStructuredOutputInstruction throws for empty object schema', () => {
    expect(() => adapter.formatStructuredOutputInstruction({})).toThrow('schema is required');
  });
});

// ---------------------------------------------------------------------------
// MistralAdapter
// ---------------------------------------------------------------------------

describe('MistralAdapter', () => {
  const adapter = new MistralAdapter();

  test('formatMessages prepends system content to the first user message', () => {
    const messages = [
      { role: 'system', content: 'System prompt.' },
      { role: 'user', content: 'User message.' },
    ];
    const result = adapter.formatMessages(messages);
    const userMsg = result.find((m) => m.role === 'user');
    expect(userMsg.content).toContain('System prompt.');
    expect(userMsg.content).toContain('User message.');
  });

  test('formatMessages removes the standalone system message', () => {
    const messages = [
      { role: 'system', content: 'System prompt.' },
      { role: 'user', content: 'User message.' },
    ];
    const result = adapter.formatMessages(messages);
    expect(result.find((m) => m.role === 'system')).toBeUndefined();
  });

  test('formatMessages passes through assistant messages unchanged', () => {
    const messages = [
      { role: 'user', content: 'Question?' },
      { role: 'assistant', content: 'Answer.' },
      { role: 'user', content: 'Follow-up?' },
    ];
    const result = adapter.formatMessages(messages);
    const assistant = result.find((m) => m.role === 'assistant');
    expect(assistant.content).toBe('Answer.');
  });

  test('formatMessages handles messages with no system message', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const result = adapter.formatMessages(messages);
    expect(result).toEqual(messages);
  });

  // T003 [US1] — system-only messages must flush as a user message
  test('formatMessages converts system-only messages to a single user message', () => {
    const messages = [{ role: 'system', content: 'Only a system prompt.' }];
    const result = adapter.formatMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('Only a system prompt.');
  });

  // T016 [US4] — multiple consecutive system messages concatenated into first user
  test('formatMessages concatenates multiple system messages into the first user message', () => {
    const messages = [
      { role: 'system', content: 'Part A.' },
      { role: 'system', content: 'Part B.' },
      { role: 'user', content: 'User turn.' },
    ];
    const result = adapter.formatMessages(messages);
    expect(result.find((m) => m.role === 'system')).toBeUndefined();
    const userMsg = result.find((m) => m.role === 'user');
    expect(userMsg.content).toContain('Part A.');
    expect(userMsg.content).toContain('Part B.');
    expect(userMsg.content).toContain('User turn.');
  });

  // T015 [US4] — multi-turn: system merged only into first user; subsequent turns unchanged
  test('formatMessages merges system into first user only in multi-turn conversation', () => {
    const messages = [
      { role: 'system', content: 'Sys.' },
      { role: 'user', content: 'First user.' },
      { role: 'assistant', content: 'First assistant.' },
      { role: 'user', content: 'Second user.' },
    ];
    const result = adapter.formatMessages(messages);
    expect(result.find((m) => m.role === 'system')).toBeUndefined();
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('Sys.');
    expect(result[0].content).toContain('First user.');
    expect(result[1]).toEqual({ role: 'assistant', content: 'First assistant.' });
    expect(result[2]).toEqual({ role: 'user', content: 'Second user.' });
  });

  test('formatStructuredOutputInstruction returns a non-empty string mentioning JSON', () => {
    const instruction = adapter.formatStructuredOutputInstruction(schema);
    expect(typeof instruction).toBe('string');
    expect(instruction.length).toBeGreaterThan(0);
    expect(instruction.toLowerCase()).toContain('json');
  });

  // T007 [US2] — null/empty schema guard
  test('formatStructuredOutputInstruction throws for null schema', () => {
    expect(() => adapter.formatStructuredOutputInstruction(null)).toThrow('schema is required');
  });

  test('formatStructuredOutputInstruction throws for undefined schema', () => {
    expect(() => adapter.formatStructuredOutputInstruction(undefined)).toThrow('schema is required');
  });

  test('formatStructuredOutputInstruction throws for empty object schema', () => {
    expect(() => adapter.formatStructuredOutputInstruction({})).toThrow('schema is required');
  });
});

// ---------------------------------------------------------------------------
// LlamaAdapter
// ---------------------------------------------------------------------------

describe('LlamaAdapter', () => {
  const adapter = new LlamaAdapter();

  test('formatMessages passes messages through unchanged when system message present (Ollama handles template)', () => {
    const messages = [
      { role: 'system', content: 'System.' },
      { role: 'user', content: 'User.' },
      { role: 'assistant', content: 'Assistant.' },
    ];
    expect(adapter.formatMessages(messages)).toEqual(messages);
  });

  // T002 [US1] — must fail before implementation
  test('formatMessages prepends default system message when none present', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const result = adapter.formatMessages(messages);
    expect(result[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    expect(result.slice(1)).toEqual(messages);
  });

  // T002 [US1] — user-only messages (no assistant)
  test('formatMessages prepends default system message when only user messages present', () => {
    const messages = [{ role: 'user', content: 'Question?' }];
    const result = adapter.formatMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('You are a helpful assistant.');
    expect(result[1]).toEqual(messages[0]);
  });

  // T017 [US4] — multi-turn with system present
  test('formatMessages passes multi-turn conversation unchanged when system message present', () => {
    const messages = [
      { role: 'system', content: 'You are a KYC agent.' },
      { role: 'user', content: 'Analyse this entity.' },
      { role: 'assistant', content: 'Sure, analysing now.' },
      { role: 'user', content: 'What is the risk?' },
    ];
    expect(adapter.formatMessages(messages)).toEqual(messages);
  });

  test('formatStructuredOutputInstruction returns a non-empty string mentioning JSON', () => {
    const instruction = adapter.formatStructuredOutputInstruction(schema);
    expect(typeof instruction).toBe('string');
    expect(instruction.length).toBeGreaterThan(0);
    expect(instruction.toLowerCase()).toContain('json');
  });

  // T007 [US2] — null/empty schema guard
  test('formatStructuredOutputInstruction throws for null schema', () => {
    expect(() => adapter.formatStructuredOutputInstruction(null)).toThrow('schema is required');
  });

  test('formatStructuredOutputInstruction throws for undefined schema', () => {
    expect(() => adapter.formatStructuredOutputInstruction(undefined)).toThrow('schema is required');
  });

  test('formatStructuredOutputInstruction throws for empty object schema', () => {
    expect(() => adapter.formatStructuredOutputInstruction({})).toThrow('schema is required');
  });
});

// ---------------------------------------------------------------------------
// PromptAdapterFactory
// ---------------------------------------------------------------------------

describe('PromptAdapterFactory', () => {
  const factory = new PromptAdapterFactory();

  test('returns MistralAdapter for "mistral:7b" model', () => {
    expect(factory.getAdapter('mistral:7b')).toBeInstanceOf(MistralAdapter);
  });

  test('returns MistralAdapter for "mistral-nemo" model', () => {
    expect(factory.getAdapter('mistral-nemo')).toBeInstanceOf(MistralAdapter);
  });

  test('returns LlamaAdapter for "llama3.1:70b" model', () => {
    expect(factory.getAdapter('llama3.1:70b')).toBeInstanceOf(LlamaAdapter);
  });

  test('returns LlamaAdapter for "llama2:13b" model', () => {
    expect(factory.getAdapter('llama2:13b')).toBeInstanceOf(LlamaAdapter);
  });

  test('returns DefaultAdapter for "gpt-4o" model', () => {
    expect(factory.getAdapter('gpt-4o')).toBeInstanceOf(DefaultAdapter);
  });

  test('returns DefaultAdapter for "claude-sonnet-4-6" model', () => {
    expect(factory.getAdapter('claude-sonnet-4-6')).toBeInstanceOf(DefaultAdapter);
  });

  test('returns DefaultAdapter for empty model name', () => {
    expect(factory.getAdapter('')).toBeInstanceOf(DefaultAdapter);
  });

  test('returns DefaultAdapter for undefined model name', () => {
    expect(factory.getAdapter(undefined)).toBeInstanceOf(DefaultAdapter);
  });

  test('returns the same adapter instance on repeated calls (singleton)', () => {
    expect(factory.getAdapter('llama3.1:8b')).toBe(factory.getAdapter('llama3.1:70b'));
    expect(factory.getAdapter('mistral:7b')).toBe(factory.getAdapter('mistral-nemo'));
  });

  // T012 [US3] — mixtral prefix and case-insensitivity
  test('returns MistralAdapter for "mixtral:8x7b" model', () => {
    expect(factory.getAdapter('mixtral:8x7b')).toBeInstanceOf(MistralAdapter);
  });

  test('returns MistralAdapter for "mixtral:8x22b" model', () => {
    expect(factory.getAdapter('mixtral:8x22b')).toBeInstanceOf(MistralAdapter);
  });

  test('returns MistralAdapter for mixed-case "Mistral-Nemo:12B"', () => {
    expect(factory.getAdapter('Mistral-Nemo:12B')).toBeInstanceOf(MistralAdapter);
  });

  test('returns LlamaAdapter for mixed-case "LLama3:8b"', () => {
    expect(factory.getAdapter('LLama3:8b')).toBeInstanceOf(LlamaAdapter);
  });

  test('mixtral and mistral models return the same MistralAdapter instance (singleton)', () => {
    expect(factory.getAdapter('mixtral:8x7b')).toBe(factory.getAdapter('mistral:7b'));
  });
});
