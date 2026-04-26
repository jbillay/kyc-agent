# Contract: `llm_call` Event Store Entry

**Feature**: 009-llm-call-logging  
**Date**: 2026-04-22  
**Consumer**: Any code querying `decision_events` for audit trail reconstruction

## Interface: `eventStore.appendEvent`

```js
/**
 * Called by LLMService._logCall() and LLMService._logFailedCall().
 *
 * @param {string}  caseId     - context.caseId
 * @param {string}  agentType  - context.agentId ?? 'unknown'
 * @param {string}  stepId     - context.stepId  ?? 'unknown'
 * @param {string}  eventType  - always 'llm_call'
 * @param {LLMCallPayload} data
 */
eventStore.appendEvent(caseId, agentType, stepId, 'llm_call', data);
```

## `LLMCallPayload` Schema

### Shared fields (both success and failure)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `status` | `'success' \| 'failed'` | Yes | |
| `provider` | string | Yes | Provider that responded (or last attempted) |
| `originalProvider` | string | No | Default provider name; only present when fallback was used |
| `model` | string | Yes | Model identifier |
| `taskType` | string | Yes | One of: `reasoning`, `extraction`, `screening`, `classification`, `summarization` |
| `attempt` | number | Yes | 1-based retry attempt number |
| `request.messages` | array | Yes | May be `[{role, content: '[REDACTED]'}]` if redaction enabled |
| `request.temperature` | number | Yes | |
| `request.maxTokens` | number | No | |

### Additional fields on success (`status: 'success'`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `response.content` | string | Yes | May be `'[REDACTED]'` if redaction enabled |
| `response.structured` | object | No | May be `'[REDACTED]'` if redaction enabled |
| `response.usage.promptTokens` | number | Yes | Never redacted |
| `response.usage.completionTokens` | number | Yes | Never redacted |
| `response.usage.totalTokens` | number | Yes | Never redacted |
| `response.latencyMs` | number | Yes | Never redacted |

### Additional fields on failure (`status: 'failed'`)

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `error` | string | Yes | `lastError.message` |

## Query Patterns

```js
// All LLM calls for a case
const events = await eventStore.getEventsByCase(caseId, { eventType: 'llm_call' });

// All LLM calls for a specific agent step
const events = await eventStore.getEventsByCase(caseId, {
  eventType: 'llm_call',
  agentType: 'entity-resolution',
  stepId: 'evaluate_candidates',
});

// Detect fallback usage (JSONB query)
// WHERE event_type = 'llm_call' AND data ? 'originalProvider'

// Detect failures
// WHERE event_type = 'llm_call' AND data->>'status' = 'failed'
```

## Guarantees

- Exactly one `llm_call` event per successful `LLMService.complete()` call with a valid `caseId`.
- One `llm_call` event with `status: 'failed'` per failed provider attempt when `caseId` is present (primary failure + fallback failure are each logged separately).
- Events are immutable after write — PostgreSQL append-only rules prevent UPDATE/DELETE.
- Logging failures are silently swallowed; a failed log write never prevents the LLM response from being returned.

## Access Policy

Read access to `llm_call` events is restricted to `compliance_officer` and `admin` roles. `analyst` and `senior_analyst` roles MUST NOT have direct access to raw LLM call payloads (which may contain PII in unredacted prompt text).

**Enforcement responsibility**: The API layer (Layer 5 — audit trail endpoint). `LLMService` (Layer 1) defines this policy but does not enforce it; enforcement is implemented in the Fastify route handler for audit trail queries.
