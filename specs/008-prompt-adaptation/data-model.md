# Data Model: Prompt Adaptation System (008)

This feature introduces no new database tables. All entities are in-memory, stateless objects.

---

## Entity: LLMMessage

Already defined in `backend/src/llm/types.js`. Reproduced here for reference.

| Field | Type | Constraints |
|-------|------|-------------|
| `role` | string enum | Required. One of: `'system'`, `'user'`, `'assistant'` |
| `content` | string | Required. Non-empty text content of the message |

A conversation is an ordered array of `LLMMessage` objects. Order is significant — it represents
the chronological message sequence.

---

## Entity: PromptAdapter (interface contract)

A `PromptAdapter` is a stateless singleton object that implements exactly two methods.

| Method | Signature | Returns | Throws |
|--------|-----------|---------|--------|
| `formatMessages` | `(messages: LLMMessage[]) => LLMMessage[]` | Transformed message array | Never |
| `formatStructuredOutputInstruction` | `(schema: Object) => string` | Instruction text | `Error("schema is required")` if schema is null, undefined, or empty object |

**Invariants**:
- `formatMessages` MUST NOT mutate the input array
- `formatMessages` MUST return an array with at least one message if given a non-empty input
- `formatMessages` MUST preserve assistant message content unchanged
- `formatStructuredOutputInstruction` MUST return a non-empty string when given a valid schema
- Both methods are safe to call concurrently (no shared mutable state)

---

## Entity: PromptAdapterFactory

A factory singleton that maps model names to adapter instances.

| Method | Signature | Returns | Throws |
|--------|-----------|---------|--------|
| `getAdapter` | `(modelName: string) => PromptAdapter` | Adapter singleton | Never (returns DefaultAdapter for unknown/empty names) |

**Selection rules** (applied in order, case-insensitive):

| Model name prefix | Adapter returned |
|-------------------|-----------------|
| `mistral` | `MistralAdapter` |
| `mixtral` | `MistralAdapter` |
| `llama` | `LlamaAdapter` |
| anything else (including empty, null, undefined) | `DefaultAdapter` |

**Invariants**:
- The same adapter instance is returned on repeated calls for the same model family
- Selection is O(1) — three `startsWith` checks, no iteration
- Model name normalization: lowercased before matching; null/undefined treated as empty string

---

## Adapter Transformation Rules

### DefaultAdapter

| Input | Output |
|-------|--------|
| Any message array | Same array reference, unchanged |
| `schema` | Instruction string containing the schema JSON and "JSON" keyword |
| null/empty schema | Throws `Error("schema is required")` |

### MistralAdapter

| Input | Output |
|-------|--------|
| `[system, user, ...]` | `[user(system+user content), ...]` — system merged into first user |
| `[system, system, user, ...]` | `[user(both systems + user content), ...]` — multiple systems concatenated |
| `[user, assistant, user]` (no system) | Same array, unchanged |
| `[system]` (only system, no user) | `[user(system content)]` — flushed as user message |
| `schema` | Instruction string with no markdown code blocks |
| null/empty schema | Throws `Error("schema is required")` |

### LlamaAdapter

| Input | Output |
|-------|--------|
| `[system, user, ...]` | Same array, unchanged — system present, no modification |
| `[user, ...]` (no system) | `[system("You are a helpful assistant."), user, ...]` — default prepended |
| `schema` | Instruction string with JSON code block |
| null/empty schema | Throws `Error("schema is required")` |
