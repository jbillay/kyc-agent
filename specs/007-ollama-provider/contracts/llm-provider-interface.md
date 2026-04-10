# Contract: LLMProvider Interface — OllamaProvider

**Branch**: `007-ollama-provider` | **Date**: 2026-04-10

This document defines the contract `OllamaProvider` fulfills for `LLMService`. The interface is declared in `backend/src/llm/types.js`.

## LLMProvider Interface

```
interface LLMProvider {
  name: string                                           // 'ollama'
  complete(request: LLMRequest): Promise<LLMResponse>
  isAvailable(): Promise<boolean>
  listModels(): Promise<string[]>
}
```

## OllamaProvider Public API (superset of LLMProvider)

| Method | Signature | Throws | Notes |
|---|---|---|---|
| `constructor` | `(config?: OllamaConfig) => OllamaProvider` | never | Safe to call with no args |
| `initialize` | `() => Promise<void>` | `Error` if pull fails | Call once at startup |
| `complete` | `(request: LLMRequest & { model: string }) => Promise<LLMResponse>` | `Error` with `.statusCode` on HTTP error; `AbortError` on timeout | |
| `isAvailable` | `() => Promise<boolean>` | never | Returns `false` on any error |
| `listModels` | `() => Promise<string[]>` | never | Returns `[]` on any error |

## Error Contract

### `complete()` errors

| Scenario | Error type | `.statusCode` | Retryable by LLMService |
|---|---|---|---|
| Ollama returns 4xx | `Error` | HTTP status (e.g., 400) | No (non-retryable client error) |
| Ollama returns 5xx | `Error` | HTTP status (e.g., 503) | Yes |
| Request exceeds `timeoutMs` | `AbortError` | undefined | Yes (`err.name === 'AbortError'`) |
| Network refused | `Error` | undefined, `code: 'ECONNREFUSED'` | Yes |

### `initialize()` errors

| Scenario | Error message format |
|---|---|
| Pull fails (HTTP error) | `Failed to pull model <name>: <HTTP body>` |
| Pull times out | `AbortError` (from `_fetch` timeout) |

## Invariants

1. `isAvailable()` and `listModels()` NEVER throw — all errors are caught and return `false`/`[]`.
2. `complete()` always returns a valid `LLMResponse` shape on success — `content` is never `undefined` (empty string if Ollama returns no content).
3. Token counts are always non-negative numbers — never `NaN` or `undefined`.
4. `initialize()` with an empty `requiredModels` list resolves immediately with no side effects.
5. `initialize()` stops on the first pull failure — subsequent models are not attempted.
