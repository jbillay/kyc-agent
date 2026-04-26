# Data Model: LLM Call Logging

**Feature**: 009-llm-call-logging  
**Date**: 2026-04-22

## `llm_call` Event Payload

Stored as a JSONB object in `decision_events.data`. Written by `LLMService._logCall()` (success path) and `LLMService._logFailedCall()` (failure path).

### Success Variant

```
LLMCallPayload (success)
├── status: 'success'                  (string, always present)
├── provider: string                   (the provider that responded)
├── originalProvider?: string          (the default provider, ONLY present when fallback was used)
├── model: string                      (model identifier, e.g., 'llama3.1:8b')
├── taskType: LLMTaskType              ('reasoning' | 'extraction' | 'screening' | 'classification' | 'summarization')
├── attempt: number                    (1-based; retry attempt that succeeded)
├── request
│   ├── messages: LLMMessage[]         (may be redacted — see Redaction below)
│   ├── temperature: number
│   └── maxTokens?: number
└── response
    ├── content: string                (may be redacted)
    ├── structured?: object            (may be redacted)
    ├── usage
    │   ├── promptTokens: number       (NEVER redacted)
    │   ├── completionTokens: number   (NEVER redacted)
    │   └── totalTokens: number        (NEVER redacted)
    └── latencyMs: number              (NEVER redacted)
```

### Failure Variant

```
LLMCallPayload (failure)
├── status: 'failed'                   (string, always present)
├── provider: string                   (the provider that was attempted)
├── originalProvider?: string          (present if this was a fallback attempt)
├── model: string
├── taskType: LLMTaskType
├── attempt: number                    (1 for non-retryable or fallback; maxAttempts for exhausted retries)
├── error: string                      (lastError.message)
└── request
    ├── messages: LLMMessage[]         (may be redacted)
    ├── temperature: number
    └── maxTokens?: number
```

Note: `response` is absent from failure variant.

**Per-attempt event semantics**: Each failed provider attempt produces its own discrete `llm_call` event. A call sequence where the primary provider fails and a fallback provider also fails produces **two** `status: 'failed'` events — one per provider. This is intentional: each event captures the exact provider, model, and error for that attempt, giving complete traceability.

## Redaction Rules

When enabled via configuration, redaction replaces content while preserving structure and metadata.

| Field | Condition | Behaviour |
|-------|-----------|-----------|
| `request.messages[*].content` | `redact_prompts: true` | Replaced with `'[REDACTED]'`; `role` preserved |
| `response.content` | `redact_responses: true` | Replaced with `'[REDACTED]'` |
| `response.structured` | `redact_responses: true` and structured is truthy | Replaced with `'[REDACTED]'` |
| `response.usage` | Never | Always preserved in full |
| `response.latencyMs` | Never | Always preserved |
| `provider`, `model`, `taskType`, `attempt`, `status` | Never | Always preserved |

## `decision_events` Row Shape

```
Column        Value
──────────────────────────────────────────────────
case_id       context.caseId
agent_type    context.agentId ?? 'unknown'
step_id       context.stepId  ?? 'unknown'
event_type    'llm_call'
timestamp     NOW() (database-generated)
data          LLMCallPayload (JSONB)
sequence_num  auto-increment (enforced append-only)
```

## Configuration Entity

Stored in `config/llm.yaml` under the `logging:` key:

```
LoggingConfig
├── redact_prompts: boolean   (default: false)
└── redact_responses: boolean (default: false)
```

Loaded once at `LLMService` construction time as `config.logging`. Absent config is treated as `null` (no redaction).
