# Research: Prompt Adaptation System (008)

## Current Implementation Gaps

A complete audit of `backend/src/llm/` was performed. The following gaps exist between the
spec requirements and the current codebase:

| Gap | Location | Severity |
|-----|----------|----------|
| `mixtral*` prefix not handled — routes to DefaultAdapter | `prompt-adapter-factory.js:31` | High — FR-007 violation |
| LlamaAdapter passes through without adding default system message | `prompt-adapters/llama.js:25–28` | High — FR-004 violation |
| MistralAdapter: system-only messages (no user message) produce empty output | `prompt-adapters/mistral.js:19–39` | High — FR-010 violation |
| No null/empty schema validation in any adapter | all three adapter files | Medium — FR-012 violation |
| No debug-level logging for adapter invocations | `llm-service.js:69–70` | Medium — FR-011 violation |
| Test coverage missing for all 5 gaps above | `tests/backend/llm/prompt-adapters/adapters.test.js` | Medium |

---

## Decision 1: Where to add debug logging

**Decision**: Log adapter selection inside `LLMService.complete()` and `LLMService._tryFallback()`,
immediately after calling `this._promptAdapterFactory.getAdapter(model)`. Pass an optional `logger`
parameter to the `LLMService` constructor (defaulting to a no-op if absent).

**Rationale**: Adapters are stateless value objects with no I/O — injecting a logger into them would
add constructor complexity without benefit. The LLMService already knows both the model name (from
routing) and the adapter (from the factory return value). Logging at the service level satisfies
FR-011 ("adapter invocation" occurs at the point where `getAdapter` is called) without mutating
adapter interfaces.

**Alternatives considered**:
- Inject logger into each adapter — rejected: adapters are instantiated once as singletons; a shared
  logger could be passed to the factory constructor instead, but logging at the call site (LLMService)
  is simpler and doesn't require changes to three adapter files.
- Module-level `pino` logger per adapter file — rejected: would create uncontrolled log output in
  unit tests unless the logger is mocked; the optional-logger pattern on LLMService is cleaner.

---

## Decision 2: LlamaAdapter — default system message content

**Decision**: Add `{ role: 'system', content: 'You are a helpful assistant.' }` as the default
system message prepended when no system message is present.

**Rationale**: This matches the SPEC.md reference design. It is the industry-standard neutral system
prompt for conversational models and does not encode any KYC-specific behavior, making it safe as a
fallback across all use cases.

**Alternatives considered**:
- KYC-specific default ("You are a KYC compliance assistant.") — rejected: the adapter is a generic
  infrastructure component; KYC context belongs in agent prompts, not in the adapter default.

---

## Decision 3: MistralAdapter — system-only edge case

**Decision**: After the message loop, if `pendingSystem` is non-null (i.e., accumulated system
content was never consumed by a user message), flush it as a `{ role: 'user', content: pendingSystem }`
message appended to `result`.

**Rationale**: The Mistral instruct format requires at least one user turn. Converting orphaned system
content to a user message is the same strategy the reference design uses and preserves the intent of
the system content in a Mistral-compatible way.

---

## Decision 4: Null schema validation

**Decision**: All three adapters' `formatStructuredOutputInstruction` methods throw an `Error` with
message `"schema is required"` when given a null, undefined, or empty-object schema (i.e., a schema
with no `properties`, `type`, or `$schema` key — effectively `Object.keys(schema).length === 0`).

**Rationale**: Fail-fast per FR-012. A null or empty schema would silently produce an instruction
containing "null" or "{}" which Mistral and Llama models would fail to follow, producing broken
pipeline output. A named error surfaces the misconfiguration immediately at the call site.

**Empty object detection**: `!schema || (typeof schema === 'object' && Object.keys(schema).length === 0)`

---

## Decision 5: Factory file location

**Decision**: Keep the factory at `backend/src/llm/prompt-adapter-factory.js` (class
`PromptAdapterFactory`) — do NOT move it to `prompt-adapters/factory.js`.

**Rationale**: The existing test file, LLMService, and any other consumers already import from
`prompt-adapter-factory.js`. Moving the file would require updating imports with no functional gain.
The spec's `factory.js` path was a design suggestion, not a hard requirement.

---

## Test Structure

**Test file**: `tests/backend/llm/prompt-adapters/adapters.test.js` (already exists)

Tests to add to the existing file:
1. MistralAdapter: system-only messages → single user message with combined content
2. MistralAdapter: multiple consecutive system messages → content concatenated into first user message
3. LlamaAdapter: messages without system message → default "You are a helpful assistant." prepended
4. LlamaAdapter: messages WITH system message → passes through unchanged
5. All adapters: `formatStructuredOutputInstruction(null)` → throws
6. All adapters: `formatStructuredOutputInstruction({})` → throws
7. Factory: `mixtral:8x7b` → MistralAdapter
8. Factory: `Mistral-Nemo:12B` (mixed case) → MistralAdapter (case insensitivity)
9. Factory: `LLama3:8b` (mixed case) → LlamaAdapter (case insensitivity)
10. LLMService: verify adapter name is logged when complete() is called (mock logger)
