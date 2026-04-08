# Review API Endpoints

> GitHub Issue: TBD (see EPIC [#61](https://github.com/jbillay/kyc-agent/issues/61))
> Epic: Human Review Workflow (#61)
> Size: L (3-5 days) | Priority: Critical

## Context

The Review API provides the backend endpoints that power the entire human review workflow. It exposes five core operations defined in the architecture (section 7.2): fetching the review queue for the current user, approving/rejecting/escalating cases, requesting additional information, and overriding individual decision fragments. All endpoints enforce RBAC (analysts review assigned cases, senior analysts can review any case) and log every action as an immutable `review_action` event in the decision event store.

This is the backend foundation that all frontend review stories (#64, #65, #66) depend on.

## Requirements

### Functional

1. `GET /api/v1/review/queue` — list cases pending review for the current user
2. `POST /api/v1/review/:caseId/approve` — approve a case (final decision)
3. `POST /api/v1/review/:caseId/reject` — reject a case with mandatory reason
4. `POST /api/v1/review/:caseId/escalate` — escalate to senior reviewer with notes
5. `POST /api/v1/review/:caseId/request-info` — request additional information
6. `PATCH /api/v1/review/:caseId/fragments/:fragmentId` — override a decision fragment
7. All endpoints validated with Fastify JSON Schema
8. All review actions logged as `review_action` events in the event store
9. Case state transitions enforced: only cases in `PENDING_HUMAN_REVIEW` can be reviewed
10. RBAC: `analyst` can review cases assigned to them; `senior_analyst+` can review any case
11. WebSocket events emitted for review assignments and decisions

### Non-Functional

- Queue endpoint responds within 200ms for up to 500 pending cases
- Decision endpoints respond within 300ms (includes event store write)
- Fragment override preserves the original fragment data alongside the human modification

## Technical Design

### File: `backend/src/api/review/schemas.js`

```javascript
/**
 * Fastify JSON Schema definitions for Review API.
 */

const queueQuerySchema = {
  querystring: {
    type: 'object',
    properties: {
      riskRating: { type: 'string', enum: ['low', 'medium', 'high', 'very_high'] },
      qaStatus: { type: 'string', enum: ['passed', 'failed', 'not_applicable'] },
      sortBy: { type: 'string', enum: ['risk_score', 'created_at'], default: 'risk_score' },
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
        cases: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              clientName: { type: 'string' },
              jurisdiction: { type: 'string' },
              riskScore: { type: 'integer' },
              riskRating: { type: 'string' },
              qaStatus: { type: ['string', 'null'] },
              qaIssues: { type: ['array', 'null'], items: { type: 'string' } },
              assignedReviewer: { type: ['string', 'null'] },
              processingTimeMs: { type: 'integer' },
              fragmentCount: { type: 'integer' },
              reviewedFragmentCount: { type: 'integer' },
              createdAt: { type: 'string', format: 'date-time' },
            },
          },
        },
        nextCursor: { type: ['string', 'null'] },
        total: { type: 'integer' },
        stats: {
          type: 'object',
          properties: {
            totalPending: { type: 'integer' },
            highRisk: { type: 'integer' },
            mediumRisk: { type: 'integer' },
            lowRisk: { type: 'integer' },
            qaPassed: { type: 'integer' },
          },
        },
      },
    },
  },
};

const caseIdParam = {
  params: {
    type: 'object',
    required: ['caseId'],
    properties: {
      caseId: { type: 'string', format: 'uuid' },
    },
  },
};

const approveSchema = {
  ...caseIdParam,
  body: {
    type: 'object',
    properties: {
      comment: { type: 'string', maxLength: 2000 },
    },
    additionalProperties: false,
  },
};

const rejectSchema = {
  ...caseIdParam,
  body: {
    type: 'object',
    required: ['reason', 'reasonCode'],
    properties: {
      reasonCode: {
        type: 'string',
        enum: [
          'sanctions_match',
          'unacceptable_risk',
          'insufficient_documentation',
          'fraudulent_entity',
          'regulatory_prohibition',
          'adverse_media_concerns',
          'ownership_opacity',
          'other',
        ],
      },
      reason: { type: 'string', minLength: 10, maxLength: 2000 },
    },
    additionalProperties: false,
  },
};

const escalateSchema = {
  ...caseIdParam,
  body: {
    type: 'object',
    required: ['notes'],
    properties: {
      notes: { type: 'string', minLength: 10, maxLength: 2000 },
      suggestedAction: { type: 'string', maxLength: 500 },
    },
    additionalProperties: false,
  },
};

const requestInfoSchema = {
  ...caseIdParam,
  body: {
    type: 'object',
    required: ['requestedItems'],
    properties: {
      requestedItems: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['description'],
          properties: {
            description: { type: 'string', minLength: 5, maxLength: 1000 },
            category: {
              type: 'string',
              enum: ['document', 'clarification', 'verification', 'other'],
            },
          },
        },
      },
      notes: { type: 'string', maxLength: 2000 },
    },
    additionalProperties: false,
  },
};

const fragmentOverrideSchema = {
  params: {
    type: 'object',
    required: ['caseId', 'fragmentId'],
    properties: {
      caseId: { type: 'string', format: 'uuid' },
      fragmentId: { type: 'string', format: 'uuid' },
    },
  },
  body: {
    type: 'object',
    required: ['action'],
    properties: {
      action: { type: 'string', enum: ['approve', 'reject', 'modify'] },
      reason: { type: 'string', maxLength: 2000 },
      modifiedDecision: { type: 'string', maxLength: 5000 },
      modifiedConfidence: { type: 'integer', minimum: 0, maximum: 100 },
    },
    additionalProperties: false,
  },
};

module.exports = {
  queueQuerySchema,
  approveSchema,
  rejectSchema,
  escalateSchema,
  requestInfoSchema,
  fragmentOverrideSchema,
};
```

### File: `backend/src/api/review/handlers.js`

```javascript
const { EventType } = require('../../services/event-store');

/**
 * @param {Object} deps
 * @param {import('../../services/review-service').ReviewService} deps.reviewService
 * @param {import('../../services/event-store')} deps.eventStore
 * @param {import('../../services/case-management').CaseManagementService} deps.caseService
 * @param {import('socket.io').Server} deps.io
 */
function buildReviewHandlers(deps) {
  const { reviewService, eventStore, caseService, io } = deps;

  // ─── GET /api/v1/review/queue ─────────────────────

  async function getQueue(request, reply) {
    const userId = request.user.id;
    const role = request.user.role;
    const { riskRating, qaStatus, sortBy, sortOrder, cursor, limit } = request.query;

    const result = await reviewService.getReviewQueue({
      reviewerId: userId,
      role,
      filters: { riskRating, qaStatus },
      sort: { field: sortBy, order: sortOrder },
      pagination: { cursor, limit },
    });

    return reply.send(result);
  }

  // ─── POST /api/v1/review/:caseId/approve ──────────

  async function approveCase(request, reply) {
    const { caseId } = request.params;
    const { comment } = request.body || {};

    const kycCase = await _validateReviewable(caseId, request, reply);
    if (!kycCase) return;

    await reviewService.approveCase(caseId, {
      reviewerId: request.user.id,
      comment,
    });

    await eventStore.appendEvent(caseId, 'reviewer', null, EventType.REVIEW_ACTION, {
      action: 'approve',
      reviewedBy: request.user.id,
      comment,
    });

    io.to(`case:${caseId}`).emit('case:state_changed', {
      caseId,
      oldState: 'PENDING_HUMAN_REVIEW',
      newState: 'APPROVED',
    });

    return reply.send({ caseId, decision: 'approved' });
  }

  // ─── POST /api/v1/review/:caseId/reject ───────────

  async function rejectCase(request, reply) {
    const { caseId } = request.params;
    const { reasonCode, reason } = request.body;

    const kycCase = await _validateReviewable(caseId, request, reply);
    if (!kycCase) return;

    await reviewService.rejectCase(caseId, {
      reviewerId: request.user.id,
      reasonCode,
      reason,
    });

    await eventStore.appendEvent(caseId, 'reviewer', null, EventType.REVIEW_ACTION, {
      action: 'reject',
      reviewedBy: request.user.id,
      reasonCode,
      reason,
    });

    io.to(`case:${caseId}`).emit('case:state_changed', {
      caseId,
      oldState: 'PENDING_HUMAN_REVIEW',
      newState: 'REJECTED',
    });

    return reply.send({ caseId, decision: 'rejected' });
  }

  // ─── POST /api/v1/review/:caseId/escalate ─────────

  async function escalateCase(request, reply) {
    const { caseId } = request.params;
    const { notes, suggestedAction } = request.body;

    const kycCase = await _validateReviewable(caseId, request, reply);
    if (!kycCase) return;

    await reviewService.escalateCase(caseId, {
      reviewerId: request.user.id,
      notes,
      suggestedAction,
    });

    await eventStore.appendEvent(caseId, 'reviewer', null, EventType.REVIEW_ACTION, {
      action: 'escalate',
      reviewedBy: request.user.id,
      notes,
      suggestedAction,
    });

    io.to(`case:${caseId}`).emit('case:state_changed', {
      caseId,
      oldState: 'PENDING_HUMAN_REVIEW',
      newState: 'ESCALATED',
    });

    return reply.send({ caseId, decision: 'escalated' });
  }

  // ─── POST /api/v1/review/:caseId/request-info ─────

  async function requestInfo(request, reply) {
    const { caseId } = request.params;
    const { requestedItems, notes } = request.body;

    const kycCase = await _validateReviewable(caseId, request, reply);
    if (!kycCase) return;

    await reviewService.requestAdditionalInfo(caseId, {
      reviewerId: request.user.id,
      requestedItems,
      notes,
    });

    await eventStore.appendEvent(caseId, 'reviewer', null, EventType.REVIEW_ACTION, {
      action: 'request_info',
      reviewedBy: request.user.id,
      requestedItems,
      notes,
    });

    io.to(`case:${caseId}`).emit('case:state_changed', {
      caseId,
      oldState: 'PENDING_HUMAN_REVIEW',
      newState: 'ADDITIONAL_INFO_REQUIRED',
    });

    return reply.send({ caseId, decision: 'additional_info_required' });
  }

  // ─── PATCH /api/v1/review/:caseId/fragments/:fragmentId ──

  async function overrideFragment(request, reply) {
    const { caseId, fragmentId } = request.params;
    const { action, reason, modifiedDecision, modifiedConfidence } = request.body;

    const kycCase = await _validateReviewable(caseId, request, reply);
    if (!kycCase) return;

    if (action === 'reject' && !reason) {
      return reply.status(400).send({
        error: { code: 'REASON_REQUIRED', message: 'Reason is required when rejecting a fragment' },
      });
    }
    if (action === 'modify' && !modifiedDecision) {
      return reply.status(400).send({
        error: { code: 'DECISION_REQUIRED', message: 'Modified decision is required when modifying a fragment' },
      });
    }

    const updated = await reviewService.overrideFragment(caseId, fragmentId, {
      action,
      reviewerId: request.user.id,
      reason,
      modifiedDecision,
      modifiedConfidence,
    });

    await eventStore.appendEvent(caseId, 'reviewer', null, EventType.REVIEW_ACTION, {
      action: `fragment_${action}`,
      fragmentId,
      reviewedBy: request.user.id,
      reason,
      modifiedDecision,
      newStatus: updated.reviewStatus,
    });

    io.to(`case:${caseId}`).emit('case:fragment_reviewed', {
      caseId,
      fragmentId,
      action,
      reviewedBy: request.user.id,
    });

    return reply.send(updated);
  }

  // ─── Internal helpers ─────────────────────────────

  async function _validateReviewable(caseId, request, reply) {
    const kycCase = await caseService.getCase(caseId);

    if (!kycCase) {
      reply.status(404).send({
        error: { code: 'CASE_NOT_FOUND', message: `Case ${caseId} not found` },
      });
      return null;
    }

    if (kycCase.state !== 'PENDING_HUMAN_REVIEW') {
      reply.status(409).send({
        error: {
          code: 'NOT_REVIEWABLE',
          message: `Case is in state ${kycCase.state}, must be PENDING_HUMAN_REVIEW`,
        },
      });
      return null;
    }

    // RBAC: analysts can only review assigned cases
    if (request.user.role === 'analyst' && kycCase.assignedReviewer !== request.user.id) {
      reply.status(403).send({
        error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to review this case' },
      });
      return null;
    }

    return kycCase;
  }

  return {
    getQueue,
    approveCase,
    rejectCase,
    escalateCase,
    requestInfo,
    overrideFragment,
  };
}

module.exports = { buildReviewHandlers };
```

### File: `backend/src/api/review/routes.js`

```javascript
const { buildReviewHandlers } = require('./handlers');
const {
  queueQuerySchema,
  approveSchema,
  rejectSchema,
  escalateSchema,
  requestInfoSchema,
  fragmentOverrideSchema,
} = require('./schemas');

/**
 * Register Review API routes under /api/v1/review.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {Object} deps - Service dependencies
 */
async function reviewRoutes(app, deps) {
  const handlers = buildReviewHandlers(deps);

  app.get('/review/queue', { schema: queueQuerySchema }, handlers.getQueue);
  app.post('/review/:caseId/approve', { schema: approveSchema }, handlers.approveCase);
  app.post('/review/:caseId/reject', { schema: rejectSchema }, handlers.rejectCase);
  app.post('/review/:caseId/escalate', { schema: escalateSchema }, handlers.escalateCase);
  app.post('/review/:caseId/request-info', { schema: requestInfoSchema }, handlers.requestInfo);
  app.patch('/review/:caseId/fragments/:fragmentId', { schema: fragmentOverrideSchema }, handlers.overrideFragment);
}

module.exports = { reviewRoutes };
```

### File: `backend/src/services/review-service.js`

```javascript
/**
 * Review Service — business logic for human review workflow.
 *
 * @param {Object} deps
 * @param {import('pg').Pool} deps.db
 */
class ReviewService {
  constructor({ db }) {
    this.db = db;
  }

  /**
   * Get cases pending review for a given reviewer.
   *
   * - Analysts see only cases assigned to them.
   * - Senior analysts and above see all pending cases.
   *
   * @param {Object} options
   * @param {string} options.reviewerId
   * @param {string} options.role
   * @param {Object} options.filters
   * @param {Object} options.sort
   * @param {Object} options.pagination
   * @returns {Promise<{ cases: Object[], nextCursor: string|null, total: number, stats: Object }>}
   */
  async getReviewQueue({ reviewerId, role, filters, sort, pagination }) {
    const conditions = ["c.state = 'PENDING_HUMAN_REVIEW'"];
    const params = [];
    let paramIdx = 1;

    // Analysts see only their assigned cases
    if (role === 'analyst') {
      conditions.push(`c.assigned_reviewer = $${paramIdx++}`);
      params.push(reviewerId);
    }

    if (filters.riskRating) {
      conditions.push(`c.risk_rating = $${paramIdx++}`);
      params.push(filters.riskRating);
    }
    if (filters.qaStatus) {
      conditions.push(`ar_qa.qa_status = $${paramIdx++}`);
      params.push(filters.qaStatus);
    }

    const where = conditions.join(' AND ');
    const sortField = sort.field === 'risk_score' ? 'c.risk_score' : 'c.created_at';
    const sortOrder = sort.order || 'desc';
    const limit = pagination.limit || 50;

    // Main query with QA status join and fragment counts
    const query = `
      SELECT
        c.id, c.client_name, c.jurisdiction, c.risk_score, c.risk_rating,
        c.assigned_reviewer, c.created_at, c.updated_at,
        EXTRACT(EPOCH FROM (c.updated_at - c.created_at)) * 1000 AS processing_time_ms,
        COALESCE(ar_qa.output->>'status', 'not_applicable') AS qa_status,
        ar_qa.output->'issues' AS qa_issues,
        COUNT(df.id) AS fragment_count,
        COUNT(df.id) FILTER (WHERE df.review_status IN ('approved', 'rejected', 'human_modified')) AS reviewed_fragment_count
      FROM cases c
      LEFT JOIN agent_results ar_qa ON ar_qa.case_id = c.id AND ar_qa.agent_type = 'qa-agent'
      LEFT JOIN decision_fragments df ON df.case_id = c.id
      WHERE ${where}
      GROUP BY c.id, ar_qa.output
      ORDER BY ${sortField} ${sortOrder}, c.id ${sortOrder}
      LIMIT $${paramIdx}
    `;

    const result = await this.db.query(query, [...params, limit + 1]);
    const rows = result.rows.slice(0, limit);
    const hasMore = result.rows.length > limit;

    // Stats query (counts by risk level and QA status)
    const statsQuery = `
      SELECT
        COUNT(*) AS total_pending,
        COUNT(*) FILTER (WHERE risk_rating = 'high' OR risk_rating = 'very_high') AS high_risk,
        COUNT(*) FILTER (WHERE risk_rating = 'medium') AS medium_risk,
        COUNT(*) FILTER (WHERE risk_rating = 'low') AS low_risk,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM agent_results ar WHERE ar.case_id = cases.id
            AND ar.agent_type = 'qa-agent' AND ar.output->>'status' = 'passed'
        )) AS qa_passed
      FROM cases
      WHERE state = 'PENDING_HUMAN_REVIEW'
    `;
    const statsResult = await this.db.query(statsQuery);
    const stats = statsResult.rows[0];

    return {
      cases: rows.map((r) => ({
        id: r.id,
        clientName: r.client_name,
        jurisdiction: r.jurisdiction,
        riskScore: r.risk_score,
        riskRating: r.risk_rating,
        qaStatus: r.qa_status,
        qaIssues: r.qa_issues,
        assignedReviewer: r.assigned_reviewer,
        processingTimeMs: parseInt(r.processing_time_ms, 10),
        fragmentCount: parseInt(r.fragment_count, 10),
        reviewedFragmentCount: parseInt(r.reviewed_fragment_count, 10),
        createdAt: r.created_at,
      })),
      nextCursor: hasMore ? rows[rows.length - 1].id : null,
      total: parseInt(stats.total_pending, 10),
      stats: {
        totalPending: parseInt(stats.total_pending, 10),
        highRisk: parseInt(stats.high_risk, 10),
        mediumRisk: parseInt(stats.medium_risk, 10),
        lowRisk: parseInt(stats.low_risk, 10),
        qaPassed: parseInt(stats.qa_passed, 10),
      },
    };
  }

  /**
   * Approve a case.
   *
   * @param {string} caseId
   * @param {{ reviewerId: string, comment?: string }} data
   */
  async approveCase(caseId, { reviewerId, comment }) {
    await this.db.query(
      `UPDATE cases
       SET state = 'APPROVED', review_decision = 'approved',
           review_comment = $2, assigned_reviewer = $3,
           reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [caseId, comment || null, reviewerId]
    );
  }

  /**
   * Reject a case.
   *
   * @param {string} caseId
   * @param {{ reviewerId: string, reasonCode: string, reason: string }} data
   */
  async rejectCase(caseId, { reviewerId, reasonCode, reason }) {
    await this.db.query(
      `UPDATE cases
       SET state = 'REJECTED', review_decision = 'rejected',
           review_comment = $2, assigned_reviewer = $3,
           reviewed_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [caseId, JSON.stringify({ reasonCode, reason }), reviewerId]
    );
  }

  /**
   * Escalate a case to senior reviewer.
   *
   * @param {string} caseId
   * @param {{ reviewerId: string, notes: string, suggestedAction?: string }} data
   */
  async escalateCase(caseId, { reviewerId, notes, suggestedAction }) {
    await this.db.query(
      `UPDATE cases
       SET state = 'ESCALATED', review_decision = 'escalated',
           review_comment = $2, updated_at = NOW()
       WHERE id = $1`,
      [caseId, JSON.stringify({ escalatedBy: reviewerId, notes, suggestedAction })]
    );
  }

  /**
   * Request additional information for a case.
   *
   * @param {string} caseId
   * @param {{ reviewerId: string, requestedItems: Object[], notes?: string }} data
   */
  async requestAdditionalInfo(caseId, { reviewerId, requestedItems, notes }) {
    await this.db.query(
      `UPDATE cases
       SET state = 'ADDITIONAL_INFO_REQUIRED', review_decision = 'additional_info',
           review_comment = $2, updated_at = NOW()
       WHERE id = $1`,
      [caseId, JSON.stringify({ requestedBy: reviewerId, requestedItems, notes })]
    );
  }

  /**
   * Override a decision fragment.
   *
   * Preserves the original fragment data and stores the human override.
   *
   * @param {string} caseId
   * @param {string} fragmentId
   * @param {Object} data
   * @returns {Promise<Object>} Updated fragment
   */
  async overrideFragment(caseId, fragmentId, { action, reviewerId, reason, modifiedDecision, modifiedConfidence }) {
    let reviewStatus;
    switch (action) {
      case 'approve':
        reviewStatus = 'approved';
        break;
      case 'reject':
        reviewStatus = 'rejected';
        break;
      case 'modify':
        reviewStatus = 'human_modified';
        break;
    }

    const result = await this.db.query(
      `UPDATE decision_fragments
       SET review_status = $3,
           reviewed_by = $4,
           reviewed_at = NOW(),
           review_comment = $5,
           original_decision = CASE WHEN original_decision IS NULL THEN decision ELSE original_decision END,
           decision = COALESCE($6, decision),
           confidence = COALESCE($7, confidence),
           updated_at = NOW()
       WHERE id = $2 AND case_id = $1
       RETURNING *`,
      [caseId, fragmentId, reviewStatus, reviewerId, reason || null, modifiedDecision || null, modifiedConfidence || null]
    );

    if (result.rows.length === 0) {
      throw Object.assign(new Error('Fragment not found'), { code: 'FRAGMENT_NOT_FOUND', statusCode: 404 });
    }

    return this._mapFragment(result.rows[0]);
  }

  _mapFragment(row) {
    return {
      id: row.id,
      caseId: row.case_id,
      agentType: row.agent_type,
      type: row.type,
      decision: row.decision,
      confidence: row.confidence,
      evidence: row.evidence,
      reviewStatus: row.review_status,
      reviewedBy: row.reviewed_by,
      reviewedAt: row.reviewed_at,
      reviewComment: row.review_comment,
      originalDecision: row.original_decision,
      createdAt: row.created_at,
    };
  }
}

module.exports = { ReviewService };
```

### API Endpoint Summary

| Method | Endpoint | Purpose | Auth Required |
|--------|----------|---------|---------------|
| `GET` | `/api/v1/review/queue` | List pending review cases | analyst+ |
| `POST` | `/api/v1/review/:caseId/approve` | Approve a case | analyst+ (assigned) |
| `POST` | `/api/v1/review/:caseId/reject` | Reject with reason | analyst+ (assigned) |
| `POST` | `/api/v1/review/:caseId/escalate` | Escalate to senior | analyst+ (assigned) |
| `POST` | `/api/v1/review/:caseId/request-info` | Request more info | analyst+ (assigned) |
| `PATCH` | `/api/v1/review/:caseId/fragments/:fragmentId` | Override fragment | analyst+ (assigned) |

### Database Changes

The `decision_fragments` table requires two new columns to support human overrides:

```sql
ALTER TABLE decision_fragments
  ADD COLUMN original_decision TEXT,
  ADD COLUMN review_comment TEXT,
  ADD COLUMN reviewed_by UUID REFERENCES users(id),
  ADD COLUMN reviewed_at TIMESTAMPTZ;
```

### Error Response Format

| Error Code | HTTP Status | When |
|-----------|-------------|------|
| `CASE_NOT_FOUND` | 404 | Case ID does not exist |
| `NOT_REVIEWABLE` | 409 | Case not in PENDING_HUMAN_REVIEW state |
| `NOT_ASSIGNED` | 403 | Analyst not assigned to this case |
| `REASON_REQUIRED` | 400 | Rejecting fragment without reason |
| `DECISION_REQUIRED` | 400 | Modifying fragment without new decision |
| `FRAGMENT_NOT_FOUND` | 404 | Fragment ID does not exist for case |
| `VALIDATION_ERROR` | 400 | JSON Schema validation fails |

### WebSocket Events

```javascript
// New events emitted by review actions:
'case:state_changed'     — { caseId, oldState: 'PENDING_HUMAN_REVIEW', newState }
'case:fragment_reviewed'  — { caseId, fragmentId, action, reviewedBy }
'case:review_assigned'    — { caseId, reviewerId }  // emitted by orchestrator/QA agent
```

## Acceptance Criteria

- [ ] `GET /api/v1/review/queue` returns cases in PENDING_HUMAN_REVIEW state for the current user
- [ ] Queue endpoint includes workload stats (total, by risk level, QA passed count)
- [ ] Queue supports filters: riskRating, qaStatus; sorting by risk_score or created_at
- [ ] Queue uses cursor-based pagination
- [ ] Analysts see only their assigned cases; senior_analyst+ see all pending cases
- [ ] `POST /approve` transitions case to APPROVED, logs review_action event
- [ ] `POST /reject` requires reasonCode + reason, transitions to REJECTED
- [ ] `POST /escalate` requires notes, transitions to ESCALATED
- [ ] `POST /request-info` requires requestedItems array, transitions to ADDITIONAL_INFO_REQUIRED
- [ ] All decision endpoints reject cases not in PENDING_HUMAN_REVIEW (409)
- [ ] All decision endpoints reject unauthorized reviewers (403)
- [ ] `PATCH /fragments/:fragmentId` supports approve, reject, modify actions
- [ ] Fragment modify preserves original decision in `original_decision` column
- [ ] Fragment reject requires reason
- [ ] Fragment modify requires modifiedDecision
- [ ] All review actions logged as `review_action` events in decision_events
- [ ] WebSocket events emitted for state changes and fragment reviews
- [ ] All endpoints validated with Fastify JSON Schema
- [ ] Consistent error format: `{ error: { code, message } }`

## Dependencies

- **Depends on**: #3 (Database — cases, decision_fragments, decision_events tables), #4 (Backend scaffold), #25 (Event Store — appendEvent), #34 (Cases CRUD — caseService), #35 (Fragments API — fragment data model), #36 (WebSocket — Socket.io setup), #69 (Auth — JWT + RBAC middleware)
- **Blocks**: #64 (Review queue frontend), #65 (Fragment review frontend), #66 (Review decision frontend)

## Testing Strategy

1. **Queue — analyst**: Create 3 pending cases (2 assigned to user, 1 to another), verify queue returns 2
2. **Queue — senior analyst**: Same setup, verify all 3 returned
3. **Queue — filters**: Create cases with varying risk, filter by `riskRating=high`, verify subset
4. **Queue — stats**: Create mix of cases, verify stats counts match
5. **Queue — pagination**: Create 10 cases, request limit=3, verify cursor pagination works
6. **Approve — success**: POST approve on PENDING_HUMAN_REVIEW case, verify state=APPROVED
7. **Approve — wrong state**: POST approve on ENTITY_RESOLUTION case, verify 409
8. **Approve — not assigned**: Analyst approves unassigned case, verify 403
9. **Reject — success**: POST with reason + reasonCode, verify state=REJECTED and review_comment stored
10. **Reject — missing reason**: POST without reason, verify 400
11. **Escalate — success**: POST with notes, verify state=ESCALATED
12. **Request info — success**: POST with requestedItems, verify state=ADDITIONAL_INFO_REQUIRED
13. **Fragment approve**: PATCH with action=approve, verify reviewStatus=approved
14. **Fragment reject**: PATCH with action=reject + reason, verify reviewStatus=rejected
15. **Fragment modify**: PATCH with action=modify + modifiedDecision, verify original preserved + new decision stored
16. **Fragment modify — missing decision**: PATCH modify without modifiedDecision, verify 400
17. **Fragment not found**: PATCH with invalid fragmentId, verify 404
18. **Event store**: After each decision, verify review_action event exists in decision_events
19. **WebSocket**: After approve, verify case:state_changed emitted to case room
20. **Error format**: Trigger various errors, verify consistent `{ error: { code, message } }` shape
