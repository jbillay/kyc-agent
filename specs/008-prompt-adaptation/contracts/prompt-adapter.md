# Contract: PromptAdapter Interface

**Type**: Internal library interface  
**Consumed by**: `LLMService` (sole caller)  
**Implemented by**: `DefaultAdapter`, `MistralAdapter`, `LlamaAdapter`

---

## Interface Definition

```
PromptAdapter {
  formatMessages(messages: LLMMessage[]): LLMMessage[]
  formatStructuredOutputInstruction(schema: Object): string
}
```

This interface is documented via JSDoc in `backend/src/llm/types.js` (or a new
`backend/src/llm/prompt-adapters/prompt-adapter.js` interface file if added).

---

## Method Contracts

### `formatMessages(messages)`

**Purpose**: Transform a standard message array into the format appropriate for the
target model family.

**Preconditions**:
- `messages` is a non-null array of `LLMMessage` objects
- Each message has a valid `role` (`system`, `user`, `assistant`) and a `content` string

**Postconditions**:
- Returns a non-null array of `LLMMessage` objects
- If input was non-empty, output is non-empty
- Assistant message content is preserved byte-for-byte
- Input array is not mutated

**Error behavior**:
- MUST NOT throw for any valid message array
- Behavior is undefined for messages with roles outside `system`/`user`/`assistant`

---

### `formatStructuredOutputInstruction(schema)`

**Purpose**: Generate a natural-language instruction string that directs the model to
respond with a JSON object conforming to `schema`.

**Preconditions**:
- `schema` is a non-null, non-empty JavaScript object (has at least one key)

**Postconditions**:
- Returns a non-empty string
- String contains the word "JSON" (case-insensitive)
- String contains the serialized schema

**Error behavior**:
- MUST throw `Error("schema is required")` when `schema` is null, undefined,
  or an empty object (`{}`)

---

## PromptAdapterFactory Contract

**File**: `backend/src/llm/prompt-adapter-factory.js`  
**Export**: `PromptAdapterFactory` class

```
PromptAdapterFactory {
  getAdapter(modelName: string): PromptAdapter
}
```

**Preconditions**: `modelName` may be any string, including null, undefined, or empty

**Postconditions**:
- Always returns a `PromptAdapter` instance
- Never throws
- Returns the same instance for repeated calls with same model family prefix

**Selection table**:

| `modelName.toLowerCase().startsWith(...)` | Returns |
|-------------------------------------------|---------|
| `'mistral'` | `MistralAdapter` singleton |
| `'mixtral'` | `MistralAdapter` singleton |
| `'llama'` | `LlamaAdapter` singleton |
| anything else | `DefaultAdapter` singleton |

---

## LLMService Logging Contract (FR-011)

When `LLMService.complete()` calls `promptAdapterFactory.getAdapter(model)`, it MUST
emit one structured debug log entry containing:

```json
{
  "adapter": "<adapter class name>",
  "model": "<model name string>"
}
```

Message content is NOT logged. The log entry appears at `debug` level and is produced
once per `complete()` call (including fallback provider attempts in `_tryFallback()`).

If no logger is provided to `LLMService`, the debug log is silently suppressed (no-op).
