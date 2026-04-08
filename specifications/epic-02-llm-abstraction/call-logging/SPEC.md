# LLM Call Logging for Audit Trail

> GitHub Issue: [#11](https://github.com/jbillay/kyc-agent/issues/11)
> Epic: LLM Abstraction Layer (#7)
> Size: S (less than 1 day) | Priority: Critical

## Context

Every LLM interaction must be recorded for regulatory audit purposes. When a compliance officer or regulator asks "why did the system make this decision?", the answer must be traceable back to the exact LLM prompt, response, and model that produced it. This is a first-class architectural concern — the logging is built into the `LLMService` itself, not bolted on by agents.

The logging uses the append-only `decision_events` table, which has SQL rules preventing UPDATE and DELETE operations. Once a log entry is written, it is immutable.

## Requirements

### Functional

1. Every LLM call automatically logs an `llm_call` event to `decision_events`
2. Log includes: caseId, agentId, stepId, provider, model, taskType, full request, full response, usage, latency
3. Logging is transparent — agents do not need to call any logging functions
4. Logging failures must not break the LLM call (fail-open for logging)
5. Optional sensitive data redaction via configuration

### Non-Functional

- Logging adds less than 10ms overhead per call (async write)
- Log entries are immutable (enforced by database rules)
- Log volume: expect ~20-50 LLM calls per case, ~100 cases/day at peak = ~5000 events/day

## Technical Design

### Event Structure

The `llm_call` event is stored in the `decision_events` table with this `data` payload:

```javascript
/**
 * @typedef {Object} LLMCallLog
 * @property {string} id - Auto-generated UUID
 * @property {string} timestamp - ISO 8601
 * @property {string} caseId - Case this call belongs to
 * @property {string} agentId - Agent that made the call (e.g., 'entity-resolution')
 * @property {string} stepId - Step within the agent (e.g., 'evaluate_candidates')
 * @property {string} provider - Provider name (e.g., 'ollama')
 * @property {string} model - Model used (e.g., 'mistral-nemo:12b')
 * @property {LLMTaskType} taskType - Task type for routing
 * @property {number} attempt - Retry attempt number (1 = first try)
 * @property {Object} request
 * @property {LLMMessage[]} request.messages - Full prompt messages
 * @property {number} request.temperature
 * @property {number} [request.maxTokens]
 * @property {Object} response
 * @property {string} response.content - Full LLM response text
 * @property {Object} [response.structured] - Parsed structured output
 * @property {Object} response.usage - Token counts
 * @property {number} response.latencyMs
 */
```

### Database Row

```
decision_events table:
┌─────────────┬──────────────────────┐
│ Column       │ Value                │
├─────────────┼──────────────────────┤
│ case_id      │ (from context)       │
│ agent_type   │ (from context)       │
│ step_id      │ (from context)       │
│ event_type   │ 'llm_call'           │
│ timestamp    │ NOW()                │
│ data         │ { LLMCallLog JSONB } │
│ sequence_num │ auto-increment       │
└─────────────┴──────────────────────┘
```

### Integration Point

Logging is performed inside `LLMService.complete()` after a successful response (see provider-interface spec). The relevant code section:

```javascript
// In LLMService._logCall()
async _logCall(request, response, context, attempt, fallbackProvider) {
  if (!this.eventStore || !context?.caseId) return;

  const data = {
    provider: fallbackProvider || response.provider,
    model: response.model,
    taskType: request.taskType,
    attempt,
    request: this._redactIfNeeded({
      messages: request.messages,
      temperature: request.temperature ?? 0.1,
      maxTokens: request.maxTokens,
    }),
    response: this._redactIfNeeded({
      content: response.content,
      structured: response.structured,
      usage: response.usage,
      latencyMs: response.latencyMs,
    }),
  };

  try {
    await this.eventStore.appendEvent(
      context.caseId,
      context.agentId || 'unknown',
      context.stepId || 'unknown',
      'llm_call',
      data
    );
  } catch (err) {
    // Logging must never break the LLM call
    console.error('Failed to log LLM call:', err.message);
  }
}
```

### Sensitive Data Redaction

When enabled via configuration, the logger redacts prompt content and response text while preserving metadata:

```yaml
# config/llm.yaml
llm:
  logging:
    redact_prompts: false    # When true, replaces message content with "[REDACTED]"
    redact_responses: false  # When true, replaces response content with "[REDACTED]"
```

```javascript
/**
 * Redact sensitive content from log data if configured.
 * Preserves structure and metadata (usage, latency, model) while
 * replacing message text with "[REDACTED]".
 */
_redactIfNeeded(data) {
  if (!this.redactionConfig) return data;

  const result = { ...data };

  if (this.redactionConfig.redact_prompts && result.messages) {
    result.messages = result.messages.map((m) => ({
      ...m,
      content: '[REDACTED]',
    }));
  }

  if (this.redactionConfig.redact_responses && result.content) {
    result.content = '[REDACTED]';
    result.structured = result.structured ? '[REDACTED]' : undefined;
  }

  return result;
}
```

### When Logging Does NOT Happen

- `context` is null or missing `caseId` — some internal/test calls may not have a case context
- Event store is not configured (e.g., during unit tests)
- Event store write fails — error is logged to console but the LLM response is still returned

### Querying Logged Calls

LLM calls for a case can be retrieved via the event store:

```javascript
// Get all LLM calls for a case
const events = await eventStore.getEventsByCase(caseId, { eventType: 'llm_call' });

// Get LLM calls for a specific agent step
const events = await eventStore.getEventsByCase(caseId, {
  eventType: 'llm_call',
  agentType: 'entity-resolution',
  stepId: 'evaluate_candidates',
});
```

## Interfaces

### Event Store Integration

The logging uses the event store `appendEvent` method (defined in story #25):

```javascript
/**
 * @param {string} caseId
 * @param {string} agentType
 * @param {string} stepId
 * @param {string} eventType - 'llm_call' for LLM logging
 * @param {Object} data - LLMCallLog payload
 */
eventStore.appendEvent(caseId, agentType, stepId, 'llm_call', data);
```

### Configuration

| Config Path | Type | Default | Purpose |
|-------------|------|---------|---------|
| `llm.logging.redact_prompts` | boolean | `false` | Replace prompt text with `[REDACTED]` |
| `llm.logging.redact_responses` | boolean | `false` | Replace response text with `[REDACTED]` |

## Acceptance Criteria

- [ ] Every successful `LLMService.complete()` call writes an `llm_call` event to `decision_events`
- [ ] Event `data` includes: provider, model, taskType, attempt number, full request (messages, temperature, maxTokens), full response (content, structured, usage, latencyMs)
- [ ] Logging is automatic — agents call `LLMService.complete()` and logging happens internally
- [ ] If event store write fails, the LLM response is still returned (fail-open)
- [ ] If context is missing `caseId`, logging is silently skipped
- [ ] When `redact_prompts: true`, logged messages have `content: '[REDACTED]'`
- [ ] When `redact_responses: true`, logged response has `content: '[REDACTED]'`
- [ ] Metadata (usage, latency, model, provider) is never redacted
- [ ] Logged events are queryable by caseId, agentType, stepId via event store

## Dependencies

- **Depends on**: #8 (Provider interface — logging is wired into `LLMService`), #25 (Event store service — `appendEvent` method), #3 (Database — `decision_events` table)
- **Blocks**: Nothing directly, but all agents benefit from logging being in place

## Testing Strategy

1. **Logging on success**: Mock event store, call `LLMService.complete()`, verify `appendEvent` called with correct shape
2. **Log content**: Verify logged data includes full messages, temperature, usage, latency, model, provider
3. **Attempt tracking**: On retry, verify attempt number increments in log
4. **Fail-open test**: Mock event store to throw, verify LLM response still returned
5. **No context test**: Call without `caseId` in context, verify no logging attempt
6. **Redaction test (prompts)**: Enable `redact_prompts`, verify message content is `[REDACTED]` but role is preserved
7. **Redaction test (responses)**: Enable `redact_responses`, verify response content is `[REDACTED]` but usage/latency preserved
8. **Query test**: Log 3 calls for a case, query by case — verify all 3 returned in order
