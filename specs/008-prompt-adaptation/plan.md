# Implementation Plan: Prompt Adaptation System

**Branch**: `008-prompt-adaptation` | **Date**: 2026-04-22 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/008-prompt-adaptation/spec.md`

## Summary

Complete the prompt adaptation layer so that every LLM call routed through `LLMService` is
automatically formatted for the target model family. Five gaps exist between the current
implementation and the spec: the factory does not handle `mixtral*` model names, `LlamaAdapter`
does not prepend a default system message, `MistralAdapter` silently drops system-only messages,
no adapter validates a null/empty schema, and `LLMService` emits no debug log for adapter
selection. All changes are confined to `backend/src/llm/`; no new files, no database changes.

## Technical Context

**Language/Version**: Node.js ≥ 22 (JavaScript, CommonJS modules)  
**Primary Dependencies**: `pino` (logging, already in package.json), `jest` (testing)  
**Storage**: N/A — in-memory stateless logic only  
**Testing**: Jest; test root at `tests/backend/` per `package.json` jest config  
**Target Platform**: Docker container running the `api` and `agent-worker` services  
**Performance Goals**: O(1) adapter selection; no measurable latency added to LLM call path  
**Constraints**: Adapters must remain stateless singletons; no new npm dependencies  
**Scale/Scope**: Called once per `LLMService.complete()` invocation; concurrent-safe

## Constitution Check

*GATE: Checked before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Auditability First | PASS | FR-011 adds debug-level adapter logging; message content is NOT logged (privacy) |
| II. LLM-Agnostic Provider Interface | PASS | This feature is entirely within Layer 1 — it IS the abstraction |
| III. Strict Layered Architecture | PASS | All changes are in Layer 1 (`backend/src/llm/`); no upward dependencies introduced |
| IV. Data Sovereignty | PASS | No external calls; pure in-process transformation |
| V. Configuration-Driven Compliance Logic | PASS | Model-to-adapter mappings are code-driven by clarification decision (2026-04-22); no compliance logic involved |

**Post-Phase 1 re-check**: No design decisions introduced any violations. Complexity Tracking
table is not required.

## Project Structure

### Documentation (this feature)

```text
specs/008-prompt-adaptation/
├── plan.md              ← this file
├── research.md          ← Phase 0 output
├── data-model.md        ← Phase 1 output
├── quickstart.md        ← Phase 1 output
├── contracts/
│   └── prompt-adapter.md  ← Phase 1 output
└── tasks.md             ← Phase 2 output (/speckit.tasks — not created here)
```

### Source Code (affected files only)

```text
backend/src/llm/
├── prompt-adapter-factory.js    MODIFY — add mixtral* prefix
├── llm-service.js               MODIFY — accept optional logger; log adapter selection
└── prompt-adapters/
    ├── default.js               MODIFY — add null schema guard
    ├── mistral.js               MODIFY — flush system-only messages; add null schema guard
    └── llama.js                 MODIFY — add default system message; add null schema guard

tests/backend/llm/prompt-adapters/
└── adapters.test.js             MODIFY — add missing test cases
```

**Structure Decision**: Web application (Option 2 from template). All changes are backend-only.
No frontend changes. No new directories.

## Phase 0: Research

See [research.md](./research.md) for full findings.

**Resolved decisions**:
1. Debug logging: added to `LLMService` (not adapters) via optional `logger` constructor param
2. LlamaAdapter default system message: `'You are a helpful assistant.'`
3. MistralAdapter system-only edge case: flush `pendingSystem` as user message
4. Null schema guard: throw `Error("schema is required")` for null/undefined/empty-object schemas
5. Factory location: keep at `prompt-adapter-factory.js` (not moved)

## Phase 1: Design & Contracts

See [data-model.md](./data-model.md) and [contracts/prompt-adapter.md](./contracts/prompt-adapter.md).

### Change 1: `prompt-adapter-factory.js` — add `mixtral*` prefix

```
Current:  if (lower.startsWith('mistral')) return this._mistral;
Required: if (lower.startsWith('mistral') || lower.startsWith('mixtral')) return this._mistral;
```

The `mixtral` prefix must be checked explicitly because "mixtral" does not start with "mistral"
(m-i-x vs m-i-s).

### Change 2: `prompt-adapters/llama.js` — default system message

Replace the current pass-through `formatMessages` with:
```
const hasSystem = messages.some(m => m.role === 'system');
if (!hasSystem) {
  return [{ role: 'system', content: 'You are a helpful assistant.' }, ...messages];
}
return messages;
```

Add null schema guard to `formatStructuredOutputInstruction`:
```
if (!schema || (typeof schema === 'object' && Object.keys(schema).length === 0)) {
  throw new Error('schema is required');
}
```

### Change 3: `prompt-adapters/mistral.js` — system-only edge case + null schema guard

After the `for` loop, add:
```
// Flush any accumulated system content that had no following user message
if (pendingSystem) {
  result.push({ role: 'user', content: pendingSystem });
}
```

Add null schema guard (same pattern as LlamaAdapter).

### Change 4: `prompt-adapters/default.js` — null schema guard

Add null schema guard at the top of `formatStructuredOutputInstruction` (same pattern).

### Change 5: `llm-service.js` — optional logger + debug logging

Constructor signature change:
```
constructor({ config, eventStore, promptAdapterFactory, logger = null })
```

Store: `this._logger = logger;`

After each `getAdapter` call (two locations: `complete()` and `_tryFallback()`):
```
const adapter = this._promptAdapterFactory.getAdapter(model);
if (this._logger) {
  this._logger.debug({ adapter: adapter.constructor.name, model }, 'prompt adapter selected');
}
```

### Change 6: `tests/backend/llm/prompt-adapters/adapters.test.js` — new test cases

Add to `MistralAdapter` suite:
- `system-only messages produce a single user message`
- `multiple consecutive system messages are concatenated`
- `formatStructuredOutputInstruction throws for null schema`
- `formatStructuredOutputInstruction throws for empty object schema`

Add to `LlamaAdapter` suite:
- `formatMessages prepends default system message when none present`
- `formatMessages passes through unchanged when system message present`
- `formatStructuredOutputInstruction throws for null schema`

Add to `DefaultAdapter` suite:
- `formatStructuredOutputInstruction throws for null schema`

Add to `PromptAdapterFactory` suite:
- `returns MistralAdapter for "mixtral:8x7b"`
- `returns MistralAdapter for mixed-case "Mistral-Nemo:12B"`
- `returns LlamaAdapter for mixed-case "LLama3:8b"`
- `mixtral and mistral return the same instance (singleton)`

Add a new `LLMService adapter logging` suite (or extend existing llm-service.test.js):
- `logs adapter name and model at debug level when logger provided`
- `does not throw when no logger is provided`
