'use strict';

const { OllamaProvider } = require('../../../../backend/src/llm/providers/ollama');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock Response object.
 * @param {number} status
 * @param {any} body  - if object, serialised as JSON; if string, returned as text
 * @param {boolean} [ok]
 */
function mockResponse(status, body, ok) {
  const isJson = typeof body === 'object' && body !== null;
  const text = isJson ? JSON.stringify(body) : String(body ?? '');
  return {
    ok: ok !== undefined ? ok : status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(isJson ? body : JSON.parse(text)),
    text: () => Promise.resolve(text),
  };
}

/**
 * Replace the global `fetch` with a Jest spy that returns the given mock response.
 * Returns the spy so tests can make assertions on it.
 */
function mockFetch(response) {
  return jest.spyOn(global, 'fetch').mockResolvedValue(response);
}

// ---------------------------------------------------------------------------
// describe: constructor
// ---------------------------------------------------------------------------

describe('OllamaProvider — constructor', () => {
  test('uses default values when no options passed', () => {
    const p = new OllamaProvider();
    expect(p.name).toBe('ollama');
    expect(p._baseUrl).toBe('http://ollama:11434');
    expect(p._timeoutMs).toBe(120000);
    expect(p._requiredModels).toEqual([]);
  });

  test('accepts camelCase options', () => {
    const p = new OllamaProvider({ baseUrl: 'http://localhost:11434', timeoutMs: 5000, requiredModels: ['llama3.1:8b'] });
    expect(p._baseUrl).toBe('http://localhost:11434');
    expect(p._timeoutMs).toBe(5000);
    expect(p._requiredModels).toEqual(['llama3.1:8b']);
  });

  test('accepts snake_case options (YAML compat)', () => {
    const p = new OllamaProvider({ base_url: 'http://ollama:11434/', timeout_ms: 30000 });
    expect(p._baseUrl).toBe('http://ollama:11434'); // trailing slash stripped
    expect(p._timeoutMs).toBe(30000);
  });
});

// ---------------------------------------------------------------------------
// describe: complete()
// ---------------------------------------------------------------------------

describe('OllamaProvider — complete()', () => {
  let provider;

  beforeEach(() => {
    provider = new OllamaProvider({ baseUrl: 'http://ollama:11434' });
    jest.restoreAllMocks();
  });

  const baseRequest = {
    model: 'llama3.1:8b',
    messages: [{ role: 'user', content: 'Hello' }],
    taskType: 'extraction',
  };

  // --- Happy path ---

  test('returns LLMResponse with content, usage, model, provider', async () => {
    mockFetch(mockResponse(200, {
      model: 'llama3.1:8b',
      message: { role: 'assistant', content: 'Hi there!' },
      prompt_eval_count: 15,
      eval_count: 8,
    }));

    const result = await provider.complete(baseRequest);

    expect(result.content).toBe('Hi there!');
    expect(result.usage.promptTokens).toBe(15);
    expect(result.usage.completionTokens).toBe(8);
    expect(result.usage.totalTokens).toBe(23);
    expect(result.model).toBe('llama3.1:8b');
    expect(result.provider).toBe('ollama');
  });

  test('does NOT set latencyMs — LLMService injects it', async () => {
    mockFetch(mockResponse(200, {
      model: 'llama3.1:8b',
      message: { role: 'assistant', content: 'Hi' },
      prompt_eval_count: 5,
      eval_count: 3,
    }));

    const result = await provider.complete(baseRequest);
    expect(result.latencyMs).toBeUndefined();
  });

  test('forwards temperature=0 (falsy but valid)', async () => {
    mockFetch(mockResponse(200, {
      model: 'llama3.1:8b',
      message: { role: 'assistant', content: 'deterministic' },
      prompt_eval_count: 5,
      eval_count: 2,
    }));

    await provider.complete({ ...baseRequest, temperature: 0 });

    const fetchCall = global.fetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.options.temperature).toBe(0);
  });

  test('uses default temperature 0.1 when not specified', async () => {
    mockFetch(mockResponse(200, {
      model: 'llama3.1:8b',
      message: { role: 'assistant', content: 'ok' },
      prompt_eval_count: 5,
      eval_count: 2,
    }));

    await provider.complete(baseRequest);

    const fetchCall = global.fetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.options.temperature).toBe(0.1);
  });

  test('forwards maxTokens as num_predict', async () => {
    mockFetch(mockResponse(200, {
      model: 'llama3.1:8b',
      message: { role: 'assistant', content: 'ok' },
      prompt_eval_count: 5,
      eval_count: 2,
    }));

    await provider.complete({ ...baseRequest, maxTokens: 512 });

    const fetchCall = global.fetch.mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    expect(body.options.num_predict).toBe(512);
  });

  // --- Missing fields in response ---

  test('returns empty string when message.content is missing', async () => {
    mockFetch(mockResponse(200, {
      model: 'llama3.1:8b',
      message: { role: 'assistant' }, // no content
      prompt_eval_count: 5,
      eval_count: 2,
    }));

    const result = await provider.complete(baseRequest);
    expect(result.content).toBe('');
  });

  test('returns zero token counts when eval fields are absent', async () => {
    mockFetch(mockResponse(200, {
      model: 'llama3.1:8b',
      message: { role: 'assistant', content: 'ok' },
      // no prompt_eval_count or eval_count
    }));

    const result = await provider.complete(baseRequest);
    expect(result.usage.promptTokens).toBe(0);
    expect(result.usage.completionTokens).toBe(0);
    expect(result.usage.totalTokens).toBe(0);
  });

  test('falls back to request.model when response model field is absent', async () => {
    mockFetch(mockResponse(200, {
      // no model field
      message: { role: 'assistant', content: 'ok' },
      prompt_eval_count: 5,
      eval_count: 2,
    }));

    const result = await provider.complete(baseRequest);
    expect(result.model).toBe('llama3.1:8b');
  });

  // --- HTTP errors ---

  test('throws error with statusCode 503 on HTTP 503', async () => {
    mockFetch(mockResponse(503, 'Service Unavailable'));

    await expect(provider.complete(baseRequest)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  test('throws error with statusCode 400 on HTTP 400', async () => {
    mockFetch(mockResponse(400, 'Bad Request'));

    await expect(provider.complete(baseRequest)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  // --- Timeout ---

  test('throws AbortError when request exceeds timeout', async () => {
    jest.useFakeTimers();

    jest.spyOn(global, 'fetch').mockImplementation((_url, options) => {
      // Simulate the abort signal being fired
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    const fastProvider = new OllamaProvider({ timeoutMs: 100 });
    const promise = fastProvider.complete(baseRequest);

    jest.advanceTimersByTime(200);

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });

    jest.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// describe: isAvailable()
// ---------------------------------------------------------------------------

describe('OllamaProvider — isAvailable()', () => {
  let provider;

  beforeEach(() => {
    provider = new OllamaProvider({ baseUrl: 'http://ollama:11434' });
    jest.restoreAllMocks();
  });

  test('returns true when /api/tags responds 200', async () => {
    mockFetch(mockResponse(200, { models: [] }));
    await expect(provider.isAvailable()).resolves.toBe(true);
  });

  test('returns false when fetch throws a network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(provider.isAvailable()).resolves.toBe(false);
  });

  test('returns false when /api/tags responds 500', async () => {
    mockFetch(mockResponse(500, 'Internal Server Error'));
    await expect(provider.isAvailable()).resolves.toBe(false);
  });

  test('never throws', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('boom'));
    await expect(provider.isAvailable()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// describe: listModels()
// ---------------------------------------------------------------------------

describe('OllamaProvider — listModels()', () => {
  let provider;

  beforeEach(() => {
    provider = new OllamaProvider({ baseUrl: 'http://ollama:11434' });
    jest.restoreAllMocks();
  });

  test('returns array of model names', async () => {
    mockFetch(mockResponse(200, {
      models: [{ name: 'llama3.1:8b' }, { name: 'llama3.1:70b' }],
    }));

    await expect(provider.listModels()).resolves.toEqual(['llama3.1:8b', 'llama3.1:70b']);
  });

  test('returns [] on network error', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(provider.listModels()).resolves.toEqual([]);
  });

  test('returns [] on HTTP 500', async () => {
    mockFetch(mockResponse(500, 'Internal Server Error'));
    await expect(provider.listModels()).resolves.toEqual([]);
  });

  test('returns [] when models field is null', async () => {
    mockFetch(mockResponse(200, { models: null }));
    await expect(provider.listModels()).resolves.toEqual([]);
  });

  test('never throws', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('boom'));
    await expect(provider.listModels()).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// describe: _pullModel()
// ---------------------------------------------------------------------------

describe('OllamaProvider — _pullModel()', () => {
  let provider;

  beforeEach(() => {
    provider = new OllamaProvider({ baseUrl: 'http://ollama:11434' });
    jest.restoreAllMocks();
  });

  test('resolves when /api/pull returns 200', async () => {
    mockFetch(mockResponse(200, { status: 'success' }));
    await expect(provider._pullModel('llama3.1:8b')).resolves.toBeUndefined();
  });

  test('throws error containing model name and HTTP body on 404', async () => {
    mockFetch(mockResponse(404, 'model "unknown:latest" not found'));

    await expect(provider._pullModel('unknown:latest')).rejects.toThrow(
      /Failed to pull model unknown:latest/
    );
  });

  test('error message includes the server response body', async () => {
    mockFetch(mockResponse(500, 'registry error'));

    await expect(provider._pullModel('llama3.1:8b')).rejects.toThrow(/registry error/);
  });
});

// ---------------------------------------------------------------------------
// describe: initialize()
// ---------------------------------------------------------------------------

describe('OllamaProvider — initialize()', () => {
  let provider;

  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('resolves immediately when requiredModels is empty', async () => {
    provider = new OllamaProvider({ requiredModels: [] });
    const pullSpy = jest.spyOn(provider, '_pullModel');

    await expect(provider.initialize()).resolves.toBeUndefined();
    expect(pullSpy).not.toHaveBeenCalled();
  });

  test('does not pull models that are already available', async () => {
    provider = new OllamaProvider({ requiredModels: ['llama3.1:8b'] });
    jest.spyOn(provider, 'listModels').mockResolvedValue(['llama3.1:8b', 'llama3.1:70b']);
    const pullSpy = jest.spyOn(provider, '_pullModel');

    await provider.initialize();
    expect(pullSpy).not.toHaveBeenCalled();
  });

  test('pulls missing model and emits console.log at start and completion', async () => {
    provider = new OllamaProvider({ requiredModels: ['llama3.1:8b'] });
    jest.spyOn(provider, 'listModels').mockResolvedValue([]);
    jest.spyOn(provider, '_pullModel').mockResolvedValue(undefined);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await provider.initialize();

    expect(provider._pullModel).toHaveBeenCalledWith('llama3.1:8b');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Pulling model: llama3.1:8b')
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Model ready: llama3.1:8b')
    );

    logSpy.mockRestore();
  });

  test('fails fast — stops on first pull error, does not attempt remaining models', async () => {
    provider = new OllamaProvider({ requiredModels: ['modelA', 'modelB'] });
    jest.spyOn(provider, 'listModels').mockResolvedValue([]);
    const pullSpy = jest.spyOn(provider, '_pullModel')
      .mockRejectedValueOnce(new Error('Failed to pull model modelA: network error'))
      .mockResolvedValueOnce(undefined);

    await expect(provider.initialize()).rejects.toThrow(/modelA/);
    expect(pullSpy).toHaveBeenCalledTimes(1);
    expect(pullSpy).not.toHaveBeenCalledWith('modelB');
  });

  test('error from failed pull propagates with original message', async () => {
    provider = new OllamaProvider({ requiredModels: ['bad-model'] });
    jest.spyOn(provider, 'listModels').mockResolvedValue([]);
    jest.spyOn(provider, '_pullModel').mockRejectedValue(
      new Error('Failed to pull model bad-model: registry error')
    );

    await expect(provider.initialize()).rejects.toThrow(
      'Failed to pull model bad-model: registry error'
    );
  });
});
