# Quickstart: Ollama LLM Provider

**Branch**: `007-ollama-provider` | **Date**: 2026-04-10

## What's changing

`backend/src/llm/providers/ollama.js` is being upgraded from the feature 006 stub to the full spec-compliant implementation. No new files are created in `src/` — only the existing provider and new test files.

## Files touched

| File | Change |
|---|---|
| `backend/src/llm/providers/ollama.js` | Full rewrite — adds `initialize()`, `requiredModels`, `_fetch()` with AbortController, `_pullModel()`, console logging |
| `tests/backend/llm/providers/ollama.test.js` | New — unit tests with mocked `fetch` |
| `tests/backend/llm/providers/ollama.integration.test.js` | New — integration tests (requires running Ollama, guarded by env var) |

## Running tests

```bash
# Unit tests only (no Ollama required)
cd backend && npm test

# Integration tests (requires Ollama running at localhost:11434)
OLLAMA_INTEGRATION_TEST=1 cd backend && npm test
```

## How the provider is wired up at startup

The provider is instantiated in the app startup code (not part of this feature). The relevant shape is:

```js
const { OllamaProvider } = require('./src/llm/providers/ollama');

const ollamaProvider = new OllamaProvider({
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://ollama:11434',
  timeoutMs: 120000,
  requiredModels: ['llama3.1:70b', 'llama3.1:8b'],  // from config/llm.yaml routing values
});

await ollamaProvider.initialize();  // pulls missing models at startup
llmService.registerProvider(ollamaProvider);
```

## Key design constraints

- **Do not add `latencyMs` to the response** — `LLMService` injects it after `complete()` returns
- **Do not import anything from other project layers** — the provider is Layer 1; no services, agents, or data sources may be imported
- **`temperature: 0` is valid** — use `?? 0.1` (nullish coalescing), not `|| 0.1` (falsy check)
- **`isAvailable()` and `listModels()` must never throw** — catch all errors and return `false`/`[]`
