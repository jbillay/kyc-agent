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

  test('formatStructuredOutputInstruction returns a non-empty string mentioning JSON', () => {
    const instruction = adapter.formatStructuredOutputInstruction(schema);
    expect(typeof instruction).toBe('string');
    expect(instruction.length).toBeGreaterThan(0);
    expect(instruction.toLowerCase()).toContain('json');
  });
});

// ---------------------------------------------------------------------------
// LlamaAdapter
// ---------------------------------------------------------------------------

describe('LlamaAdapter', () => {
  const adapter = new LlamaAdapter();

  test('formatMessages passes messages through unchanged (Ollama handles template)', () => {
    const messages = [
      { role: 'system', content: 'System.' },
      { role: 'user', content: 'User.' },
      { role: 'assistant', content: 'Assistant.' },
    ];
    expect(adapter.formatMessages(messages)).toEqual(messages);
  });

  test('formatStructuredOutputInstruction returns a non-empty string mentioning JSON', () => {
    const instruction = adapter.formatStructuredOutputInstruction(schema);
    expect(typeof instruction).toBe('string');
    expect(instruction.length).toBeGreaterThan(0);
    expect(instruction.toLowerCase()).toContain('json');
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
});
