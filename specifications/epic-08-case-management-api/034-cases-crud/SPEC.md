# Case Management API — Cases CRUD API Endpoints

> GitHub Issue: [#34](https://github.com/jbillay/kyc-agent/issues/34)
> Epic: Case Management API (#33)
> Size: L (3-5 days) | Priority: Critical

## Context

The Cases CRUD API is the primary interface between the frontend and the KYC platform. It handles case creation (which triggers the orchestrator to begin agent execution), listing cases with rich filtering for the dashboard kanban, retrieving full case details with agent outputs, document uploads, agent re-runs, and manual state transitions. All endpoints use Fastify's built-in JSON Schema validation for request/response contracts and follow a consistent error response format.

## Requirements

### Functional

1. `POST /api/v1/cases` — create a new case, trigger orchestrator
2. `GET /api/v1/cases` — list cases with filters, pagination, sorting
3. `GET /api/v1/cases/:id` — get full case details including agent results
4. `GET /api/v1/cases/:id/timeline` — get chronological event timeline
5. `POST /api/v1/cases/:id/documents` — upload documents (multipart)
6. `POST /api/v1/cases/:id/rerun/:agent` — re-run a specific agent
7. `PATCH /api/v1/cases/:id/state` — manually transition case state (authorized)
8. All endpoints validated with Fastify JSON Schema
9. Consistent error format: `{ error: { code, message, details } }`

### Non-Functional

- List endpoint handles 1000+ cases with pagination (default 50 per page)
- Case creation responds within 500ms (enqueues job asynchronously)
- Document upload supports files up to 50MB

## Technical Design

### File: `backend/src/api/cases/schemas.js`

```javascript
/**
 * Fastify JSON Schema definitions for Cases API.
 */

const caseResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', format: 'uuid' },
    clientName: { type: 'string' },
    clientType: { type: 'string', enum: ['corporate', 'individual'] },
    jurisdiction: { type: 'string' },
    registrationNumber: { type: ['string', 'null'] },
    additionalIdentifiers: { type: 'object' },
    state: { type: 'string' },
    ddLevel: { type: 'string', enum: ['simplified', 'standard', 'enhanced'] },
    riskScore: { type: ['integer', 'null'] },
    riskRating: { type: ['string', 'null'] },
    assignedReviewer: { type: ['string', 'null'] },
    source: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    completedAt: { type: ['string', 'null'], format: 'date-time' },
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

const createCaseSchema = {
  body: {
    type: 'object',
    required: ['clientName', 'clientType', 'jurisdiction'],
    properties: {
      clientName: { type: 'string', minLength: 1, maxLength: 500 },
      clientType: { type: 'string', enum: ['corporate', 'individual'] },
      jurisdiction: { type: 'string', pattern: '^[A-Z]{2}$' },
      registrationNumber: { type: 'string', maxLength: 100 },
      additionalIdentifiers: { type: 'object' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    additionalProperties: false,
  },
  response: {
    201: caseResponseSchema,
    400: errorResponseSchema,
  },
};

const listCasesSchema = {
  querystring: {
    type: 'object',
    properties: {
      state: { type: 'string' },
      riskRating: { type: 'string', enum: ['low', 'medium', 'high', 'very_high'] },
      assignedReviewer: { type: 'string', format: 'uuid' },
      dateFrom: { type: 'string', format: 'date' },
      dateTo: { type: 'string', format: 'date' },
      search: { type: 'string', maxLength: 200 },
      sortBy: { type: 'string', enum: ['created_at', 'updated_at', 'risk_score'], default: 'created_at' },
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
        cases: { type: 'array', items: caseResponseSchema },
        nextCursor: { type: ['string', 'null'] },
        total: { type: 'integer' },
      },
    },
  },
};

const getCaseSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  response: {
    200: {
      type: 'object',
      properties: {
        ...caseResponseSchema.properties,
        entityProfile: { type: ['object', 'null'] },
        ownershipMap: { type: ['object', 'null'] },
        screeningReport: { type: ['object', 'null'] },
        riskAssessment: { type: ['object', 'null'] },
        agentResults: {
          type: 'object',
          additionalProperties: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              confidence: { type: ['integer', 'null'] },
              completedAt: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
    404: errorResponseSchema,
  },
};

const getTimelineSchema = {
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
      eventType: { type: 'string' },
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
    },
  },
};

const uploadDocumentSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
};

const rerunAgentSchema = {
  params: {
    type: 'object',
    required: ['id', 'agent'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      agent: {
        type: 'string',
        enum: ['entity-resolution', 'ownership-ubo', 'screening', 'risk-assessment', 'qa-agent'],
      },
    },
  },
};

const patchStateSchema = {
  params: {
    type: 'object',
    required: ['id'],
    properties: {
      id: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['state'],
    properties: {
      state: { type: 'string' },
      reason: { type: 'string', maxLength: 1000 },
    },
    additionalProperties: false,
  },
};

module.exports = {
  createCaseSchema,
  listCasesSchema,
  getCaseSchema,
  getTimelineSchema,
  uploadDocumentSchema,
  rerunAgentSchema,
  patchStateSchema,
};
```

### File: `backend/src/api/cases/handlers.js`

```javascript
const { CaseManagementService } = require('../../services/case-management');

/**
 * @param {import('fastify').FastifyInstance} app
 * @param {Object} deps
 * @param {CaseManagementService} deps.caseService
 * @param {import('../../agents/orchestrator').Orchestrator} deps.orchestrator
 * @param {import('../../services/event-store').EventStore} deps.eventStore
 * @param {import('../../services/document-service').DocumentService} deps.documentService
 */
function buildCaseHandlers(deps) {
  const { caseService, orchestrator, eventStore, documentService } = deps;

  // ─── POST /api/v1/cases ─────────────────────────

  async function createCase(request, reply) {
    const { clientName, clientType, jurisdiction, registrationNumber, additionalIdentifiers, tags } =
      request.body;

    const newCase = await caseService.createCase({
      clientName,
      clientType,
      jurisdiction,
      registrationNumber,
      additionalIdentifiers,
      tags,
      source: 'api',
    });

    // Trigger the orchestrator to begin the agent pipeline
    await orchestrator.startCase(newCase.id);

    return reply.status(201).send(newCase);
  }

  // ─── GET /api/v1/cases ──────────────────────────

  async function listCases(request, reply) {
    const { state, riskRating, assignedReviewer, dateFrom, dateTo, search, sortBy, sortOrder, cursor, limit } =
      request.query;

    const result = await caseService.listCases({
      filters: { state, riskRating, assignedReviewer, dateFrom, dateTo, search },
      sort: { field: sortBy, order: sortOrder },
      pagination: { cursor, limit },
    });

    return reply.send(result);
  }

  // ─── GET /api/v1/cases/:id ──────────────────────

  async function getCase(request, reply) {
    const kycCase = await caseService.getCaseWithDetails(request.params.id);

    if (!kycCase) {
      return reply.status(404).send({
        error: { code: 'CASE_NOT_FOUND', message: `Case ${request.params.id} not found` },
      });
    }

    return reply.send(kycCase);
  }

  // ─── GET /api/v1/cases/:id/timeline ─────────────

  async function getTimeline(request, reply) {
    const caseExists = await caseService.caseExists(request.params.id);
    if (!caseExists) {
      return reply.status(404).send({
        error: { code: 'CASE_NOT_FOUND', message: `Case ${request.params.id} not found` },
      });
    }

    const timeline = await eventStore.getEventTimeline(request.params.id, {
      agentType: request.query.agentType,
      eventType: request.query.eventType,
      cursor: request.query.cursor,
      limit: request.query.limit,
    });

    return reply.send(timeline);
  }

  // ─── POST /api/v1/cases/:id/documents ───────────

  async function uploadDocument(request, reply) {
    const caseExists = await caseService.caseExists(request.params.id);
    if (!caseExists) {
      return reply.status(404).send({
        error: { code: 'CASE_NOT_FOUND', message: `Case ${request.params.id} not found` },
      });
    }

    const file = await request.file();
    if (!file) {
      return reply.status(400).send({
        error: { code: 'NO_FILE', message: 'No file provided in multipart upload' },
      });
    }

    const doc = await documentService.uploadDocument({
      caseId: request.params.id,
      filename: file.filename,
      mimeType: file.mimetype,
      stream: file.file,
      uploadedBy: request.user?.id,
    });

    return reply.status(201).send(doc);
  }

  // ─── POST /api/v1/cases/:id/rerun/:agent ───────

  async function rerunAgent(request, reply) {
    const { id: caseId, agent: agentType } = request.params;

    const kycCase = await caseService.getCase(caseId);
    if (!kycCase) {
      return reply.status(404).send({
        error: { code: 'CASE_NOT_FOUND', message: `Case ${caseId} not found` },
      });
    }

    // Only allow rerun if case is not in a terminal state
    const terminalStates = ['APPROVED', 'REJECTED'];
    if (terminalStates.includes(kycCase.state)) {
      return reply.status(409).send({
        error: {
          code: 'CASE_TERMINAL',
          message: `Cannot rerun agent on case in ${kycCase.state} state`,
        },
      });
    }

    await orchestrator.rerunAgent(caseId, agentType);

    return reply.send({
      message: `Agent ${agentType} re-enqueued for case ${caseId}`,
      caseId,
      agentType,
    });
  }

  // ─── PATCH /api/v1/cases/:id/state ──────────────

  async function patchState(request, reply) {
    const { id: caseId } = request.params;
    const { state: newState, reason } = request.body;

    const kycCase = await caseService.getCase(caseId);
    if (!kycCase) {
      return reply.status(404).send({
        error: { code: 'CASE_NOT_FOUND', message: `Case ${caseId} not found` },
      });
    }

    try {
      await orchestrator.manualTransition(caseId, newState, {
        userId: request.user?.id,
        reason,
      });
    } catch (err) {
      if (err.message.includes('not allowed')) {
        return reply.status(409).send({
          error: {
            code: 'INVALID_TRANSITION',
            message: err.message,
          },
        });
      }
      throw err;
    }

    const updated = await caseService.getCase(caseId);
    return reply.send(updated);
  }

  return {
    createCase,
    listCases,
    getCase,
    getTimeline,
    uploadDocument,
    rerunAgent,
    patchState,
  };
}

module.exports = { buildCaseHandlers };
```

### File: `backend/src/api/cases/routes.js`

```javascript
const { buildCaseHandlers } = require('./handlers');
const {
  createCaseSchema,
  listCasesSchema,
  getCaseSchema,
  getTimelineSchema,
  uploadDocumentSchema,
  rerunAgentSchema,
  patchStateSchema,
} = require('./schemas');

/**
 * Register Cases API routes under /api/v1/cases.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {Object} deps - Service dependencies
 */
async function casesRoutes(app, deps) {
  const handlers = buildCaseHandlers(deps);

  app.post('/cases', { schema: createCaseSchema }, handlers.createCase);
  app.get('/cases', { schema: listCasesSchema }, handlers.listCases);
  app.get('/cases/:id', { schema: getCaseSchema }, handlers.getCase);
  app.get('/cases/:id/timeline', { schema: getTimelineSchema }, handlers.getTimeline);
  app.post('/cases/:id/documents', { schema: uploadDocumentSchema }, handlers.uploadDocument);
  app.post('/cases/:id/rerun/:agent', { schema: rerunAgentSchema }, handlers.rerunAgent);
  app.patch('/cases/:id/state', { schema: patchStateSchema }, handlers.patchState);
}

module.exports = { casesRoutes };
```

### File: `backend/src/services/case-management.js`

```javascript
/**
 * Case Management Service — business logic for case lifecycle.
 *
 * @param {Object} deps
 * @param {import('pg').Pool} deps.db
 */
class CaseManagementService {
  constructor({ db }) {
    this.db = db;
  }

  /**
   * Create a new KYC case.
   *
   * @param {Object} data
   * @param {string} data.clientName
   * @param {'corporate'|'individual'} data.clientType
   * @param {string} data.jurisdiction
   * @param {string} [data.registrationNumber]
   * @param {Object} [data.additionalIdentifiers]
   * @param {string[]} [data.tags]
   * @param {'api'|'manual'|'batch'} [data.source]
   * @returns {Promise<Object>}
   */
  async createCase(data) {
    const result = await this.db.query(
      `INSERT INTO cases (client_name, client_type, jurisdiction, registration_number,
                          additional_identifiers, tags, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        data.clientName,
        data.clientType,
        data.jurisdiction,
        data.registrationNumber || null,
        JSON.stringify(data.additionalIdentifiers || {}),
        data.tags || [],
        data.source || 'api',
      ]
    );
    return this._mapRow(result.rows[0]);
  }

  /**
   * List cases with filters, sorting, and cursor-based pagination.
   *
   * @param {Object} options
   * @param {Object} options.filters
   * @param {Object} options.sort
   * @param {Object} options.pagination
   * @returns {Promise<{ cases: Object[], nextCursor: string|null, total: number }>}
   */
  async listCases({ filters, sort, pagination }) {
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (filters.state) {
      conditions.push(`state = $${paramIdx++}`);
      params.push(filters.state);
    }
    if (filters.riskRating) {
      conditions.push(`risk_rating = $${paramIdx++}`);
      params.push(filters.riskRating);
    }
    if (filters.assignedReviewer) {
      conditions.push(`assigned_reviewer = $${paramIdx++}`);
      params.push(filters.assignedReviewer);
    }
    if (filters.dateFrom) {
      conditions.push(`created_at >= $${paramIdx++}`);
      params.push(filters.dateFrom);
    }
    if (filters.dateTo) {
      conditions.push(`created_at <= $${paramIdx++}`);
      params.push(filters.dateTo + 'T23:59:59Z');
    }
    if (filters.search) {
      conditions.push(`client_name ILIKE $${paramIdx++}`);
      params.push(`%${filters.search}%`);
    }
    if (pagination.cursor) {
      // Cursor-based: fetch rows after the cursor row's sort position
      const sortField = sort.field || 'created_at';
      const op = sort.order === 'asc' ? '>' : '<';
      conditions.push(
        `(${sortField}, id) ${op} (
          SELECT ${sortField}, id FROM cases WHERE id = $${paramIdx++}
        )`
      );
      params.push(pagination.cursor);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortField = sort.field || 'created_at';
    const sortOrder = sort.order || 'desc';
    const limit = pagination.limit || 50;

    // Count total matching (without cursor/limit)
    const countConditions = conditions.filter((c) => !c.includes('SELECT'));
    const countWhere = countConditions.length > 0 ? `WHERE ${countConditions.join(' AND ')}` : '';
    const countParams = params.slice(0, countConditions.length);
    const countResult = await this.db.query(
      `SELECT COUNT(*) as total FROM cases ${countWhere}`,
      countParams
    );
    const total = parseInt(countResult.rows[0].total, 10);

    // Fetch page
    const result = await this.db.query(
      `SELECT * FROM cases ${where}
       ORDER BY ${sortField} ${sortOrder}, id ${sortOrder}
       LIMIT $${paramIdx}`,
      [...params, limit + 1] // fetch one extra to determine if there's a next page
    );

    const rows = result.rows.slice(0, limit);
    const hasMore = result.rows.length > limit;
    const nextCursor = hasMore ? rows[rows.length - 1].id : null;

    return {
      cases: rows.map((r) => this._mapRow(r)),
      nextCursor,
      total,
    };
  }

  /**
   * Get a single case by ID.
   *
   * @param {string} caseId
   * @returns {Promise<Object|null>}
   */
  async getCase(caseId) {
    const result = await this.db.query('SELECT * FROM cases WHERE id = $1', [caseId]);
    if (result.rows.length === 0) return null;
    return this._mapRow(result.rows[0]);
  }

  /**
   * Check if a case exists.
   *
   * @param {string} caseId
   * @returns {Promise<boolean>}
   */
  async caseExists(caseId) {
    const result = await this.db.query('SELECT 1 FROM cases WHERE id = $1', [caseId]);
    return result.rows.length > 0;
  }

  /**
   * Get case with full agent results and output data.
   *
   * Joins case row with agent_results to populate entityProfile,
   * screeningReport, etc.
   *
   * @param {string} caseId
   * @returns {Promise<Object|null>}
   */
  async getCaseWithDetails(caseId) {
    const caseResult = await this.db.query('SELECT * FROM cases WHERE id = $1', [caseId]);
    if (caseResult.rows.length === 0) return null;

    const kycCase = this._mapRow(caseResult.rows[0]);

    // Fetch all agent results for this case
    const agentResults = await this.db.query(
      'SELECT * FROM agent_results WHERE case_id = $1',
      [caseId]
    );

    const agentMap = {};
    for (const row of agentResults.rows) {
      agentMap[row.agent_type] = {
        status: row.status,
        confidence: row.confidence,
        output: row.output,
        completedAt: row.completed_at,
      };
    }

    // Map agent outputs to top-level fields
    kycCase.entityProfile = agentMap['entity-resolution']?.output || null;
    kycCase.screeningReport = agentMap['screening']?.output || null;
    kycCase.ownershipMap = agentMap['ownership-ubo']?.output || null;
    kycCase.riskAssessment = agentMap['risk-assessment']?.output || null;
    kycCase.agentResults = Object.fromEntries(
      Object.entries(agentMap).map(([type, data]) => [
        type,
        { status: data.status, confidence: data.confidence, completedAt: data.completedAt },
      ])
    );

    return kycCase;
  }

  /**
   * Map database row (snake_case) to API response (camelCase).
   */
  _mapRow(row) {
    return {
      id: row.id,
      clientName: row.client_name,
      clientType: row.client_type,
      jurisdiction: row.jurisdiction,
      registrationNumber: row.registration_number,
      additionalIdentifiers: row.additional_identifiers,
      state: row.state,
      ddLevel: row.dd_level,
      riskScore: row.risk_score,
      riskRating: row.risk_rating,
      assignedReviewer: row.assigned_reviewer,
      reviewDecision: row.review_decision,
      reviewComment: row.review_comment,
      reviewedAt: row.reviewed_at,
      source: row.source,
      tags: row.tags,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }
}

module.exports = { CaseManagementService };
```

### File: `backend/src/api/index.js`

```javascript
const { casesRoutes } = require('./cases/routes');
const { fragmentsRoutes } = require('./fragments/routes');

/**
 * Register all API routes under /api/v1 prefix.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {Object} deps - Service dependencies
 */
async function registerApiRoutes(app, deps) {
  app.register(
    async function v1Routes(v1) {
      v1.register(casesRoutes.bind(null, v1, deps));
      v1.register(fragmentsRoutes.bind(null, v1, deps));
    },
    { prefix: '/api/v1' }
  );

  // Global error handler for consistent error format
  app.setErrorHandler((error, request, reply) => {
    // Fastify validation errors
    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: error.validation,
        },
      });
    }

    request.log.error(error);
    return reply.status(error.statusCode || 500).send({
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: error.statusCode ? error.message : 'Internal server error',
      },
    });
  });
}

module.exports = { registerApiRoutes };
```

### API Endpoint Summary

| Method | Endpoint | Purpose | Auth Required |
|--------|----------|---------|---------------|
| `POST` | `/api/v1/cases` | Create case + trigger orchestrator | analyst+ |
| `GET` | `/api/v1/cases` | List cases with filters | analyst+ |
| `GET` | `/api/v1/cases/:id` | Get full case details | analyst+ |
| `GET` | `/api/v1/cases/:id/timeline` | Get event timeline | analyst+ |
| `POST` | `/api/v1/cases/:id/documents` | Upload document | analyst+ |
| `POST` | `/api/v1/cases/:id/rerun/:agent` | Re-run agent | senior_analyst+ |
| `PATCH` | `/api/v1/cases/:id/state` | Manual state transition | senior_analyst+ |

### Cursor-Based Pagination

List endpoints use cursor-based pagination for stable results under concurrent inserts:

```
GET /api/v1/cases?limit=50
→ { cases: [...50], nextCursor: "uuid-of-last", total: 150 }

GET /api/v1/cases?cursor=uuid-of-last&limit=50
→ { cases: [...50], nextCursor: "uuid-of-100th", total: 150 }

GET /api/v1/cases?cursor=uuid-of-100th&limit=50
→ { cases: [...50], nextCursor: null, total: 150 }
```

### Error Response Format

All errors follow a consistent shape:

```json
{
  "error": {
    "code": "CASE_NOT_FOUND",
    "message": "Case 550e8400-e29b-41d4-a716-446655440000 not found",
    "details": {}
  }
}
```

| Error Code | HTTP Status | When |
|-----------|-------------|------|
| `VALIDATION_ERROR` | 400 | JSON Schema validation fails |
| `NO_FILE` | 400 | Document upload missing file |
| `CASE_NOT_FOUND` | 404 | Case ID does not exist |
| `CASE_TERMINAL` | 409 | Rerun attempted on APPROVED/REJECTED case |
| `INVALID_TRANSITION` | 409 | State transition not allowed |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

## Acceptance Criteria

- [ ] `POST /api/v1/cases` creates case with clientName, clientType, jurisdiction, registrationNumber (optional)
- [ ] Case creation triggers `orchestrator.startCase()` to begin agent pipeline
- [ ] `POST` validates input with JSON Schema; returns 400 on validation failure
- [ ] `GET /api/v1/cases` lists cases with filters: state, riskRating, assignedReviewer, dateRange, search
- [ ] List endpoint supports cursor-based pagination (`cursor` + `limit` params)
- [ ] List endpoint supports sorting by created_at, updated_at, risk_score (asc/desc)
- [ ] List response includes `cases`, `nextCursor`, `total`
- [ ] `GET /api/v1/cases/:id` returns full case details including agent results (entityProfile, screeningReport, etc.)
- [ ] `GET /api/v1/cases/:id` returns 404 for non-existent case
- [ ] `GET /api/v1/cases/:id/timeline` returns chronological event timeline with optional filters
- [ ] `POST /api/v1/cases/:id/documents` accepts multipart file upload and stores in MinIO
- [ ] `POST /api/v1/cases/:id/rerun/:agent` re-enqueues agent; rejects terminal-state cases with 409
- [ ] `PATCH /api/v1/cases/:id/state` transitions case state; rejects invalid transitions with 409
- [ ] All endpoints return consistent error format `{ error: { code, message, details } }`
- [ ] Database row mapping: snake_case → camelCase in all responses

## Dependencies

- **Depends on**: #4 (Fastify backend scaffold), #3 (PostgreSQL schema — cases + agent_results tables), #23 (Orchestrator — `startCase()`, `manualTransition()`, `rerunAgent()`), #25 (Event Store — timeline endpoint), #6 (MinIO — document storage)
- **Blocks**: #35 (Fragments API — same route prefix), #36 (WebSocket — emits events on case changes), #39-#43 (Frontend — consumes all endpoints)

## Testing Strategy

1. **Create case — valid**: POST with valid body, verify 201 response with generated ID, state=CREATED
2. **Create case — validation**: POST with missing clientName, verify 400 with validation error
3. **Create case — triggers orchestrator**: POST, verify `orchestrator.startCase()` called with case ID
4. **List cases — no filters**: GET, verify all cases returned with pagination
5. **List cases — state filter**: GET with `?state=PENDING_HUMAN_REVIEW`, verify only matching cases
6. **List cases — search**: GET with `?search=acme`, verify ILIKE filtering works
7. **List cases — sort**: GET with `?sortBy=risk_score&sortOrder=desc`, verify ordering
8. **List cases — cursor pagination**: Fetch page 1, use nextCursor for page 2, verify no overlap
9. **Get case — exists**: GET valid ID, verify full case with agent results
10. **Get case — not found**: GET invalid ID, verify 404
11. **Get case — with agent results**: Case has entity-resolution result, verify entityProfile populated
12. **Timeline — valid case**: GET timeline, verify chronological events returned
13. **Timeline — filters**: GET with `?agentType=screening`, verify filtered results
14. **Upload document — success**: POST multipart file, verify 201 and document record created
15. **Upload document — no file**: POST without file, verify 400
16. **Rerun agent — success**: POST rerun for valid agent type, verify job enqueued
17. **Rerun agent — terminal state**: POST rerun on APPROVED case, verify 409
18. **Patch state — valid**: PATCH with allowed transition, verify state updated
19. **Patch state — invalid**: PATCH with disallowed transition, verify 409
20. **Error format**: Trigger various errors, verify all match `{ error: { code, message } }` shape
