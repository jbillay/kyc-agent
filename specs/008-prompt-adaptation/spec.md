# Feature Specification: Prompt Adaptation System

**Feature Branch**: `008-prompt-adaptation`  
**Created**: 2026-04-22  
**Status**: Draft  
**Input**: User description: "@specifications/epic-02-llm-abstraction/prompt-adaptation/SPEC.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Write Once, Run Anywhere (Priority: P1)

An agent developer writes a prompt once using a standard message format (system role, user role, assistant role) and the system automatically delivers it to whatever LLM model is configured — without the developer needing to know anything about the target model's native format.

**Why this priority**: This is the core value proposition. Without this, every agent must handle model-specific formatting manually, creating tight coupling between agents and LLM backends. P1 because every other story depends on this working correctly.

**Independent Test**: A developer can write a system prompt and user message, configure two different model backends (e.g., Mistral and Llama), invoke the LLM service with each, and confirm both receive correctly formatted input without any changes to the agent code.

**Acceptance Scenarios**:

1. **Given** an agent sends a system message and user message in standard format, **When** the target model is Mistral, **Then** the system message content is merged into the first user message before delivery
2. **Given** an agent sends a system message and user message in standard format, **When** the target model is Llama 3, **Then** the messages are passed through with a system message guaranteed to be present
3. **Given** an agent sends messages in standard format, **When** the target model is OpenAI-compatible or unknown, **Then** the messages are passed through unchanged
4. **Given** a model name with mixed casing (e.g., "Mistral-Nemo:12B"), **When** the adapter is selected, **Then** the correct adapter is chosen regardless of capitalization

---

### User Story 2 - Structured Output Instructions Across Models (Priority: P2)

An agent that needs the LLM to return valid JSON can request a structured output instruction, and the system formats that instruction in the style that works best for the target model family — without the agent specifying any model-specific syntax.

**Why this priority**: Structured output is used in nearly every KYC agent step (extraction, screening evaluation, risk scoring). A misformatted instruction leads to unparseable responses and broken agent pipelines. P2 because it depends on the adapter selection working (P1).

**Independent Test**: A developer can pass a JSON schema to the structured output instruction method and receive a model-appropriate instruction string that, when included in a prompt to the target model, reliably produces a JSON-only response.

**Acceptance Scenarios**:

1. **Given** a JSON schema and a Mistral model, **When** the structured output instruction is generated, **Then** the instruction contains no markdown code blocks and uses direct JSON-only rules
2. **Given** a JSON schema and a Llama model, **When** the structured output instruction is generated, **Then** the instruction includes a JSON code block and explicit output-only directive
3. **Given** a JSON schema and a default/OpenAI-compatible model, **When** the structured output instruction is generated, **Then** the instruction wraps the schema in a JSON code block with clear formatting rules

---

### User Story 3 - Adapter Selection by Model Name (Priority: P3)

An operator or developer configures a model name (e.g., "mistral-nemo:12b" or "llama3:8b") in the system configuration, and the correct adapter is automatically selected without any additional configuration.

**Why this priority**: Simplifies operations. Operators should not need to maintain a separate mapping of model names to adapters — the system infers it. P3 because it builds on the adapters being defined (P1, P2).

**Independent Test**: Given a list of model name strings covering Mistral variants, Llama variants, and other models, the adapter factory can be called for each and returns the expected adapter type every time, with no errors for unknown names.

**Acceptance Scenarios**:

1. **Given** a model name starting with "mistral" or "mixtral" (any case), **When** the adapter factory is queried, **Then** the Mistral adapter is returned
2. **Given** a model name starting with "llama" (any case), **When** the adapter factory is queried, **Then** the Llama adapter is returned
3. **Given** any other model name (e.g., "gpt-4o", "claude-sonnet-4", "qwen:7b"), **When** the adapter factory is queried, **Then** the default pass-through adapter is returned
4. **Given** the same adapter is requested multiple times, **When** it is used concurrently, **Then** there is no shared mutable state and all calls return correct results

---

### User Story 4 - Multi-Turn Conversation Handling (Priority: P4)

An agent carrying on a multi-turn conversation (system prompt, followed by alternating user/assistant exchanges) receives correct formatting for all messages — not just the first turn.

**Why this priority**: KYC agents may perform iterative analysis with follow-up questions. Formatting must remain correct throughout the conversation, not just at the start.

**Independent Test**: A developer can pass a three-turn conversation (system + user/assistant/user) through each adapter and confirm the output structure is valid for the target model at every turn.

**Acceptance Scenarios**:

1. **Given** a Mistral adapter and a multi-turn conversation with a system message, **When** messages are formatted, **Then** the system content is merged only into the first user message; subsequent turns are passed through unchanged
2. **Given** a Llama adapter and a multi-turn conversation, **When** messages are formatted, **Then** the system message is preserved at the start and subsequent turns are unchanged
3. **Given** only system messages with no user messages, **When** the Mistral adapter formats them, **Then** the output contains a single user message with the combined system content

---

### Edge Cases

- What happens when only system messages are provided with no user message (Mistral adapter must not produce empty output)?
- What happens when the model name is an empty string or null (factory must return the default adapter without throwing)?
- What happens when the JSON schema passed to structured output instruction is empty or has no properties? → Throws a descriptive error immediately; agent caller is responsible for handling it
- What happens when multiple system messages appear in sequence before any user message?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a standard message format using role-based messages (system, user, assistant) that all agents use when invoking the LLM service
- **FR-002**: The system MUST automatically select the appropriate prompt adapter based on the model name before every LLM invocation, without any per-call configuration from the agent
- **FR-003**: The Mistral adapter MUST merge all system message content into the first user message, ensuring Mistral instruct models receive instructions in their expected format
- **FR-004**: The Llama adapter MUST ensure every conversation includes a system message; if none is provided, a default system message MUST be prepended automatically
- **FR-005**: The default adapter MUST pass all messages through unchanged, preserving the original message array for OpenAI-compatible and unknown model families
- **FR-006**: Each adapter MUST provide a structured output instruction method that accepts a data schema and returns a model-appropriate instruction string for constraining output to valid JSON
- **FR-007**: The adapter selection logic MUST match model names case-insensitively using prefix matching (model names beginning with "mistral" or "mixtral" route to Mistral; "llama" routes to Llama; all others route to default)
- **FR-008**: All adapters MUST be stateless — they MUST NOT store any per-request state, making them safe to share across concurrent LLM calls
- **FR-009**: The adapter factory MUST return a pre-instantiated singleton adapter (not a new instance per call) so that adapter selection has constant-time performance regardless of the number of registered adapters
- **FR-010**: The system MUST handle edge cases gracefully: a missing or empty model name MUST return the default adapter; a conversation with only system messages MUST produce valid output from every adapter
- **FR-012**: The structured output instruction method MUST throw a descriptive error when given a null, undefined, or structurally empty schema — it MUST NOT silently return a generic or empty instruction
- **FR-011**: The system MUST emit a structured debug-level log entry for each adapter invocation, recording the adapter name and model name; message content MUST NOT be included in this log entry

### Key Entities

- **Message**: A single unit of conversation with a role (system, user, or assistant) and text content; the standard format used by all agents when composing prompts
- **Prompt Adapter**: A stateless component responsible for transforming a sequence of messages into the format expected by a specific model family, and for generating model-appropriate structured output instructions
- **Adapter Factory**: The single point of selection logic that maps a model name to its corresponding adapter; used by the LLM service before every call
- **Structured Output Instruction**: A text string injected into a prompt to instruct a model to respond with valid JSON conforming to a given schema; format varies by model family

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An agent written with standard message format runs correctly against all three supported model families (Mistral, Llama, OpenAI-compatible) without any code changes to the agent
- **SC-002**: Adapter selection completes in constant time regardless of how many model names are registered — adding new model patterns does not degrade selection performance
- **SC-003**: 100% of multi-turn conversations passing through any adapter produce output that is structurally valid for the target model family (no messages lost, no roles corrupted)
- **SC-004**: Structured output instructions produce parseable JSON responses from the target model in at least 95% of calls during integration testing (measured against each adapter independently)
- **SC-005**: All adapters pass concurrent usage tests with no observable side effects, data corruption, or race conditions across simultaneous requests
- **SC-006**: Adding a new model family requires only two steps: a new adapter implementation and one new hardcoded pattern entry in the factory source — no changes to existing adapters or callers, and no config file modifications
- **SC-007**: Every adapter invocation produces exactly one observable log entry containing adapter name and model name, with no sensitive message content, verifiable in any environment where debug logging is enabled

## Clarifications

### Session 2026-04-22

- Q: Should the prompt adaptation layer produce observable signals when it transforms messages, so the exact transformation applied to each LLM call is traceable? → A: Emit a structured debug-level log entry per call: adapter name + model name (no message content)
- Q: What should formatStructuredOutputInstruction do when given a null, undefined, or structurally empty schema? → A: Throw a descriptive error immediately (fail fast, surfaced to the agent caller)
- Q: Should new adapter pattern registrations be code-driven or config-driven? → A: Code only — new patterns added directly in the factory source; changes require a code deployment

## Assumptions

- Agents always compose prompts using the standard role-based message format; no agent calls an LLM directly with raw strings
- Ollama handles the low-level model chat template (e.g., tokenizer-level formatting) internally; the adapters normalize the message structure at the application level, not at the token level
- The LLM service is the only caller of the adapter factory; agents never invoke adapters directly
- Model names passed to the factory match the names used in the LLM configuration file (e.g., "mistral-nemo:12b", "llama3:8b") — names are not sanitized before being passed to the factory
- A new model family that does not match any known prefix will work correctly with the default (pass-through) adapter as a safe fallback
- Adapter pattern registration is exclusively code-driven (hardcoded in the factory); no runtime configuration file governs which adapter handles which model prefix, ensuring all adapter logic changes are version-controlled and code-reviewed
- The structured output instruction is appended to the user message or system message by the LLM service; the adapter is responsible only for generating the instruction text, not for injecting it
- Concurrent usage safety means statelessness only — no external locking, thread pools, or synchronization primitives are required
