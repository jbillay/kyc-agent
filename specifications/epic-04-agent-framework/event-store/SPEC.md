# Event Store Service for Immutable Audit Logging

> GitHub Issue: [#25](https://github.com/jbillay/kyc-agent/issues/25)
> Epic: Agent Framework Core (#20)
> Size: M (1-3 days) | Priority: Critical

## Context

Regulated financial institutions must provide complete audit trails to regulators. The event store captures every action taken on every case — agent steps, LLM calls, data fetches, state changes, review actions — as immutable, sequentially numbered events in the `decision_events` table. PostgreSQL rules prevent UPDATE and DELETE at the SQL level, so even direct database access cannot tamper with the trail.

## Requirements

### Functional

1. `appendEvent(caseId, agentType, stepId, eventType, data)` — append an event
2. `getEventsByCase(caseId, filters)` — query events with filters
3. `getEventTimeline(caseId)` — chronological timeline for a case
4. `exportCaseAudit(caseId, format)` — export to JSON format
5. Event types: `fragment`, `llm_call`, `data_fetch`, `state_change`, `review_action`, `config_change`
6. Events are append-only — no updates or deletes at application level
7. Database rules prevent UPDATE/DELETE at SQL level
8. Sequential numbering via `sequence_number` for guaranteed ordering

### Non-Functional

- Event appends complete in under 10ms (single INSERT)
- Query by case returns results in under 100ms for cases with < 1000 events
- Export handles cases with up to 10,000 events
- Fail-open from agent perspective: event store errors don't crash agents

## Technical Design

### File: `backend/src/services/event-store.js`

```javascript
const { pool } = require('../db/connection');

// ─── Event Types ────────────────────────────────────

const EventType = {
  FRAGMENT: 'fragment',
  LLM_CALL: 'llm_call',
  DATA_FETCH: 'data_fetch',
  STATE_CHANGE: 'state_change',
  REVIEW_ACTION: 'review_action',
  CONFIG_CHANGE: 'config_change',
  AGENT_ERROR: 'agent_error',
  STEP_STARTED: 'step_started',
  STEP_COMPLETED: 'step_completed',
  STEP_FAILED: 'step_failed',
};

/**
 * Append an event to the immutable audit log.
 *
 * The decision_events table has PostgreSQL rules that prevent UPDATE and DELETE,
 * so once written, events cannot be modified through any means.
 *
 * @param {string} caseId
 * @param {string} agentType - e.g., 'entity-resolution', 'orchestrator'
 * @param {string|null} stepId - Agent step ID (null for orchestrator events)
 * @param {string} eventType - One of EventType values
 * @param {Object} data - Event payload (stored as JSONB)
 * @returns {Promise<{ id: string, sequenceNumber: number }>}
 */
async function appendEvent(caseId, agentType, stepId, eventType, data) {
  const result = await pool.query(
    `INSERT INTO decision_events
       (case_id, agent_type, step_id, event_type, event_data, created_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     RETURNING id, sequence_number`,
    [caseId, agentType, stepId || null, eventType, JSON.stringify(data)]
  );

  return {
    id: result.rows[0].id,
    sequenceNumber: result.rows[0].sequence_number,
  };
}

/**
 * Get events for a case with optional filters.
 *
 * @param {string} caseId
 * @param {Object} [filters]
 * @param {string} [filters.eventType]
 * @param {string} [filters.agentType]
 * @param {string} [filters.fromDate] - ISO 8601
 * @param {string} [filters.toDate] - ISO 8601
 * @param {number} [filters.limit=500]
 * @param {number} [filters.offset=0]
 * @returns {Promise<{ events: AuditEvent[], total: number }>}
 */
async function getEventsByCase(caseId, filters = {}) {
  const conditions = ['case_id = $1'];
  const params = [caseId];
  let paramIndex = 2;

  if (filters.eventType) {
    conditions.push(`event_type = $${paramIndex++}`);
    params.push(filters.eventType);
  }
  if (filters.agentType) {
    conditions.push(`agent_type = $${paramIndex++}`);
    params.push(filters.agentType);
  }
  if (filters.fromDate) {
    conditions.push(`created_at >= $${paramIndex++}`);
    params.push(filters.fromDate);
  }
  if (filters.toDate) {
    conditions.push(`created_at <= $${paramIndex++}`);
    params.push(filters.toDate);
  }

  const where = conditions.join(' AND ');
  const limit = filters.limit || 500;
  const offset = filters.offset || 0;

  const [countResult, dataResult] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM decision_events WHERE ${where}`, params),
    pool.query(
      `SELECT id, case_id, agent_type, step_id, event_type, event_data,
              sequence_number, created_at
       FROM decision_events
       WHERE ${where}
       ORDER BY sequence_number ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    ),
  ]);

  return {
    events: dataResult.rows.map(_mapEvent),
    total: parseInt(countResult.rows[0].count, 10),
  };
}

/**
 * Get a chronological timeline for a case.
 *
 * Returns a simplified, human-readable view of all events in order.
 *
 * @param {string} caseId
 * @returns {Promise<TimelineEntry[]>}
 */
async function getEventTimeline(caseId) {
  const result = await pool.query(
    `SELECT id, agent_type, step_id, event_type, event_data,
            sequence_number, created_at
     FROM decision_events
     WHERE case_id = $1
     ORDER BY sequence_number ASC`,
    [caseId]
  );

  return result.rows.map((row) => {
    const data = typeof row.event_data === 'string'
      ? JSON.parse(row.event_data)
      : row.event_data;

    return {
      sequenceNumber: row.sequence_number,
      timestamp: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
      eventType: row.event_type,
      agentType: row.agent_type,
      summary: _summarizeEvent(row.event_type, data),
      data,
    };
  });
}

/**
 * Export a full case audit trail as JSON.
 *
 * @param {string} caseId
 * @param {'json'} [format='json']
 * @returns {Promise<Object>}
 */
async function exportCaseAudit(caseId, format = 'json') {
  const [caseResult, eventsResult] = await Promise.all([
    pool.query(`SELECT * FROM cases WHERE id = $1`, [caseId]),
    pool.query(
      `SELECT id, case_id, agent_type, step_id, event_type, event_data,
              sequence_number, created_at
       FROM decision_events
       WHERE case_id = $1
       ORDER BY sequence_number ASC`,
      [caseId]
    ),
  ]);

  if (caseResult.rows.length === 0) {
    throw Object.assign(new Error('Case not found'), { code: 'NOT_FOUND' });
  }

  const caseData = caseResult.rows[0];
  const events = eventsResult.rows.map(_mapEvent);

  // Group events by type for summary statistics
  const eventCounts = {};
  for (const event of events) {
    eventCounts[event.eventType] = (eventCounts[event.eventType] || 0) + 1;
  }

  return {
    exportedAt: new Date().toISOString(),
    format: 'kyc-agent-audit-v1',
    case: {
      id: caseData.id,
      clientName: caseData.client_name,
      jurisdiction: caseData.jurisdiction,
      state: caseData.state,
      createdAt: caseData.created_at?.toISOString(),
      updatedAt: caseData.updated_at?.toISOString(),
    },
    summary: {
      totalEvents: events.length,
      eventCounts,
      firstEvent: events[0]?.timestamp || null,
      lastEvent: events[events.length - 1]?.timestamp || null,
    },
    events,
  };
}

// ─── Internal ───────────────────────────────────────

/**
 * @typedef {Object} AuditEvent
 * @property {string} id
 * @property {string} caseId
 * @property {string} agentType
 * @property {string|null} stepId
 * @property {string} eventType
 * @property {Object} data
 * @property {number} sequenceNumber
 * @property {string} timestamp
 */

function _mapEvent(row) {
  return {
    id: row.id,
    caseId: row.case_id,
    agentType: row.agent_type,
    stepId: row.step_id || null,
    eventType: row.event_type,
    data: typeof row.event_data === 'string' ? JSON.parse(row.event_data) : row.event_data,
    sequenceNumber: row.sequence_number,
    timestamp: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
  };
}

/**
 * Generate a one-line summary for timeline display.
 */
function _summarizeEvent(eventType, data) {
  switch (eventType) {
    case EventType.STATE_CHANGE:
      return `State changed: ${data.previousState} → ${data.newState}`;
    case EventType.FRAGMENT:
      return `Decision: ${data.type} — ${data.decision}`;
    case EventType.LLM_CALL:
      return `LLM call: ${data.model || 'unknown'} (${data.taskType || 'unknown'})`;
    case EventType.DATA_FETCH:
      return `Data fetched: ${data.provider} — ${data.method || 'query'}`;
    case EventType.REVIEW_ACTION:
      return `Review: ${data.newStatus} by ${data.reviewedBy || 'unknown'}`;
    case EventType.STEP_STARTED:
      return `Step started: ${data.stepName}`;
    case EventType.STEP_COMPLETED:
      return `Step completed: ${data.stepName} (${data.fragmentCount || 0} fragments)`;
    case EventType.STEP_FAILED:
      return `Step failed: ${data.stepName} — ${data.error || 'unknown error'}`;
    case EventType.AGENT_ERROR:
      return `Agent error: ${data.error || 'unknown'}`;
    default:
      return `${eventType}: ${JSON.stringify(data).slice(0, 100)}`;
  }
}

module.exports = {
  EventType,
  appendEvent,
  getEventsByCase,
  getEventTimeline,
  exportCaseAudit,
};
```

### Database Immutability

The `decision_events` table uses PostgreSQL rules to enforce append-only:

```sql
-- From init.sql (#3)
CREATE RULE decision_events_no_update AS
  ON UPDATE TO decision_events DO INSTEAD NOTHING;

CREATE RULE decision_events_no_delete AS
  ON DELETE TO decision_events DO INSTEAD NOTHING;
```

This means:
- `INSERT` works normally
- `UPDATE` silently does nothing (no error, no modification)
- `DELETE` silently does nothing
- Only a superuser altering the rules themselves can bypass this

### Event Types

| Type | When | Example Data |
|------|------|-------------|
| `fragment` | Agent produces a decision fragment | `{ fragmentId, type, decision, confidence, evidence }` |
| `llm_call` | Agent makes an LLM call | `{ model, taskType, latencyMs, tokens }` |
| `data_fetch` | Agent fetches from external data source | `{ provider, method, cacheHit, latencyMs }` |
| `state_change` | Orchestrator transitions case state | `{ previousState, newState, manual?, userId? }` |
| `review_action` | Human reviews a decision fragment | `{ fragmentId, newStatus, reviewedBy, comment }` |
| `config_change` | Risk rules or config reloaded | `{ configFile, previousVersion, newVersion }` |
| `step_started` | Agent begins a step | `{ stepName, agentId }` |
| `step_completed` | Agent completes a step | `{ stepName, fragmentCount, llmCallCount }` |
| `step_failed` | Agent step fails | `{ stepName, error, retries }` |
| `agent_error` | Agent-level error | `{ agentId, error }` |

### Sequential Ordering

The `sequence_number` column uses a PostgreSQL sequence to guarantee monotonically increasing order within a case. This ensures events can always be replayed in the exact order they occurred, even if multiple events have the same timestamp.

### Export Format

```json
{
  "exportedAt": "2026-04-04T12:00:00Z",
  "format": "kyc-agent-audit-v1",
  "case": {
    "id": "uuid",
    "clientName": "Acme Corp",
    "jurisdiction": "GB",
    "state": "approved",
    "createdAt": "2026-04-01T10:00:00Z"
  },
  "summary": {
    "totalEvents": 47,
    "eventCounts": {
      "state_change": 6,
      "fragment": 18,
      "llm_call": 12,
      "data_fetch": 8,
      "review_action": 3
    },
    "firstEvent": "2026-04-01T10:00:01Z",
    "lastEvent": "2026-04-02T14:30:00Z"
  },
  "events": [/* full event list */]
}
```

## Acceptance Criteria

- [ ] `appendEvent()` inserts into `decision_events` and returns `{ id, sequenceNumber }`
- [ ] `getEventsByCase()` returns paginated events with filters: eventType, agentType, date range
- [ ] `getEventTimeline()` returns all events in order with human-readable summaries
- [ ] `exportCaseAudit()` produces complete JSON export with case metadata and all events
- [ ] Event types: fragment, llm_call, data_fetch, state_change, review_action, config_change, step_started, step_completed, step_failed, agent_error
- [ ] Events are append-only — application never calls UPDATE or DELETE
- [ ] PostgreSQL rules prevent UPDATE/DELETE at SQL level
- [ ] `sequence_number` provides guaranteed ordering
- [ ] Events ordered by `sequence_number ASC` in all queries
- [ ] Export includes summary statistics (event counts by type)
- [ ] Timeline summaries are human-readable for each event type

## Dependencies

- **Depends on**: #3 (Database — `decision_events` table with append-only rules), #4 (Backend scaffold)
- **Blocks**: #21 (Base Agent — emits events), #22 (Decision fragments — logs fragment creation), #23 (Orchestrator — logs state changes)

## Testing Strategy

1. **Append event**: Append an event, verify it exists in the table with a `sequence_number`
2. **Sequential numbering**: Append 3 events, verify `sequence_number` is monotonically increasing
3. **Immutability**: Attempt to UPDATE an event — verify it silently fails (row unchanged)
4. **Immutability**: Attempt to DELETE an event — verify it silently fails (row unchanged)
5. **Get by case**: Append 5 events for case A and 3 for case B — `getEventsByCase(A)` returns 5
6. **Filter by event type**: Append mixed types, filter by `state_change` — verify correct subset
7. **Filter by agent**: Append events from 2 agents, filter by one — verify correct subset
8. **Filter by date range**: Append events across dates, filter by range — verify correct subset
9. **Pagination**: Append 20 events, request limit=5 offset=10 — verify correct page
10. **Timeline**: Append events, verify timeline includes summaries for each
11. **Export**: Create a case with events, export, verify JSON format with case metadata and summary stats
12. **Export nonexistent**: Export for unknown case — verify `NOT_FOUND` error
13. **Summary generation**: Verify `_summarizeEvent` produces readable text for each event type
