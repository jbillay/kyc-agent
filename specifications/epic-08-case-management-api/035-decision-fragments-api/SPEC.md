# Case Management API — Decision Fragments API Endpoints

> GitHub Issue: [#35](https://github.com/jbillay/kyc-agent/issues/35)
> Epic: Case Management API (#33)
> Size: M (1-3 days) | Priority: High

## Context

Decision fragments are the core audit unit of the KYC Agent platform — every agent decision is recorded as a fragment with type, confidence, evidence, and review status. The Fragments API exposes these to the frontend so reviewers can see the agent's reasoning, filter fragments by type or agent, and drill into individual fragments with full evidence detail. This API is read-only in Phase 1; fragment status modification (override, approve, dismiss) comes with the Review Workflow epic.

## Requirements

### Functional

1. `GET /api/v1/cases/:id/fragments` — list all decision fragments for a case
2. Filterable by: `agentType`, `fragmentType`, `status`, confidence range (`minConfidence`, `maxConfidence`)
3. Sortable by timestamp (default newest first)
4. Cursor-based pagination for cases with many fragments
5. `GET /api/v1/cases/:id/fragments/:fragmentId` — get single fragment with full evidence detail
6. Response includes linked data: data source references, LLM call references in evidence
7. All responses use consistent error format

### Non-Functional

- Pagination handles cases with 100+ fragments efficiently
- Fragment list response within 200ms for typical cases (20-50 fragments)

## Technical Design

### File: `backend/src/api/fragments/schemas.js`

```javascript
/**
 * Fastify JSON Schema definitions for Fragments API.
 */

const fragmentResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    caseId: { type: 'string', format: 'uuid' },
    agentType: { type: 'string' },
    stepId: { type: 'string' },
    type: { type: 'string' },
    decision: { type: 'string' },
    confidence: { type: 'integer', minimum: 0, maximum: 100 },
    evidence: {
      type: 'object',
      properties: {
        dataSources: {
          type: 'array',
          items: { type: 'string' },
        },
        dataPoints: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: { type: 'string' },
              field: { type: 'string' },
              value: {},
              fetchedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        llmReasoning: { type: ['string', 'null'] },
        llmModel: { type: ['string', 'null'] },
        llmCallId: { type: ['string', 'null'] },
      },
    },
    status: {
      type: 'string',
      enum: ['pending_review', 'auto_approved', 'human_approved', 'human_rejected', 'human_modified', 'dismissed'],
    },
    reviewedBy: { type: ['string', 'null'] },
    reviewComment: { type: ['string', 'null'] },
    reviewedAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object' },
      },
    },
  },
};

const listFragmentsSchema = {
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
      agentType: { type: 'string' },
      fragmentType: { type: 'string' },
      status: {
        type: 'string',
        enum: ['pending_review', 'auto_approved', 'human_approved', 'human_rejected', 'human_modified', 'dismissed'],
      },
      minConfidence: { type: 'integer', minimum: 0, maximum: 100 },
      maxConfidence: { type: 'integer', minimum: 0, maximum: 100 },
      sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
      cursor: { type: 'string', format: 'uuid' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      properties: {
        fragments: { type: 'array', items: fragmentResponseSchema },
        nextCursor: { type: ['string', 'null'] },
        total: { type: 'integer' },
      },
    },
    404: errorResponseSchema,
  },
};

const getFragmentSchema = {
  params: {
    type: 'object',
    required: ['id', 'fragmentId'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      fragmentId: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: fragmentResponseSchema,
    404: errorResponseSchema,
  },
};

module.exports = {
  listFragmentsSchema,
  getFragmentSchema,
};
```

### File: `backend/src/api/fragments/handlers.js`

```javascript
/**
 * @param {Object} deps
 * @param {import('../../services/case-management').CaseManagementService} deps.caseService
 * @param {import('../../agents/decision-fragment').FragmentStore} deps.fragmentStore
 */
function buildFragmentHandlers(deps) {
  const { caseService, fragmentStore } = deps;

  // ─── GET /api/v1/cases/:id/fragments ────────────

  async function listFragments(request, reply) {
    const caseId = request.params.id;

    const caseExists = await caseService.caseExists(caseId);
    if (!caseExists) {
      return reply.status(404).send({
        error: { code: 'CASE_NOT_FOUND', message: `Case ${caseId} not found` },
      });
    }

    const {
      agentType,
      fragmentType,
      status,
      minConfidence,
      maxConfidence,
      sortOrder,
      cursor,
      limit,
    } = request.query;

    const result = await fragmentStore.getFragmentsByCase(caseId, {
      filters: {
        agentType,
        fragmentType,
        status,
        minConfidence,
        maxConfidence,
      },
      sort: { order: sortOrder || 'desc' },
      pagination: { cursor, limit: limit || 50 },
    });

    return reply.send(result);
  }

  // ─── GET /api/v1/cases/:id/fragments/:fragmentId ─

  async function getFragment(request, reply) {
    const { id: caseId, fragmentId } = request.params;

    const caseExists = await caseService.caseExists(caseId);
    if (!caseExists) {
      return reply.status(404).send({
        error: { code: 'CASE_NOT_FOUND', message: `Case ${caseId} not found` },
      });
    }

    const fragment = await fragmentStore.getFragmentById(fragmentId);

    if (!fragment || fragment.caseId !== caseId) {
      return reply.status(404).send({
        error: {
          code: 'FRAGMENT_NOT_FOUND',
          message: `Fragment ${fragmentId} not found in case ${caseId}`,
        },
      });
    }

    return reply.send(fragment);
  }

  return { listFragments, getFragment };
}

module.exports = { buildFragmentHandlers };
```

### File: `backend/src/api/fragments/routes.js`

```javascript
const { buildFragmentHandlers } = require('./handlers');
const { listFragmentsSchema, getFragmentSchema } = require('./schemas');

/**
 * Register Fragments API routes under /api/v1/cases/:id/fragments.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {Object} deps - Service dependencies
 */
async function fragmentsRoutes(app, deps) {
  const handlers = buildFragmentHandlers(deps);

  app.get('/cases/:id/fragments', { schema: listFragmentsSchema }, handlers.listFragments);
  app.get('/cases/:id/fragments/:fragmentId', { schema: getFragmentSchema }, handlers.getFragment);
}

module.exports = { fragmentsRoutes };
```

### Fragment Store Query — `getFragmentsByCase`

The handler delegates to the `FragmentStore` from Epic 4 Story #22. The query builds dynamic WHERE clauses:

```sql
SELECT * FROM decision_fragments
WHERE case_id = $1
  AND ($2::varchar IS NULL OR agent_type = $2)
  AND ($3::varchar IS NULL OR type = $3)
  AND ($4::varchar IS NULL OR status = $4)
  AND ($5::int IS NULL OR confidence >= $5)
  AND ($6::int IS NULL OR confidence <= $6)
ORDER BY created_at DESC, id DESC
LIMIT $7
```

### API Endpoint Summary

| Method | Endpoint | Purpose | Auth Required |
|--------|----------|---------|---------------|
| `GET` | `/api/v1/cases/:id/fragments` | List fragments with filters | analyst+ |
| `GET` | `/api/v1/cases/:id/fragments/:fragmentId` | Get single fragment detail | analyst+ |

### Fragment Response Shape

```json
{
  "id": "uuid",
  "caseId": "uuid",
  "agentType": "screening",
  "stepId": "run_sanctions_screening",
  "type": "sanctions_clear",
  "decision": "No sanctions matches found for individual \"John Smith\" across OFAC SDN and UK HMT",
  "confidence": 95,
  "evidence": {
    "dataSources": ["ofac-sdn", "uk-hmt"],
    "dataPoints": [
      { "source": "ofac-sdn", "field": "search_result", "value": "no matches", "fetchedAt": "2025-01-15T10:35:00Z" },
      { "source": "uk-hmt", "field": "search_result", "value": "no matches", "fetchedAt": "2025-01-15T10:35:01Z" }
    ],
    "llmReasoning": null,
    "llmModel": null,
    "llmCallId": null
  },
  "status": "auto_approved",
  "reviewedBy": null,
  "reviewComment": null,
  "reviewedAt": null,
  "createdAt": "2025-01-15T10:35:02Z"
}
```

For LLM-evaluated fragments (e.g., `sanctions_dismissed`), the evidence includes:

```json
{
  "evidence": {
    "dataSources": ["ofac-sdn"],
    "dataPoints": [
      { "source": "ofac-sdn", "field": "matched_entry", "value": { "entryId": "12345", "name": "JOHN SMITH" }, "fetchedAt": "..." }
    ],
    "llmReasoning": "While the name matches, the date of birth differs significantly...",
    "llmModel": "llama3:8b",
    "llmCallId": "uuid-of-llm-call-log"
  }
}
```

## Acceptance Criteria

- [ ] `GET /api/v1/cases/:id/fragments` returns all fragments for a case
- [ ] Filterable by `agentType` (e.g., `screening`, `entity-resolution`)
- [ ] Filterable by `fragmentType` (e.g., `sanctions_clear`, `sanctions_hit`)
- [ ] Filterable by `status` (e.g., `pending_review`, `auto_approved`)
- [ ] Filterable by confidence range (`minConfidence`, `maxConfidence`)
- [ ] Sortable by timestamp (asc/desc, default desc)
- [ ] Cursor-based pagination with `cursor` + `limit` params
- [ ] Response includes `fragments`, `nextCursor`, `total`
- [ ] `GET /api/v1/cases/:id/fragments/:fragmentId` returns single fragment with full evidence
- [ ] Fragment evidence includes data source references, data points, and LLM reasoning when present
- [ ] Returns 404 if case does not exist
- [ ] Returns 404 if fragment does not exist or belongs to different case
- [ ] All endpoints validated with Fastify JSON Schema
- [ ] Consistent error format across all endpoints

## Dependencies

- **Depends on**: #34 (Cases CRUD — route prefix, case existence check), #22 (Decision Fragment Store — `getFragmentsByCase`, `getFragmentById`), #3 (PostgreSQL schema — decision_fragments table)
- **Blocks**: #41 (Case Detail — entity profile tab reads fragments), #43 (Screening Results — displays fragment reasoning)

## Testing Strategy

1. **List fragments — empty**: Case with no fragments, verify empty array returned
2. **List fragments — multiple**: Case with 10 fragments, verify all returned with correct shape
3. **Filter by agentType**: Case with screening + entity-resolution fragments, filter by `screening`, verify only screening returned
4. **Filter by fragmentType**: Filter by `sanctions_clear`, verify only that type returned
5. **Filter by status**: Filter by `pending_review`, verify only pending fragments returned
6. **Filter by confidence range**: Set `minConfidence=80&maxConfidence=95`, verify range filtering
7. **Combined filters**: Filter by agentType + status, verify AND logic
8. **Sort order**: Request `sortOrder=asc`, verify oldest first
9. **Pagination**: 60 fragments, request `limit=25`, verify first page + nextCursor; use cursor for page 2
10. **Get single fragment**: Request valid fragmentId, verify full evidence detail returned
11. **Get fragment — wrong case**: Fragment belongs to case A, request via case B, verify 404
12. **Get fragment — not found**: Request non-existent fragmentId, verify 404
13. **Case not found**: Request fragments for non-existent case, verify 404
14. **LLM evidence**: Fragment with LLM reasoning, verify `llmReasoning`, `llmModel`, `llmCallId` present
15. **Schema validation**: Pass invalid query params (e.g., `limit=-1`), verify 400
