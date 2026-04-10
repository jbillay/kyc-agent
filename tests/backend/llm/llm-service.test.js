'use strict';

const { LLMService } = require('../../../backend/src/llm/llm-service');
const { PromptAdapterFactory } = require('../../../backend/src/llm/prompt-adapter-factory');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(overrides = {}) {
  return {
    content: 'hello',
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: overrides.model || 'test-model',
    provider: overrides.provider || 'mock-primary',
    ...overrides,
  };
}

function makeMockProvider(name, { available = true, completeImpl } = {}) {
  return {
    name,
    isAvailable: jest.fn().mockResolvedValue(available),
    listModels: jest.fn().mockResolvedValue([]),
    complete: completeImpl
      ? jest.fn().mockImplementation(completeImpl)
      : jest.fn().mockResolvedValue(makeResponse({ provider: name })),
  };
}

function makeConfig({ defaultProvider = 'primary', routing, providerCfg } = {}) {
  return {
    default_provider: defaultProvider,
    providers: {
      primary: {
        retry: { max_attempts: 3, backoff_ms: 10 },
        timeout_ms: 5000,
        max_concurrent: 10,
        availability_timeout_ms: 500,
        ...(providerCfg?.primary || {}),
      },
      secondary: {
        retry: { max_attempts: 2, backoff_ms: 10 },
        timeout_ms: 5000,
        max_concurrent: 10,
        availability_timeout_ms: 500,
        ...(providerCfg?.secondary || {}),
      },
    },
    routing: routing || {
      primary: {
        reasoning: 'primary-reasoning-model',
        extraction: 'primary-extraction-model',
        screening: 'primary-screening-model',
        classification: 'primary-classification-model',
        summarization: 'primary-summarization-model',
      },
      secondary: {
        reasoning: 'secondary-reasoning-model',
        extraction: 'secondary-extraction-model',
        screening: 'secondary-screening-model',
        classification: 'secondary-classification-model',
        summarization: 'secondary-summarization-model',
      },
    },
  };
}

function makeService({ config, providers = [], eventStore } = {}) {
  const factory = new PromptAdapterFactory();
  const service = new LLMService({
    config: config || makeConfig(),
    eventStore: eventStore || null,
    promptAdapterFactory: factory,
  });
  for (const p of providers) service.registerProvider(p);
  return service;
}

function makeRequest(overrides = {}) {
  return {
    taskType: 'extraction',
    messages: [{ role: 'user', content: 'extract this' }],
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return { caseId: 'case-123', agentType: 'test-agent', stepId: 'step-1', ...overrides };
}

// ---------------------------------------------------------------------------
// Phase 3: US1 — Routing tests
// ---------------------------------------------------------------------------

describe('US1 — Unified LLM Access: routing', () => {
  test('routes extraction request to default provider with correct model', async () => {
    const primary = makeMockProvider('primary');
    const service = makeService({ providers: [primary] });

    await service.complete(makeRequest({ taskType: 'extraction' }), makeContext());

    expect(primary.complete).toHaveBeenCalledTimes(1);
    expect(primary.complete.mock.calls[0][0].model).toBe('primary-extraction-model');
  });

  test.each(['reasoning', 'extraction', 'screening', 'classification', 'summarization'])(
    'routes %s task type to the correct model',
    async (taskType) => {
      const primary = makeMockProvider('primary');
      const service = makeService({ providers: [primary] });

      await service.complete(makeRequest({ taskType }), makeContext());

      expect(primary.complete.mock.calls[0][0].model).toBe(`primary-${taskType}-model`);
    }
  );

  test('applies default temperature 0.1 when not specified in request', async () => {
    const primary = makeMockProvider('primary');
    const service = makeService({ providers: [primary] });

    await service.complete(makeRequest(), makeContext());

    expect(primary.complete.mock.calls[0][0].temperature).toBe(0.1);
  });

  test('respects caller-specified temperature', async () => {
    const primary = makeMockProvider('primary');
    const service = makeService({ providers: [primary] });

    await service.complete(makeRequest({ temperature: 0.7 }), makeContext());

    expect(primary.complete.mock.calls[0][0].temperature).toBe(0.7);
  });

  test('throws NO_PROVIDER_AVAILABLE for task type with no routing entry', async () => {
    const primary = makeMockProvider('primary');
    const config = makeConfig({
      routing: { primary: { reasoning: 'some-model' } }, // only reasoning, not extraction
    });
    const service = makeService({ config, providers: [primary] });

    await expect(
      service.complete(makeRequest({ taskType: 'extraction' }), makeContext())
    ).rejects.toMatchObject({ code: 'NO_PROVIDER_AVAILABLE' });
  });

  test('throws NO_PROVIDER_AVAILABLE when no providers are registered', async () => {
    const service = makeService({ providers: [] });

    await expect(
      service.complete(makeRequest(), makeContext())
    ).rejects.toMatchObject({ code: 'NO_PROVIDER_AVAILABLE' });
  });

  test('registerProvider replaces a provider with the same name', async () => {
    const primary1 = makeMockProvider('primary');
    const primary2 = makeMockProvider('primary');
    const service = makeService({ providers: [primary1] });
    service.registerProvider(primary2);

    await service.complete(makeRequest(), makeContext());

    expect(primary1.complete).not.toHaveBeenCalled();
    expect(primary2.complete).toHaveBeenCalledTimes(1);
  });

  test('prefers default provider over secondary when both available', async () => {
    const primary = makeMockProvider('primary');
    const secondary = makeMockProvider('secondary');
    const service = makeService({ providers: [primary, secondary] });

    await service.complete(makeRequest(), makeContext());

    expect(primary.complete).toHaveBeenCalledTimes(1);
    expect(secondary.complete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 4: US2 — Retry and Provider Fallback tests
// ---------------------------------------------------------------------------

describe('US2 — Retry and Provider Fallback', () => {
  // Helper: mock setTimeout to execute immediately and capture delays
  function mockSetTimeoutImmediate(captureDelays = null) {
    return jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms) => {
      if (captureDelays !== null && ms > 0) captureDelays.push(ms);
      // Execute the callback on the next tick so the event loop processes correctly
      Promise.resolve().then(fn);
      return { unref: () => {} };
    });
  }

  test('retries on transient error and succeeds on third attempt', async () => {
    let attempts = 0;
    const primary = makeMockProvider('primary', {
      completeImpl: () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('connection reset');
          err.code = 'ECONNRESET';
          throw err;
        }
        return makeResponse({ provider: 'primary' });
      },
    });

    const spy = mockSetTimeoutImmediate();
    const service = makeService({ providers: [primary] });
    const response = await service.complete(makeRequest(), makeContext());
    spy.mockRestore();

    expect(response.content).toBe('hello');
    expect(attempts).toBe(3);
  });

  test('uses standard backoff for transient errors', async () => {
    const delays = [];
    let attempts = 0;
    const primary = makeMockProvider('primary', {
      completeImpl: () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('server error');
          err.statusCode = 503;
          throw err;
        }
        return makeResponse({ provider: 'primary' });
      },
    });

    const spy = mockSetTimeoutImmediate(delays);
    const service = makeService({ providers: [primary] });
    await service.complete(makeRequest(), makeContext());
    spy.mockRestore();

    // Filter out infrastructure timeouts (availability check 500ms, exec timeout 5000ms)
    // Only backoff delays (multiples of backoff_ms=10) remain
    const backoffDelays = delays.filter((d) => d < 100);
    // Backoff 10ms: attempt 1 delay = 10*2^0=10, attempt 2 delay = 10*2^1=20
    expect(backoffDelays[0]).toBe(10);
    expect(backoffDelays[1]).toBe(20);
  });

  test('uses 2x extended backoff for rate-limit errors', async () => {
    const delays = [];
    let attempts = 0;
    const primary = makeMockProvider('primary', {
      completeImpl: () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error('rate limit exceeded');
          err.statusCode = 429;
          throw err;
        }
        return makeResponse({ provider: 'primary' });
      },
    });

    const spy = mockSetTimeoutImmediate(delays);
    const service = makeService({ providers: [primary] });
    await service.complete(makeRequest(), makeContext());
    spy.mockRestore();

    // Filter out infrastructure timeouts (availability check 500ms, exec timeout 5000ms)
    // Only backoff delays (multiples of backoff_ms=10) remain
    const backoffDelays = delays.filter((d) => d < 100);
    // Rate-limit 2x backoff 10ms: attempt 1 = 2*10*2^0=20, attempt 2 = 2*10*2^1=40
    expect(backoffDelays[0]).toBe(20);
    expect(backoffDelays[1]).toBe(40);
  });

  test('rate-limit error detected by message content', async () => {
    let attempts = 0;
    const primary = makeMockProvider('primary', {
      completeImpl: () => {
        attempts++;
        if (attempts < 2) throw new Error('rate_limit: too many requests');
        return makeResponse({ provider: 'primary' });
      },
    });

    const spy = mockSetTimeoutImmediate();
    const service = makeService({ providers: [primary] });
    const response = await service.complete(makeRequest(), makeContext());
    spy.mockRestore();

    expect(response.content).toBe('hello');
    expect(attempts).toBe(2);
  });

  test('does not retry on non-retryable 4xx error', async () => {
    let attempts = 0;
    const primary = makeMockProvider('primary', {
      completeImpl: () => {
        attempts++;
        const err = new Error('bad request');
        err.statusCode = 400;
        throw err;
      },
    });
    const secondary = makeMockProvider('secondary');

    const service = makeService({ providers: [primary, secondary] });

    await expect(service.complete(makeRequest(), makeContext())).rejects.toMatchObject({
      code: 'LLM_CALL_FAILED',
    });
    expect(attempts).toBe(1);
    // Secondary must NOT be called — non-retryable errors skip fallback
    expect(secondary.complete).not.toHaveBeenCalled();
  });

  test('falls back to secondary provider when primary fails all retries', async () => {
    const primary = makeMockProvider('primary', {
      completeImpl: () => {
        const err = new Error('ECONNREFUSED');
        err.code = 'ECONNREFUSED';
        throw err;
      },
    });
    const secondary = makeMockProvider('secondary');

    const spy = mockSetTimeoutImmediate();
    const service = makeService({ providers: [primary, secondary] });
    const response = await service.complete(makeRequest(), makeContext());
    spy.mockRestore();

    expect(response.provider).toBe('secondary');
    expect(secondary.complete).toHaveBeenCalledTimes(1);
  });

  test('throws LLM_CALL_FAILED when all providers fail', async () => {
    const primary = makeMockProvider('primary', {
      completeImpl: () => { throw Object.assign(new Error('fail'), { code: 'ECONNREFUSED' }); },
    });
    const secondary = makeMockProvider('secondary', {
      completeImpl: () => { throw Object.assign(new Error('fail'), { code: 'ECONNREFUSED' }); },
    });

    const spy = mockSetTimeoutImmediate();
    const service = makeService({ providers: [primary, secondary] });
    await expect(service.complete(makeRequest(), makeContext())).rejects.toMatchObject({
      code: 'LLM_CALL_FAILED',
    });
    spy.mockRestore();
  });

  test('treats timed-out availability check as provider unavailable', async () => {
    // Primary availability check hangs longer than timeout
    const primary = {
      name: 'primary',
      isAvailable: () => new Promise(() => {}), // never resolves
      listModels: jest.fn().mockResolvedValue([]),
      complete: jest.fn().mockResolvedValue(makeResponse({ provider: 'primary' })),
    };
    const secondary = makeMockProvider('secondary');

    const config = makeConfig({
      providerCfg: { primary: { availability_timeout_ms: 50 } },
    });
    const service = makeService({ config, providers: [primary, secondary] });

    const response = await service.complete(makeRequest(), makeContext());
    expect(response.provider).toBe('secondary');
    expect(primary.complete).not.toHaveBeenCalled();
  });

  test('concurrent requests beyond max_concurrent queue and all complete', async () => {
    let active = 0;
    let maxActive = 0;
    const primary = makeMockProvider('primary', {
      completeImpl: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return makeResponse({ provider: 'primary' });
      },
    });

    const config = makeConfig({
      providerCfg: { primary: { max_concurrent: 2 } },
    });
    const service = makeService({ config, providers: [primary] });

    // Launch 5 concurrent requests
    const requests = Array.from({ length: 5 }, () =>
      service.complete(makeRequest(), makeContext())
    );

    const results = await Promise.all(requests);
    expect(results).toHaveLength(5);
    // Max concurrent should never exceed the limit
    expect(maxActive).toBeLessThanOrEqual(2);

    jest.useFakeTimers();
  });
});

// ---------------------------------------------------------------------------
// Phase 5: US3 — Structured Output tests
// ---------------------------------------------------------------------------

describe('US3 — Structured Output Extraction', () => {
  const schema = {
    type: 'object',
    properties: { name: { type: 'string' }, score: { type: 'number' } },
    required: ['name'],
  };

  test('parses plain JSON response into response.structured', async () => {
    const primary = makeMockProvider('primary', {
      completeImpl: () =>
        makeResponse({ content: '{"name":"Acme Corp","score":42}', provider: 'primary' }),
    });
    const service = makeService({ providers: [primary] });

    const response = await service.complete(
      makeRequest({ structuredOutput: { schema } }),
      makeContext()
    );

    expect(response.structured).toEqual({ name: 'Acme Corp', score: 42 });
  });

  test('extracts and parses JSON from markdown ```json code block', async () => {
    const jsonContent = '```json\n{"name":"Acme","score":7}\n```';
    const primary = makeMockProvider('primary', {
      completeImpl: () => makeResponse({ content: jsonContent, provider: 'primary' }),
    });
    const service = makeService({ providers: [primary] });

    const response = await service.complete(
      makeRequest({ structuredOutput: { schema } }),
      makeContext()
    );

    expect(response.structured).toEqual({ name: 'Acme', score: 7 });
  });

  test('extracts and parses JSON from plain ``` code block (no language tag)', async () => {
    const jsonContent = '```\n{"name":"Beta Ltd"}\n```';
    const primary = makeMockProvider('primary', {
      completeImpl: () => makeResponse({ content: jsonContent, provider: 'primary' }),
    });
    const service = makeService({ providers: [primary] });

    const response = await service.complete(
      makeRequest({ structuredOutput: { schema } }),
      makeContext()
    );

    expect(response.structured).toEqual({ name: 'Beta Ltd' });
  });

  test('throws STRUCTURED_OUTPUT_PARSE_ERROR with rawContent for non-JSON response', async () => {
    const badContent = 'Sorry, I cannot help with that.';
    const primary = makeMockProvider('primary', {
      completeImpl: () => makeResponse({ content: badContent, provider: 'primary' }),
    });
    const service = makeService({ providers: [primary] });

    await expect(
      service.complete(makeRequest({ structuredOutput: { schema } }), makeContext())
    ).rejects.toMatchObject({
      code: 'STRUCTURED_OUTPUT_PARSE_ERROR',
      rawContent: badContent,
    });
  });

  test('injects structured output instruction into existing system message', async () => {
    const primary = makeMockProvider('primary', {
      completeImpl: () => makeResponse({ content: '{}', provider: 'primary' }),
    });
    const service = makeService({ providers: [primary] });

    await service.complete(
      makeRequest({
        messages: [
          { role: 'system', content: 'You are a KYC agent.' },
          { role: 'user', content: 'extract data' },
        ],
        structuredOutput: { schema },
      }),
      makeContext()
    );

    const sentMessages = primary.complete.mock.calls[0][0].messages;
    const systemMsg = sentMessages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain('You are a KYC agent.');
    expect(systemMsg.content).toContain('JSON');
  });

  test('creates a new system message for structured output instruction when none exists', async () => {
    const primary = makeMockProvider('primary', {
      completeImpl: () => makeResponse({ content: '{}', provider: 'primary' }),
    });
    const service = makeService({ providers: [primary] });

    await service.complete(
      makeRequest({
        messages: [{ role: 'user', content: 'extract data' }],
        structuredOutput: { schema },
      }),
      makeContext()
    );

    const sentMessages = primary.complete.mock.calls[0][0].messages;
    const systemMsg = sentMessages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(systemMsg.content).toContain('JSON');
  });

  test('response.structured is undefined when no structuredOutput requested', async () => {
    const primary = makeMockProvider('primary');
    const service = makeService({ providers: [primary] });

    const response = await service.complete(makeRequest(), makeContext());

    expect(response.structured).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 6: US4 — Audit Logging tests
// ---------------------------------------------------------------------------

describe('US4 — Full Audit Logging', () => {
  function makeEventStore() {
    return { appendEvent: jest.fn().mockResolvedValue(undefined) };
  }

  test('writes llm_call event with correct shape after successful call', async () => {
    const eventStore = makeEventStore();
    const primary = makeMockProvider('primary', {
      completeImpl: (req) => makeResponse({ model: req.model, provider: 'primary' }),
    });
    const service = makeService({ providers: [primary], eventStore });

    const context = makeContext({ caseId: 'case-abc', agentType: 'entity-resolution', stepId: 'step-1' });
    await service.complete(makeRequest({ taskType: 'extraction', temperature: 0.2 }), context);

    expect(eventStore.appendEvent).toHaveBeenCalledTimes(1);
    const [caseId, agentType, stepId, eventType, payload] = eventStore.appendEvent.mock.calls[0];

    expect(caseId).toBe('case-abc');
    expect(agentType).toBe('entity-resolution');
    expect(stepId).toBe('step-1');
    expect(eventType).toBe('llm_call');
    expect(payload.provider).toBe('primary');
    expect(payload.model).toBe('primary-extraction-model');
    expect(payload.taskType).toBe('extraction');
    expect(payload.attempt).toBe(1);
    expect(payload.request.temperature).toBe(0.2);
    expect(payload.request.messages).toBeDefined();
    expect(payload.response.content).toBe('hello');
    expect(payload.response.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(typeof payload.response.latencyMs).toBe('number');
  });

  test('returns LLM response even when event store throws', async () => {
    const eventStore = { appendEvent: jest.fn().mockRejectedValue(new Error('DB down')) };
    const primary = makeMockProvider('primary');
    const service = makeService({ providers: [primary], eventStore });

    // Should not throw despite event store failure
    const response = await service.complete(makeRequest(), makeContext());
    expect(response.content).toBe('hello');
  });

  test('records fallback provider name (not default) when fallback is used', async () => {
    const eventStore = makeEventStore();
    const primary = makeMockProvider('primary', {
      completeImpl: () => { throw Object.assign(new Error('fail'), { code: 'ECONNREFUSED' }); },
    });
    const secondary = makeMockProvider('secondary');
    const service = makeService({ providers: [primary, secondary], eventStore });

    // Mock setTimeout to execute immediately so retries don't delay the test
    const spy = jest.spyOn(global, 'setTimeout').mockImplementation((fn) => {
      Promise.resolve().then(fn);
      return { unref: () => {} };
    });
    await service.complete(makeRequest(), makeContext());
    spy.mockRestore();

    const payload = eventStore.appendEvent.mock.calls[0][4];
    expect(payload.provider).toBe('secondary');
  });

  test('does not call appendEvent when caseId is absent from context', async () => {
    const eventStore = makeEventStore();
    const primary = makeMockProvider('primary');
    const service = makeService({ providers: [primary], eventStore });

    // Pass context without caseId — logging should be silently skipped
    await service.complete(makeRequest(), { agentType: 'test', stepId: 'step-1' });

    expect(eventStore.appendEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Phase 7: Polish — End-to-end smoke test
// ---------------------------------------------------------------------------

describe('End-to-end smoke test', () => {
  test('full pipeline: routing → adapter → structured output → log → LLMResponse', async () => {
    const eventStore = { appendEvent: jest.fn().mockResolvedValue(undefined) };

    const schema = { type: 'object', properties: { result: { type: 'string' } } };
    const mockProvider = makeMockProvider('ollama', {
      completeImpl: () =>
        makeResponse({
          content: '{"result":"extracted"}',
          model: 'llama3.1:8b',
          provider: 'ollama',
        }),
    });

    const config = {
      default_provider: 'ollama',
      providers: {
        ollama: {
          retry: { max_attempts: 3, backoff_ms: 100 },
          timeout_ms: 30000,
          max_concurrent: 4,
          availability_timeout_ms: 3000,
        },
      },
      routing: {
        ollama: {
          reasoning: 'llama3.1:70b',
          extraction: 'llama3.1:8b',
          screening: 'llama3.1:8b',
          classification: 'llama3.1:8b',
          summarization: 'llama3.1:8b',
        },
      },
    };

    const factory = new PromptAdapterFactory();
    const service = new LLMService({ config, eventStore, promptAdapterFactory: factory });
    service.registerProvider(mockProvider);

    const request = {
      taskType: 'extraction',
      messages: [
        { role: 'system', content: 'You are a KYC specialist.' },
        { role: 'user', content: 'Extract the entity name.' },
      ],
      structuredOutput: { schema },
    };

    const response = await service.complete(request, {
      caseId: 'case-smoke-001',
      agentType: 'entity-resolution',
      stepId: 'extract-name',
    });

    // Correct routing
    expect(mockProvider.complete.mock.calls[0][0].model).toBe('llama3.1:8b');

    // Structured output parsed
    expect(response.structured).toEqual({ result: 'extracted' });
    expect(response.content).toBe('{"result":"extracted"}');

    // All response fields populated
    expect(response.model).toBe('llama3.1:8b');
    expect(response.provider).toBe('ollama');
    expect(typeof response.latencyMs).toBe('number');
    expect(response.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });

    // Audit log written
    expect(eventStore.appendEvent).toHaveBeenCalledTimes(1);
    expect(eventStore.appendEvent.mock.calls[0][3]).toBe('llm_call');
    expect(eventStore.appendEvent.mock.calls[0][4].response.structured).toEqual({ result: 'extracted' });
  });
});
