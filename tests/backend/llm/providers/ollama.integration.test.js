'use strict';

/**
 * Integration tests for OllamaProvider.
 *
 * Requires a running Ollama instance. Skipped by default in CI.
 * To run: OLLAMA_INTEGRATION_TEST=1 npx jest ollama.integration.test.js
 *
 * A small model must be available (e.g., tinyllama).
 * Pull it first: docker exec <ollama-container> ollama pull tinyllama
 */

const { OllamaProvider } = require('../../../../backend/src/llm/providers/ollama');

const ENABLED = !!process.env.OLLAMA_INTEGRATION_TEST;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const SMALL_MODEL = process.env.OLLAMA_TEST_MODEL || 'tinyllama';

const maybeDescribe = ENABLED ? describe : describe.skip;

maybeDescribe('OllamaProvider — integration (requires running Ollama)', () => {
  let provider;

  beforeAll(() => {
    provider = new OllamaProvider({ baseUrl: OLLAMA_URL, timeoutMs: 180000 });
  });

  test('isAvailable() returns true', async () => {
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  }, 10000);

  test('listModels() returns a non-empty array', async () => {
    const models = await provider.listModels();
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
  }, 10000);

  test(`complete() with ${SMALL_MODEL} returns content and non-zero token counts`, async () => {
    const result = await provider.complete({
      model: SMALL_MODEL,
      messages: [{ role: 'user', content: 'Say "hello" and nothing else.' }],
      taskType: 'extraction',
      temperature: 0,
      maxTokens: 20,
    });

    expect(typeof result.content).toBe('string');
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.usage.promptTokens).toBeGreaterThan(0);
    expect(result.usage.completionTokens).toBeGreaterThan(0);
    expect(result.usage.totalTokens).toBe(
      result.usage.promptTokens + result.usage.completionTokens
    );
    expect(result.model).toBeDefined();
    expect(result.provider).toBe('ollama');
    expect(result.latencyMs).toBeUndefined(); // LLMService injects this, not the provider
  }, 180000);

  test('initialize() with model already present completes without error', async () => {
    const models = await provider.listModels();
    const existingModel = models[0];
    expect(existingModel).toBeDefined();

    const initProvider = new OllamaProvider({
      baseUrl: OLLAMA_URL,
      requiredModels: [existingModel],
    });

    await expect(initProvider.initialize()).resolves.toBeUndefined();
  }, 30000);
});
