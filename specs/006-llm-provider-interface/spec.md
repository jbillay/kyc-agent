# Feature Specification: LLM Provider Interface and Routing Service

**Feature Branch**: `006-llm-provider-interface`  
**Created**: 2026-04-10  
**Status**: Draft  
**Input**: User description: "@specifications/epic-02-llm-abstraction/provider-interface/SPEC.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Unified LLM Access for Agents (Priority: P1)

An agent needs to perform an LLM task (such as extracting entity data from a document or assessing risk). Instead of knowing which AI model or provider to use, the agent simply declares the type of task it needs done and submits its prompt. The system selects the appropriate provider and model, executes the request, and returns a response. The agent never needs to know the underlying AI infrastructure.

**Why this priority**: All agent intelligence flows through this interface. Nothing else in the platform can function without a working LLM routing layer. Delivering this alone makes all agent work possible.

**Independent Test**: Can be tested by submitting a request for each of the five task types and verifying that a valid response is returned and the correct provider/model combination was chosen according to configuration.

**Acceptance Scenarios**:

1. **Given** a configured routing table with two providers and multiple task types, **When** an agent submits a request for the `extraction` task type, **Then** the service selects the provider and model mapped to `extraction` in the configuration and returns a valid response.
2. **Given** a request with no explicit temperature setting, **When** the service processes the request, **Then** a temperature of 0.1 is applied automatically.
3. **Given** a request for a task type not configured in any provider's routing, **When** the service attempts to route the request, **Then** it returns a clear error indicating no provider is available for that task type.

---

### User Story 2 - Automatic Retry and Provider Fallback (Priority: P2)

When an AI provider is temporarily unavailable or returns an error, the platform must recover transparently without losing the agent's work. The service retries the request against the same provider up to a configurable limit, waiting progressively longer between attempts. If all retries fail, it automatically switches to an alternate provider and tries again. Agents are unaware that any failure occurred.

**Why this priority**: Network and provider instability are expected in production. Without retry and fallback, a single transient error would fail an entire KYC case, requiring human intervention. Resilience here protects every downstream agent.

**Independent Test**: Can be tested by simulating a provider that fails on the first two attempts but succeeds on the third, verifying the correct number of attempts and wait times, and separately simulating a provider that never succeeds to verify fallback activates.

**Acceptance Scenarios**:

1. **Given** a provider that returns a transient error on the first attempt, **When** the service processes the request, **Then** it retries up to the configured maximum attempts with exponentially increasing wait times between each attempt.
2. **Given** a default provider that fails all retry attempts, **When** a fallback provider is configured with a route for the requested task type, **Then** the service automatically tries the fallback provider and returns a successful response.
3. **Given** no providers succeed after all retries and fallback attempts, **When** the final attempt fails, **Then** the service raises a clear failure error and does not silently discard the failure.
4. **Given** an error that is not transient (e.g., a malformed request), **When** the service encounters it, **Then** it does not retry and fails immediately.

---

### User Story 3 - Structured Output Extraction (Priority: P2)

Agents frequently need the AI to return structured data (such as a list of identified entities, a risk score with reasons, or extracted document fields) rather than free-form text. The agent provides a schema describing the expected output shape and the service ensures the AI response is delivered back as a fully parsed, usable data structure — not raw text the agent must parse itself.

**Why this priority**: Unstructured LLM output forces every agent to implement its own fragile parsing logic. Centralizing structured output handling ensures consistency and eliminates an entire class of parsing bugs across the platform.

**Independent Test**: Can be tested by submitting a request with a schema for a simple object, verifying the response contains a correctly parsed data structure matching the schema, and verifying that a response containing JSON wrapped in a code block is handled correctly.

**Acceptance Scenarios**:

1. **Given** a request with a structured output schema, **When** the AI returns JSON within a markdown code block, **Then** the service extracts and parses the JSON and returns it as a structured object in the response.
2. **Given** a request with a structured output schema, **When** the AI returns plain JSON without a code block, **Then** the service parses the JSON and returns it as a structured object.
3. **Given** a request with a structured output schema, **When** the AI returns a response that cannot be parsed as valid JSON, **Then** the service returns a clear parse error identifying the failure.

---

### User Story 4 - Full Audit Logging of Every LLM Call (Priority: P3)

Every LLM interaction must be recorded for compliance and audit purposes. After each successful call — including the provider used, model selected, full request content, response content, token usage, latency, and attempt number — the platform writes an immutable log entry tied to the case, agent, and workflow step that initiated the call. Logging failures must never disrupt the agent's work.

**Why this priority**: The append-only audit trail is a core compliance requirement for KYC. However, logging is downstream of routing and execution, so it depends on P1 and P2 being in place first.

**Independent Test**: Can be tested by submitting a request and verifying the event store receives a correctly shaped log entry, and separately verifying that when the event store throws an error, the original LLM response is still returned successfully.

**Acceptance Scenarios**:

1. **Given** a successful LLM call tied to a case and agent step, **When** the response is returned, **Then** the event store receives a log entry containing the provider, model, task type, attempt count, request messages, response content, token usage, and latency.
2. **Given** a successful LLM call, **When** the event store is unavailable and logging fails, **Then** the LLM response is still returned to the caller without error.
3. **Given** a call that succeeds via fallback provider, **When** the response is logged, **Then** the log entry records the fallback provider name, not the default provider.

---

### Edge Cases

- What happens when no providers are registered at startup?
- How does the service behave if the configuration names a provider that was never registered?
- What happens when the AI response contains nested or malformed markdown code blocks around JSON?
- How does the service handle a provider whose availability check hangs indefinitely? (Resolved: configurable timeout; treat as unavailable and fall back.)
- What happens when retries are exhausted and no fallback provider has a route for the requested task type?
- How does the service behave when a provider returns a rate-limit error on every retry attempt (quota fully exhausted)?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The platform MUST provide a single, centralized entry point for all AI model interactions; agents MUST NOT communicate with AI providers directly.
- **FR-002**: The service MUST route each request to a provider and model based on the declared task type, using a configuration file as the source of truth for routing rules.
- **FR-003**: The service MUST support five task types: reasoning, extraction, screening, classification, and summarization.
- **FR-004**: The service MUST apply a default response temperature of 0.1 when none is specified by the caller.
- **FR-005**: The service MUST retry failed requests with exponentially increasing wait times, up to a configurable maximum number of attempts per provider. Rate-limit errors (provider quota exhaustion) MUST be treated as retryable with an extended backoff wait (longer than standard transient errors) and count against the same retry budget.
- **FR-006**: The service MUST automatically fall back to an alternate provider when the primary provider fails all retry attempts.
- **FR-007**: The service MUST attempt the configured default provider first before trying any alternate providers.
- **FR-008**: The service MUST accept a JSON schema alongside a request and return the AI's response as a parsed data structure when a schema is provided.
- **FR-009**: The service MUST handle AI responses where JSON is wrapped in markdown code blocks, extracting only the JSON content for parsing.
- **FR-010**: The service MUST write a log entry to the event store after every AI call, including provider, model, task type, request content, response content, token usage, latency, and attempt number.
- **FR-011**: A logging failure MUST NOT prevent the AI response from being returned to the caller.
- **FR-012**: The service MUST expose a mechanism to check the availability of each registered provider before routing requests to it.
- **FR-013**: The service MUST operate as a single shared instance across the platform (not instantiated per request or per agent).
- **FR-014**: The service MUST allow multiple AI providers to be registered; the set of providers and their routing rules are defined in configuration.
- **FR-015**: The service MUST support concurrent requests from multiple agents simultaneously. Each provider MUST have a configurable maximum concurrent request limit; requests that exceed the limit for a given provider MUST either queue until capacity is available or be routed to a fallback provider.

### Key Entities

- **LLM Request**: A task submitted by an agent, containing the conversation messages, the declared task type, optional structured output schema, and optional settings overrides (temperature, token limit).
- **LLM Response**: The result returned to the agent, containing the raw text, optionally a parsed structured object, token usage counts, the model and provider actually used, and the total response time.
- **LLM Provider**: A registered AI backend that can accept requests, report its availability, and list the models it supports.
- **Task Type**: A named category of LLM work (reasoning, extraction, screening, classification, summarization) that determines which provider and model are selected.
- **Call Context**: Metadata attached to every request identifying the case, agent type, and workflow step — used exclusively for audit logging.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every agent-initiated AI request is routed to the correct provider and model based on task type, with zero direct provider calls from agent code.
- **SC-002**: The correct provider and model are selected for 100% of requests when the routing configuration is valid and at least one provider is available for the requested task type.
- **SC-003**: Transient failures are transparently recovered: a request that fails twice before succeeding on the third attempt is returned successfully to the caller with no error surfaced.
- **SC-004**: When structured output is requested with a valid schema, the response contains a fully parsed data object in 100% of cases where the AI returns valid JSON (including JSON wrapped in code blocks).
- **SC-005**: Every successful AI call produces a corresponding log entry in the audit store within the same request lifecycle.
- **SC-006**: A logging failure results in zero impact on AI response delivery — the caller receives the response regardless of whether logging succeeded.
- **SC-007**: When all configured providers are unavailable, the service returns a clear, identifiable error within the configured timeout period.
- **SC-008**: The service supports at least three registered providers simultaneously, each with independent routing and fallback chains.
- **SC-009**: When multiple agents submit concurrent requests to the same provider, requests beyond the configured concurrency limit are handled (queued or rerouted) without data loss or silent failure.

## Clarifications

### Session 2026-04-10

- Q: How should rate-limit errors (provider quota exhaustion) be handled relative to the retry strategy? → A: Treat as retryable with extended backoff (longer wait than standard transient errors), counting against the same retry budget; fallback activates if the budget is exhausted.
- Q: Should sensitive case data in LLM request/response content be redacted before writing to the audit log? → A: No — store full content unredacted. Data protection is enforced at the deployment and access-control level, not at the log level. Full content is required for compliance reconstructability.
- Q: How should the service handle concurrent LLM requests from multiple agents running in parallel? → A: Concurrent calls are supported; each provider has a configurable maximum concurrent request limit. Requests beyond that limit queue or fail rather than overwhelming the provider.
- Q: What should happen when a provider availability check hangs or exceeds expected duration? → A: Availability checks enforce a configurable short timeout. A timeout is treated as "provider unavailable", triggering immediate fallback to the next provider rather than blocking routing.
- Q: Should the service expose operational metrics (error rates, latency, concurrency) as a separate signal beyond audit logging? → A: No separate metrics surface. Operational signals are derived from the existing audit log in the event store; no parallel metrics layer is required.

## Assumptions

- Routing configuration (which provider handles which task type, retry limits, timeouts) is loaded from an external configuration file at startup, not hardcoded.
- Audit log entries store full request and response content without redaction. The system's data-sovereign, self-hosted deployment model is the primary data protection mechanism; access to the event store is controlled at the infrastructure level.
- The event store (audit log) is already implemented and available as a dependency; this feature integrates with it but does not define it.
- Prompt formatting differences between AI models are handled by a prompt adapter layer that is already available; this feature consumes adapters but does not define them.
- Provider availability checks enforce a configurable short timeout. A check that exceeds this timeout is treated as "provider unavailable", triggering immediate fallback rather than blocking routing. The service does not implement long-running health polling.
- Retry and fallback behavior applies only to transient errors (network failures, timeouts, server-side errors); non-retryable errors fail immediately without retry.
- Only one instance of this service exists at runtime; all agents share the same instance and its registered providers.
- The five task types (reasoning, extraction, screening, classification, summarization) cover all LLM use cases required by the platform at this stage; adding new task types requires only configuration changes.
- The YAML configuration loader is available as a dependency; this feature consumes a pre-loaded configuration object and does not own the file-reading logic.
- No separate operational metrics surface is required. Error rates, latency trends, and provider health signals are derived by querying the event store audit log; no additional observability infrastructure is in scope.
