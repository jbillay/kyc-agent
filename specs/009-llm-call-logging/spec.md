# Feature Specification: LLM Call Logging for Audit Trail

**Feature Branch**: `009-llm-call-logging`  
**Created**: 2026-04-22  
**Status**: Draft  
**Input**: User description: "@specifications/epic-02-llm-abstraction/call-logging/SPEC.md"

## Clarifications

### Session 2026-04-22

- Q: Should calls that fail entirely (all retries exhausted, no LLM response) also be logged? → A: Yes — log with `status: 'failed'`, request context, and final error message; omit response fields.
- Q: When a fallback provider is used, what does the `provider` field in the log entry contain? → A: The fallback provider name (the one that actually responded), plus a separate `originalProvider` field recording what was originally attempted.
- Q: Should persistent logging failures produce any additional observable signal beyond `console.error`? → A: No — `console.error` per failed write is sufficient; operational alerting is delegated to event store health checks and log aggregation.
- Q: When a primary provider fails and a fallback is attempted but also fails, how many `llm_call` events are written? → A: One event per failed provider attempt — primary failure and each fallback failure are logged separately, not as a single terminal event.
- Q: What is the canonical term for the field that identifies which agent produced an LLM call? → A: `agentId` — the caller-supplied identifier present in the call context (e.g., `context.agentId`). Storage column names and query parameter names are implementation details defined in data-model.md and contracts/.
- Q: Which roles should have read access to raw `llm_call` events in the audit trail? → A: `compliance_officer` and `admin` only. Raw LLM call logs may contain PII in prompt text; restricting read access to compliance-focused roles reduces data exposure. Analysts access decisions through the Decision Fragment layer, not raw LLM logs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Automatic LLM Call Recording (Priority: P1)

A compliance officer reviewing a KYC case needs to trace every AI decision back to the exact prompt, model response, and model that produced it. Every time the system makes an LLM call, a complete log entry is automatically written — without any agent needing to request it explicitly. This record is immutable: once written, it cannot be modified or deleted.

**Why this priority**: Regulatory traceability is the core justification for the entire feature. Without automatic logging, the audit trail is incomplete and the system cannot meet compliance requirements.

**Independent Test**: Can be fully tested by triggering a single `LLMService.complete()` call with a valid case context and verifying a corresponding `llm_call` event appears in the event store with the correct payload shape.

**Acceptance Scenarios**:

1. **Given** an LLM call is made with a valid `caseId` in context, **When** `LLMService.complete()` returns a successful response, **Then** an `llm_call` event is written to the event store containing the provider, model, task type, full request messages, temperature, response content, usage statistics, and latency.
2. **Given** an LLM call completes successfully, **When** a compliance officer queries the event store for that case, **Then** the logged event is present, immutable, and ordered by sequence number.
3. **Given** agents call `LLMService.complete()`, **When** reviewing agent source code, **Then** no agent explicitly invokes any logging function — logging is entirely internal to `LLMService`.

---

### User Story 2 - Resilient Logging That Never Blocks Decisions (Priority: P2)

An analyst is processing a time-sensitive KYC case. The audit logging infrastructure is temporarily unavailable. The LLM must still return its response so the agent can continue working — a logging failure must never halt case processing.

**Why this priority**: The system is a decision-making pipeline. Blocking a case because logging failed would cause operational disruption disproportionate to the logging failure itself.

**Independent Test**: Can be fully tested by configuring the event store to throw on write, calling `LLMService.complete()`, and verifying the LLM response is still returned while an error is emitted to the console.

**Acceptance Scenarios**:

1. **Given** the event store throws an error on write, **When** `LLMService.complete()` is called, **Then** the LLM response is returned to the caller and a console error message is emitted — the call does not throw or fail.
2. **Given** no event store is configured (e.g., during unit tests), **When** `LLMService.complete()` is called, **Then** logging is silently skipped and the LLM response is returned normally.
3. **Given** context is provided without a `caseId`, **When** `LLMService.complete()` is called, **Then** logging is silently skipped and the LLM response is returned normally.

---

### User Story 3 - Retry Attempt Tracking (Priority: P2)

A reliability engineer investigating why a case took longer than expected needs to know whether an LLM call succeeded on the first attempt or required retries. Each logged event includes the attempt number so retry patterns are visible in the audit trail.

**Why this priority**: Retry visibility enables both operational diagnostics and compliance transparency — regulators may ask whether a decision required multiple attempts and which provider ultimately served the response.

**Independent Test**: Can be fully tested by configuring a provider to fail once then succeed, triggering `LLMService.complete()`, and verifying the successful event has `attempt: 2`.

**Acceptance Scenarios**:

1. **Given** the first provider attempt fails and a second attempt succeeds, **When** reviewing logged events for the case, **Then** the successful event's `attempt` field reflects the correct attempt number (e.g., `2`).
2. **Given** an LLM call succeeds on the first try, **When** reviewing the logged event, **Then** the `attempt` field is `1`.

---

### User Story 4 - Sensitive Data Redaction (Priority: P3)

A compliance officer deploying the system in a jurisdiction with strict data residency rules needs to ensure that prompt content and LLM responses are not stored in the audit log. An administrator can enable redaction via configuration, replacing prompt messages and response text with a placeholder while preserving all metadata (model, usage, latency, provider).

**Why this priority**: Redaction is a deployment-time compliance option. Most deployments do not need it, but those that do cannot operate without it.

**Independent Test**: Can be fully tested by enabling `redact_prompts` and `redact_responses` in configuration, making an LLM call, and verifying the logged event has `[REDACTED]` in message content and response content fields while model, usage, and latency remain intact.

**Acceptance Scenarios**:

1. **Given** `redact_prompts: true` is configured, **When** an LLM call is logged, **Then** each message in the logged request has `content: '[REDACTED]'` but its `role` field is preserved.
2. **Given** `redact_responses: true` is configured, **When** an LLM call is logged, **Then** the logged response has `content: '[REDACTED]'` and any structured output is also redacted, but `usage` and `latencyMs` are unchanged.
3. **Given** neither redaction option is enabled (default), **When** an LLM call is logged, **Then** full message content and response content are stored as-is.

---

### Edge Cases

- What happens when `caseId` is present but `agentId` or `stepId` are missing? → Log the event with `'unknown'` substituted for the missing fields.
- What happens when the LLM response is malformed or missing usage data? → Log what is available; partial data is acceptable — do not throw.
- What happens when logging is called concurrently for multiple cases? → Each write is independent; no cross-case interference is expected.
- How does the system handle high log volume (~5,000 events/day)? → Logging is async fire-and-forget; the calling agent does not wait for the write to complete.
- What happens when all retry attempts are exhausted and no LLM response is returned? → A `llm_call` event is still written with `status: 'failed'`, containing the request context and final error message; all response fields are omitted.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST automatically log an `llm_call` event to the event store for every `LLMService.complete()` call that includes a `caseId` in context — both successful calls and every failed provider attempt (primary failure, each individual fallback failure, and terminal all-retries-exhausted failures). Successful calls include `status: 'success'` with full request and response fields. Failed calls include `status: 'failed'` with request context and the final error message; response fields are omitted. Each failed provider attempt produces its own discrete event.
- **FR-002**: Each log entry MUST include: `status` (`'success'` or `'failed'`), `provider` (the provider that responded or was last attempted), optional `originalProvider` (the originally-configured provider, present only when a fallback was used), `model`, `taskType`, `attempt` number, and full request (`messages`, `temperature`, optional `maxTokens`). Successful entries additionally include full response (`content`, optional `structured`, `usage`, `latencyMs`). Failed entries additionally include an `error` field containing the final error message.
- **FR-003**: Logging MUST be transparent — agents MUST NOT need to call any logging function; all logging is internal to `LLMService`.
- **FR-004**: If the event store write fails, the system MUST still return the LLM response to the caller and MUST emit a `console.error` message — logging failures MUST NOT propagate as exceptions. No additional signal beyond `console.error` is required; operational alerting is the responsibility of event store health checks and external log aggregation.
- **FR-005**: If `context` is null or does not contain a `caseId`, the system MUST silently skip logging without error.
- **FR-006**: If no event store is configured, the system MUST silently skip logging without error.
- **FR-007**: When `redact_prompts` is enabled via configuration, logged request messages MUST have their `content` replaced with `'[REDACTED]'` while preserving all other message fields (e.g., `role`).
- **FR-008**: When `redact_responses` is enabled via configuration, the logged response `content` MUST be replaced with `'[REDACTED]'` and any structured output MUST also be redacted; metadata (`usage`, `latencyMs`, `model`, `provider`) MUST never be redacted regardless of configuration.
- **FR-009**: Logged events MUST be queryable by `caseId`, `agentId`, and `stepId` via the event store. Read access to raw `llm_call` events MUST be restricted to the `compliance_officer` and `admin` roles; `analyst` and `senior_analyst` roles MUST NOT have direct access to raw LLM call payloads.
- **FR-010**: Log writes MUST be asynchronous and MUST add less than 10 ms of overhead per LLM call.

### Key Entities

- **LLM Call Log Entry**: Represents a single LLM invocation, linked to a case, agent, and step. Attributes: `status` ('success' or 'failed'), `provider` (responding provider), optional `originalProvider` (configured provider when a fallback was used), `model`, `taskType`, `attempt`, `request` (messages, temperature, maxTokens), `response` (content, structured, usage, latencyMs — present on success), `error` (final error message — present on failure). Stored as a structured payload in the event store under event type `llm_call`.
- **Redaction Configuration**: A deployment-level setting controlling whether prompt and/or response content is replaced with `'[REDACTED]'` in stored log entries. Attributes: `redact_prompts` (boolean, default `false`), `redact_responses` (boolean, default `false`).
- **Call Context**: Provided by the calling agent at invocation time. Attributes: `caseId` (required for logging to occur), `agentId` (optional, defaults to `'unknown'`), `stepId` (optional, defaults to `'unknown'`).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every LLM call attempt made with a valid case context results in exactly one `llm_call` event recorded in the audit trail — both successful and fully-failed calls are captured; zero calls are silently dropped.
- **SC-002**: Logging adds no more than 10 ms of latency to any individual LLM call under normal operating conditions.
- **SC-003**: At peak load (~5,000 LLM call events per day), no log entries are lost due to write contention or queue overflow.
- **SC-004**: A compliance officer can retrieve all LLM calls for a given case, filtered by agent and step, in a single query — 100% of logged calls are addressable by case, agent type, and step.
- **SC-005**: When logging infrastructure fails, 100% of in-flight LLM calls complete and return results to their callers — zero cases are blocked by logging failures.
- **SC-006**: When redaction is enabled, 100% of stored prompt and response content fields contain `'[REDACTED]'` — no raw text leaks into the log.
- **SC-007**: Logged events are immutable — zero events can be updated or deleted after being written.

## Assumptions

- The event store service (`appendEvent` method) is implemented and available as a dependency injected into `LLMService`; this feature does not implement the event store itself.
- The `decision_events` table and its append-only constraints are already in place from prior infrastructure work.
- Redaction configuration is loaded from `config/llm.yaml` and provided to `LLMService` at initialization time; no runtime configuration changes are expected.
- Logging overhead targets (<10 ms) are achievable because writes are async fire-and-forget — `LLMService` does not await the log write before returning the response.
- Unit tests for this feature will use a mock event store; end-to-end tests against a live database are out of scope for this story.
- The `attempt` number is already tracked internally by `LLMService` as part of its existing retry logic.
- Log volume of ~5,000 events/day is the expected upper bound; no special batching or write buffering is required at this scale.
- RBAC enforcement for reading `llm_call` events (restricted to `compliance_officer` and `admin`) is the responsibility of the API layer (Layer 5), not `LLMService`. This feature defines the access policy; enforcement is implemented in the audit trail API endpoint.
