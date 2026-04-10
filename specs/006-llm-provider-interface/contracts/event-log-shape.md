# Contract: llm_call Event Log Shape

**Written by**: `LLMService._logCall()`  
**Written to**: `decision_events` table via `eventStore.appendEvent()`  
**Event type**: `llm_call`  
**Consumers**: Compliance audit trail, operational dashboards querying the event store

This event is written after every successful LLM call (including calls that succeeded via fallback). Logging failures are silently swallowed — they must not break the LLM response delivery.

---

## `appendEvent` Call Signature

```javascript
await eventStore.appendEvent(
  caseId,        // string — from LLMCallContext.caseId
  agentType,     // string — from LLMCallContext.agentType (falls back to 'unknown')
  stepId,        // string — from LLMCallContext.stepId (falls back to 'unknown')
  'llm_call',    // event type constant
  payload        // object — see shape below
);
```

---

## Payload Shape

```javascript
{
  // Which provider ultimately handled the request.
  // If fallback was used, this is the fallback provider name, NOT the default.
  provider: string,

  // Exact model string used (e.g., "llama3.1:70b", "gpt-4o-mini")
  model: string,

  // Task type from the original request
  taskType: LLMTaskType,

  // Which attempt succeeded (1 = first try, 2 = first retry, etc.)
  attempt: number,

  // Full request content (unredacted — data protection enforced at deployment level)
  request: {
    messages: LLMMessage[],      // Full conversation array
    temperature: number,          // Temperature used (after default applied)
    maxTokens: number | undefined // Token limit if specified
  },

  // Full response content
  response: {
    content: string,              // Raw text from the model (unredacted)
    structured: Object | undefined, // Parsed JSON object if structuredOutput was requested
    usage: {
      promptTokens: number,
      completionTokens: number,
      totalTokens: number
    },
    latencyMs: number             // End-to-end wall-clock time including all retry delays
  }
}
```

---

## Notes

- `attempt` value reflects which attempt of the winning provider succeeded. If the default provider failed 3 times and the fallback succeeded on attempt 1, `attempt` = 1 (the fallback's first attempt).
- `provider` always reflects the provider that produced the successful response. The default provider name is NOT recorded if fallback was used.
- `structured` is `undefined` (omitted) when no `structuredOutput` schema was included in the request.
- All content is stored unredacted per clarification Q2 — the event store inherits the deployment boundary's data protection guarantees.
- If `LLMCallContext.caseId` is absent or falsy, the event is not written (logging is skipped silently).
