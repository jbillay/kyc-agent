# Audit Trail View in Frontend

> GitHub Issue: [#72](https://github.com/jbillay/kyc-agent/issues/72)
> Epic: Audit Trail & Reporting (#71)
> Size: M (3-5 days) | Priority: High

## Context

The KYC Agent platform records every agent action, LLM call, data source query, state change, and review action as an immutable event in the `decision_events` table. Compliance officers need a way to inspect this chronological record within each case to verify due diligence and respond to regulatory inquiries.

This story adds an "Audit Trail" tab to the existing case detail view (`/cases/:id`) and a supporting backend endpoint (`GET /api/v1/cases/:id/timeline`) that returns events with pagination and filtering. The tab renders a timeline of all events with expandable detail panels, filters, and search.

## Requirements

### Functional

1. Add an "Audit Trail" tab to the case detail view (alongside Entity Profile, Ownership, Screening, Documents, Risk Assessment tabs)
2. Display all events for a case in reverse chronological order (newest first) as a vertical timeline
3. Each event card shows:
   - Timestamp (formatted with relative time, e.g., "2 hours ago", with full ISO on hover)
   - Event type with icon (color-coded by category)
   - Agent type or user who performed the action
   - Summary description (human-readable)
4. Expandable detail: clicking an event reveals the full payload:
   - For decision fragments: type, confidence score, decision text, evidence with data sources, review status
   - For LLM calls: model used, prompt (truncated with "show full"), response, latency, token counts
   - For data source queries: provider, query parameters, response summary, cache status
   - For state changes: old state, new state, trigger
   - For review actions: reviewer name, decision, comment
5. Filter bar with:
   - Agent type dropdown (entity_resolution, ownership_ubo, screening, document_analysis, risk_assessment, qa, system)
   - Event type dropdown (agent_started, step_completed, fragment_added, llm_call, data_query, state_change, review_action)
   - Date range picker (from/to)
   - Confidence level slider (0-100, for fragment events)
6. Text search across event summaries and payloads
7. Event count badge on the Audit Trail tab label

### Non-Functional

- Handle cases with 100+ events smoothly using virtual scrolling or progressive loading
- LLM call detail payloads (prompt/response) loaded on demand when expanded (not in initial list response)
- Timeline updates in real-time via WebSocket (`case:fragment_added`, `case:agent_step_completed`, etc.)

## Technical Design

### Backend: Timeline Endpoint

#### File: `backend/src/api/audit.js`

```javascript
/**
 * Audit API routes — /api/v1/audit
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {Object} deps
 * @param {import('../services/audit-service').AuditService} deps.auditService
 */
async function auditRoutes(app, { auditService }) {
  // ─── GET /api/v1/cases/:id/timeline ───────────────
  // Returns paginated, filtered timeline events for a case
  app.get(
    '/cases/:id/timeline',
    {
      preHandler: [app.authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            agent_type: { type: 'string' },
            event_type: { type: 'string' },
            from: { type: 'string', format: 'date-time' },
            to: { type: 'string', format: 'date-time' },
            min_confidence: { type: 'integer', minimum: 0, maximum: 100 },
            search: { type: 'string', maxLength: 200 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const filters = request.query;
      const result = await auditService.getCaseTimeline(id, filters);
      return reply.send(result);
    }
  );

  // ─── GET /api/v1/audit/events/:id/detail ──────────
  // Returns full payload for a single event (LLM calls, large payloads)
  app.get(
    '/audit/events/:id/detail',
    {
      preHandler: [app.authenticate],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const event = await auditService.getEventDetail(request.params.id);
      if (!event) {
        return reply.status(404).send({
          error: { code: 'EVENT_NOT_FOUND', message: 'Audit event not found' },
        });
      }
      return reply.send({ event });
    }
  );
}

module.exports = { auditRoutes };
```

#### File: `backend/src/services/audit-service.js`

```javascript
/**
 * Audit service — queries decision_events and aggregates audit data.
 *
 * @param {Object} deps
 * @param {import('pg').Pool} deps.db
 */
class AuditService {
  constructor({ db }) {
    this.db = db;
  }

  /**
   * Get paginated timeline events for a case.
   *
   * @param {string} caseId
   * @param {Object} filters
   * @param {string} [filters.agent_type]
   * @param {string} [filters.event_type]
   * @param {string} [filters.from] - ISO date-time
   * @param {string} [filters.to] - ISO date-time
   * @param {number} [filters.min_confidence]
   * @param {string} [filters.search]
   * @param {number} [filters.limit=50]
   * @param {number} [filters.offset=0]
   * @returns {Promise<{ events: Object[], total: number }>}
   */
  async getCaseTimeline(caseId, filters = {}) {
    const conditions = ['de.case_id = $1'];
    const params = [caseId];
    let paramIndex = 2;

    if (filters.agent_type) {
      conditions.push(`de.agent_type = $${paramIndex++}`);
      params.push(filters.agent_type);
    }

    if (filters.event_type) {
      conditions.push(`de.event_type = $${paramIndex++}`);
      params.push(filters.event_type);
    }

    if (filters.from) {
      conditions.push(`de.timestamp >= $${paramIndex++}`);
      params.push(filters.from);
    }

    if (filters.to) {
      conditions.push(`de.timestamp <= $${paramIndex++}`);
      params.push(filters.to);
    }

    if (filters.min_confidence != null) {
      conditions.push(`(de.data->>'confidence')::int >= $${paramIndex++}`);
      params.push(filters.min_confidence);
    }

    if (filters.search) {
      conditions.push(`de.data::text ILIKE $${paramIndex++}`);
      params.push(`%${filters.search}%`);
    }

    const whereClause = conditions.join(' AND ');
    const limit = filters.limit || 50;
    const offset = filters.offset || 0;

    // Count query
    const countResult = await this.db.query(
      `SELECT COUNT(*) FROM decision_events de WHERE ${whereClause}`,
      params
    );

    // Data query — return summary (exclude large payloads like full LLM prompts)
    const dataResult = await this.db.query(
      `SELECT
        de.id,
        de.case_id,
        de.agent_type,
        de.step_id,
        de.event_type,
        de.timestamp,
        de.sequence_number,
        jsonb_build_object(
          'summary', de.data->>'summary',
          'confidence', de.data->>'confidence',
          'decision', de.data->>'decision',
          'type', de.data->>'type',
          'status', de.data->>'status',
          'has_detail', (de.data ? 'prompt' OR de.data ? 'response' OR de.data ? 'evidence')
        ) AS data_summary
      FROM decision_events de
      WHERE ${whereClause}
      ORDER BY de.sequence_number DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...params, limit, offset]
    );

    return {
      events: dataResult.rows,
      total: parseInt(countResult.rows[0].count, 10),
    };
  }

  /**
   * Get full event detail including large payloads.
   *
   * @param {string} eventId
   * @returns {Promise<Object|null>}
   */
  async getEventDetail(eventId) {
    const result = await this.db.query(
      'SELECT * FROM decision_events WHERE id = $1',
      [eventId]
    );
    return result.rows[0] || null;
  }

  /**
   * Get event count for a case (for tab badge).
   *
   * @param {string} caseId
   * @returns {Promise<number>}
   */
  async getCaseEventCount(caseId) {
    const result = await this.db.query(
      'SELECT COUNT(*) FROM decision_events WHERE case_id = $1',
      [caseId]
    );
    return parseInt(result.rows[0].count, 10);
  }
}

module.exports = { AuditService };
```

### Frontend: Audit Trail Tab

#### File: `frontend/src/components/case/AuditTrailTab.vue`

Component structure:

```
AuditTrailTab
├── AuditFilters                    # Filter bar
│   ├── Dropdown (agent type)
│   ├── Dropdown (event type)
│   ├── DateRangePicker (from/to)
│   ├── Slider (confidence)
│   └── SearchInput (text search)
├── Timeline                        # Virtual-scrolled event list
│   └── AuditEventCard[]            # Individual event cards
│       ├── EventIcon               # Color-coded by category
│       ├── EventSummary            # Timestamp, agent, description
│       └── EventDetail (expandable) # Full payload on click
└── Pagination                      # Offset-based pagination controls
```

State managed locally within the component (no Pinia store needed — data is case-scoped and read-only):

```javascript
const state = reactive({
  events: [],
  total: 0,
  loading: false,
  filters: {
    agent_type: null,
    event_type: null,
    from: null,
    to: null,
    min_confidence: null,
    search: '',
  },
  pagination: { limit: 50, offset: 0 },
  expandedEventId: null,
  expandedDetail: null,
  detailLoading: false,
});
```

#### Event Type Icons and Colors

| Category | Event Types | Icon | Color |
|----------|------------|------|-------|
| Agent lifecycle | `agent_started`, `agent_completed`, `agent_failed` | `pi-cog` | Blue |
| Step execution | `step_started`, `step_completed` | `pi-check-circle` | Teal |
| Decision | `fragment_added`, `fragment_updated` | `pi-file-edit` | Purple |
| LLM | `llm_call` | `pi-microchip-ai` | Orange |
| Data query | `data_query` | `pi-database` | Cyan |
| State change | `state_change` | `pi-arrows-h` | Green |
| Review | `review_action`, `fragment_override` | `pi-user-edit` | Amber |
| System | `error`, `warning` | `pi-exclamation-triangle` | Red |

#### WebSocket Integration

Subscribe to case-specific events to prepend new timeline entries in real-time:

```javascript
// In AuditTrailTab setup
const socket = inject('socket');

onMounted(() => {
  socket.on('case:agent_step_completed', handleNewEvent);
  socket.on('case:fragment_added', handleNewEvent);
  socket.on('case:state_changed', handleNewEvent);
});

function handleNewEvent(data) {
  if (data.caseId === props.caseId) {
    // Prepend to events list and increment total
    fetchTimeline(); // Refresh from server for consistency
  }
}
```

### API Response Format

#### Timeline Response

```json
{
  "events": [
    {
      "id": "uuid",
      "case_id": "uuid",
      "agent_type": "screening",
      "step_id": "compile_screening_list",
      "event_type": "step_completed",
      "timestamp": "2026-04-07T10:30:00Z",
      "sequence_number": 42,
      "data_summary": {
        "summary": "Compiled screening list with 5 names from entity and ownership data",
        "confidence": "85",
        "decision": null,
        "type": "screening_list_compiled",
        "status": "completed",
        "has_detail": true
      }
    }
  ],
  "total": 87
}
```

#### Event Detail Response

```json
{
  "event": {
    "id": "uuid",
    "case_id": "uuid",
    "agent_type": "screening",
    "step_id": "evaluate_hit",
    "event_type": "llm_call",
    "timestamp": "2026-04-07T10:31:00Z",
    "sequence_number": 45,
    "data": {
      "model": "llama3:8b",
      "provider": "ollama",
      "task_type": "reasoning",
      "prompt": "Evaluate whether the following sanctions hit is a true match...",
      "response": "Based on the analysis, this appears to be a false positive...",
      "latency_ms": 2340,
      "input_tokens": 450,
      "output_tokens": 280,
      "summary": "LLM evaluated sanctions hit for John Smith — dismissed as false positive"
    }
  }
}
```

## Acceptance Criteria

- [ ] Audit Trail tab visible in case detail view with event count badge
- [ ] Events displayed in reverse chronological order as a vertical timeline
- [ ] Each event shows: timestamp (relative + full on hover), type icon (color-coded), agent/user, summary
- [ ] Clicking an event expands to show full payload (fragments, LLM calls, data queries)
- [ ] LLM call details loaded on demand (not in initial list payload)
- [ ] Filter by agent type (dropdown with all agent types)
- [ ] Filter by event type (dropdown with all event types)
- [ ] Filter by date range (from/to date pickers)
- [ ] Filter by minimum confidence level (slider 0-100)
- [ ] Text search across event summaries and payloads
- [ ] Filters apply immediately and update the event list
- [ ] Pagination works correctly (50 events per page)
- [ ] Performance: handles 100+ events without lag (virtual scrolling or progressive loading)
- [ ] Real-time: new events appear in timeline via WebSocket without manual refresh
- [ ] `GET /api/v1/cases/:id/timeline` returns paginated, filtered events
- [ ] `GET /api/v1/audit/events/:id/detail` returns full event payload
- [ ] Both endpoints protected by authentication middleware

## Dependencies

- **Depends on**: #25 (Event store — `decision_events` table), #41 (Case detail view — tab container), #36 (WebSocket events), #67 (Auth — endpoint protection)
- **Blocks**: #73 (Case audit export — shares audit service and data model)

## Testing Strategy

### Backend

1. **Timeline — basic**: Create case with events, GET timeline, verify events returned in reverse chronological order
2. **Timeline — filter by agent_type**: Create events from multiple agents, filter by one, verify only matching events returned
3. **Timeline — filter by event_type**: Filter by `llm_call`, verify only LLM events returned
4. **Timeline — filter by date range**: Create events across dates, filter to a range, verify bounded results
5. **Timeline — filter by confidence**: Create events with varying confidence, filter by min threshold
6. **Timeline — search**: Create events with known text, search for it, verify matching events
7. **Timeline — pagination**: Create 75 events, request limit=50 offset=0, verify 50 returned with total=75; request offset=50, verify 25 returned
8. **Timeline — combined filters**: Apply multiple filters simultaneously, verify AND logic
9. **Event detail**: Create event with large payload, GET detail, verify full data returned
10. **Event detail — not found**: GET non-existent event ID, verify 404
11. **Event count**: Create case with known number of events, verify count matches

### Frontend

12. **Tab rendering**: Mount case detail with events, verify Audit Trail tab appears with count badge
13. **Timeline display**: Verify events render with timestamp, icon, agent, summary
14. **Event expansion**: Click event, verify detail panel opens with full payload
15. **LLM call detail**: Expand LLM event, verify prompt/response loaded on demand
16. **Filter — agent type**: Select agent type, verify event list updates
17. **Filter — search**: Type search query, verify matching events shown
18. **Real-time update**: Emit WebSocket event, verify timeline refreshes
19. **Empty state**: Case with no events shows appropriate message
20. **Large dataset**: Render 100+ events, verify no performance degradation
