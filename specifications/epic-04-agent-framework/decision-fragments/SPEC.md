# Decision Fragment Store and Model

> GitHub Issue: [#22](https://github.com/jbillay/kyc-agent/issues/22)
> Epic: Agent Framework Core (#20)
> Size: M (1-3 days) | Priority: Critical

## Context

Decision Fragments are the core audit and explainability unit. Every agent decision — "matched to registry X", "sanctions hit dismissed due to DOB mismatch", "UBO identified with 60% indirect ownership" — is a typed fragment with confidence, evidence, and review status. Fragments are stored in `decision_fragments` for querying and simultaneously logged to `decision_events` for the immutable audit trail. Humans can review and override fragment statuses, but the original fragment is never modified — status changes create new events.

## Requirements

### Functional

1. `DecisionFragment` model with all fields: id, caseId, agentType, stepId, timestamp, type, decision, confidence, evidence, status
2. All fragment types supported (entity_match, ubo_identified, sanctions_clear, etc.)
3. Evidence includes: data sources consulted, specific data points, LLM reasoning
4. Fragments stored in both `decision_fragments` (queryable) and `decision_events` (append-only)
5. Fragment status tracking: auto_approved, pending_review, human_approved, human_rejected, human_modified, dismissed
6. Service methods: `createFragment`, `getFragmentsByCase`, `getFragmentsByAgent`, `updateFragmentStatus`
7. Fragments are immutable once created (status updates create new events)

### Non-Functional

- Fragment creation is transactional (both tables or neither)
- Fragment retrieval supports pagination for cases with many fragments
- Status updates are audit-logged (who, when, why)

## Technical Design

### File: `backend/src/agents/decision-fragment.js`

```javascript
const crypto = require('crypto');
const { pool } = require('../db/connection');
const { appendEvent } = require('../services/event-store');

// ─── Fragment Type Constants ────────────────────────

const FragmentType = {
  // Entity Resolution
  ENTITY_MATCH: 'entity_match',
  ENTITY_DETAIL_EXTRACTED: 'entity_detail_extracted',
  OFFICER_IDENTIFIED: 'officer_identified',

  // Ownership & UBO
  SHAREHOLDER_IDENTIFIED: 'shareholder_identified',
  UBO_IDENTIFIED: 'ubo_identified',
  UBO_CHAIN_TRACED: 'ubo_chain_traced',
  UBO_DEAD_END: 'ubo_dead_end',

  // Screening
  SANCTIONS_CLEAR: 'sanctions_clear',
  SANCTIONS_HIT: 'sanctions_hit',
  SANCTIONS_DISMISSED: 'sanctions_dismissed',
  PEP_CLEAR: 'pep_clear',
  PEP_HIT: 'pep_hit',
  ADVERSE_MEDIA_CLEAR: 'adverse_media_clear',
  ADVERSE_MEDIA_HIT: 'adverse_media_hit',

  // Document Analysis
  DOCUMENT_VERIFIED: 'document_verified',
  DOCUMENT_DISCREPANCY: 'document_discrepancy',

  // Risk Assessment
  RISK_FACTOR_IDENTIFIED: 'risk_factor_identified',
  RISK_SCORE_CALCULATED: 'risk_score_calculated',
  NARRATIVE_GENERATED: 'narrative_generated',

  // QA
  QA_COMPLETENESS: 'qa_completeness',
  QA_CONSISTENCY: 'qa_consistency',
  QA_COMPLIANCE: 'qa_compliance',
  QA_SUMMARY: 'qa_summary',
};

const FragmentStatus = {
  AUTO_APPROVED: 'auto_approved',
  PENDING_REVIEW: 'pending_review',
  HUMAN_APPROVED: 'human_approved',
  HUMAN_REJECTED: 'human_rejected',
  HUMAN_MODIFIED: 'human_modified',
  DISMISSED: 'dismissed',
};

/**
 * @typedef {Object} DecisionFragment
 * @property {string} id - UUID
 * @property {string} caseId
 * @property {string} agentType
 * @property {string} stepId
 * @property {string} timestamp - ISO 8601
 * @property {string} type - One of FragmentType values
 * @property {string} decision - Human-readable decision statement
 * @property {number} confidence - 0-100
 * @property {Evidence} evidence
 * @property {string} status - One of FragmentStatus values
 * @property {string} [reviewedBy] - User ID
 * @property {string} [reviewComment]
 * @property {string} [reviewedAt]
 */

/**
 * @typedef {Object} Evidence
 * @property {string[]} dataSources - e.g., ['companies-house', 'ofac-sdn']
 * @property {DataPoint[]} dataPoints
 * @property {string} [llmReasoning] - LLM's reasoning text
 */

/**
 * @typedef {Object} DataPoint
 * @property {string} source - Provider name
 * @property {string} field - e.g., 'company_name', 'match_score'
 * @property {*} value
 * @property {string} fetchedAt - ISO 8601
 * @property {string} [cacheId] - Reference to data_source_cache entry
 */

// ─── Service Functions ──────────────────────────────

/**
 * Create a decision fragment.
 *
 * Inserts into decision_fragments (queryable) and logs to decision_events (audit).
 * Wrapped in a transaction.
 *
 * @param {Partial<DecisionFragment>} fragment - Must include at least: caseId, agentType, type, decision, confidence, evidence
 * @returns {Promise<DecisionFragment>}
 */
async function createFragment(fragment) {
  const id = fragment.id || crypto.randomUUID();
  const timestamp = fragment.timestamp || new Date().toISOString();
  const status = fragment.status || FragmentStatus.PENDING_REVIEW;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Insert into decision_fragments
    await client.query(
      `INSERT INTO decision_fragments
         (id, case_id, agent_type, step_id, created_at, fragment_type,
          decision, confidence, evidence, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id, fragment.caseId, fragment.agentType, fragment.stepId || null,
        timestamp, fragment.type, fragment.decision, fragment.confidence,
        JSON.stringify(fragment.evidence || {}), status,
      ]
    );

    // Append to decision_events (immutable audit)
    await client.query(
      `INSERT INTO decision_events
         (case_id, agent_type, step_id, event_type, event_data, created_at)
       VALUES ($1, $2, $3, 'fragment', $4, $5)`,
      [
        fragment.caseId, fragment.agentType, fragment.stepId || null,
        JSON.stringify({
          fragmentId: id,
          type: fragment.type,
          decision: fragment.decision,
          confidence: fragment.confidence,
          evidence: fragment.evidence,
          status,
        }),
        timestamp,
      ]
    );

    await client.query('COMMIT');

    return {
      id,
      caseId: fragment.caseId,
      agentType: fragment.agentType,
      stepId: fragment.stepId || null,
      timestamp,
      type: fragment.type,
      decision: fragment.decision,
      confidence: fragment.confidence,
      evidence: fragment.evidence || {},
      status,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get all fragments for a case.
 *
 * @param {string} caseId
 * @param {Object} [filters]
 * @param {string} [filters.agentType]
 * @param {string} [filters.fragmentType]
 * @param {string} [filters.status]
 * @param {number} [filters.minConfidence]
 * @param {number} [filters.maxConfidence]
 * @param {number} [filters.limit=100]
 * @param {number} [filters.offset=0]
 * @returns {Promise<{ fragments: DecisionFragment[], total: number }>}
 */
async function getFragmentsByCase(caseId, filters = {}) {
  const conditions = ['case_id = $1'];
  const params = [caseId];
  let paramIndex = 2;

  if (filters.agentType) {
    conditions.push(`agent_type = $${paramIndex++}`);
    params.push(filters.agentType);
  }
  if (filters.fragmentType) {
    conditions.push(`fragment_type = $${paramIndex++}`);
    params.push(filters.fragmentType);
  }
  if (filters.status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(filters.status);
  }
  if (filters.minConfidence !== undefined) {
    conditions.push(`confidence >= $${paramIndex++}`);
    params.push(filters.minConfidence);
  }
  if (filters.maxConfidence !== undefined) {
    conditions.push(`confidence <= $${paramIndex++}`);
    params.push(filters.maxConfidence);
  }

  const where = conditions.join(' AND ');
  const limit = filters.limit || 100;
  const offset = filters.offset || 0;

  const [countResult, dataResult] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM decision_fragments WHERE ${where}`, params),
    pool.query(
      `SELECT id, case_id, agent_type, step_id, created_at, fragment_type,
              decision, confidence, evidence, status,
              reviewed_by, review_comment, reviewed_at
       FROM decision_fragments
       WHERE ${where}
       ORDER BY created_at ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limit, offset]
    ),
  ]);

  return {
    fragments: dataResult.rows.map(_mapRow),
    total: parseInt(countResult.rows[0].count, 10),
  };
}

/**
 * Get all fragments produced by a specific agent run.
 *
 * @param {string} caseId
 * @param {string} agentType
 * @returns {Promise<DecisionFragment[]>}
 */
async function getFragmentsByAgent(caseId, agentType) {
  const result = await pool.query(
    `SELECT id, case_id, agent_type, step_id, created_at, fragment_type,
            decision, confidence, evidence, status,
            reviewed_by, review_comment, reviewed_at
     FROM decision_fragments
     WHERE case_id = $1 AND agent_type = $2
     ORDER BY created_at ASC`,
    [caseId, agentType]
  );
  return result.rows.map(_mapRow);
}

/**
 * Update a fragment's review status.
 *
 * Does NOT modify the original fragment — updates the status column
 * and creates a new decision_event for the audit trail.
 *
 * @param {string} fragmentId
 * @param {Object} review
 * @param {string} review.status - New status (human_approved, human_rejected, human_modified)
 * @param {string} review.reviewedBy - User ID
 * @param {string} [review.comment]
 * @returns {Promise<DecisionFragment>}
 */
async function updateFragmentStatus(fragmentId, review) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update the queryable record
    const result = await client.query(
      `UPDATE decision_fragments
       SET status = $1, reviewed_by = $2, review_comment = $3, reviewed_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [review.status, review.reviewedBy, review.comment || null, fragmentId]
    );

    if (result.rows.length === 0) {
      throw Object.assign(new Error('Fragment not found'), { code: 'NOT_FOUND' });
    }

    const row = result.rows[0];

    // Append review event to audit trail
    await client.query(
      `INSERT INTO decision_events
         (case_id, agent_type, step_id, event_type, event_data, created_at)
       VALUES ($1, $2, $3, 'review_action', $4, NOW())`,
      [
        row.case_id, row.agent_type, row.step_id,
        JSON.stringify({
          fragmentId,
          previousStatus: row.status, // Note: already updated, so we log the new status
          newStatus: review.status,
          reviewedBy: review.reviewedBy,
          comment: review.comment,
        }),
      ]
    );

    await client.query('COMMIT');
    return _mapRow(row);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Map a database row to a DecisionFragment.
 */
function _mapRow(row) {
  return {
    id: row.id,
    caseId: row.case_id,
    agentType: row.agent_type,
    stepId: row.step_id,
    timestamp: row.created_at?.toISOString ? row.created_at.toISOString() : row.created_at,
    type: row.fragment_type,
    decision: row.decision,
    confidence: row.confidence,
    evidence: typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence,
    status: row.status,
    reviewedBy: row.reviewed_by || undefined,
    reviewComment: row.review_comment || undefined,
    reviewedAt: row.reviewed_at?.toISOString ? row.reviewed_at.toISOString() : row.reviewed_at || undefined,
  };
}

module.exports = {
  FragmentType,
  FragmentStatus,
  createFragment,
  getFragmentsByCase,
  getFragmentsByAgent,
  updateFragmentStatus,
};
```

### Fragment Types

| Type | Agent | Meaning |
|------|-------|---------|
| `entity_match` | Entity Resolution | Matched client to registry record |
| `entity_detail_extracted` | Entity Resolution | Extracted SIC code, address, etc. |
| `officer_identified` | Entity Resolution | Identified director/secretary |
| `shareholder_identified` | Ownership | Classified shareholder as individual/corporate |
| `ubo_identified` | Ownership | Identified ultimate beneficial owner |
| `ubo_chain_traced` | Ownership | Traced ownership through intermediaries |
| `ubo_dead_end` | Ownership | Cannot trace beyond this point |
| `sanctions_clear` | Screening | No sanctions matches for this person |
| `sanctions_hit` | Screening | Potential sanctions match found |
| `sanctions_dismissed` | Screening | Hit dismissed with reasoning |
| `pep_clear` | Screening | No PEP matches |
| `pep_hit` | Screening | PEP match found |
| `adverse_media_clear` | Screening | No relevant adverse media |
| `adverse_media_hit` | Screening | Relevant adverse media found |
| `document_verified` | Document Analysis | Document matches registry data |
| `document_discrepancy` | Document Analysis | Data mismatch detected |
| `risk_factor_identified` | Risk Assessment | Specific risk factor flagged |
| `risk_score_calculated` | Risk Assessment | Final risk score computed |
| `narrative_generated` | Risk Assessment | Risk narrative produced |

### Fragment Status Lifecycle

```
                    ┌─────────────────┐
                    │  auto_approved   │ ← Low-risk fragments approved by QA agent
                    └─────────────────┘

┌──────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  (created)   │───►│ pending_review   │───►│ human_approved   │
└──────────────┘    └────────┬────────┘    └─────────────────┘
                             │
                             ├───────────►┌─────────────────┐
                             │            │ human_rejected    │
                             │            └─────────────────┘
                             │
                             └───────────►┌─────────────────┐
                                          │ human_modified    │
                                          └─────────────────┘
```

### Evidence Structure

```javascript
{
  dataSources: ['companies-house'],
  dataPoints: [
    {
      source: 'companies-house',
      field: 'company_name',
      value: 'Barclays Bank PLC',
      fetchedAt: '2026-04-04T10:00:00Z',
      cacheId: 'abc-123'
    }
  ],
  llmReasoning: 'The company name matches exactly and the registration number...'
}
```

## Acceptance Criteria

- [ ] `DecisionFragment` model with all fields: id, caseId, agentType, stepId, timestamp, type, decision, confidence, evidence, status
- [ ] All 19 fragment types defined as constants in `FragmentType`
- [ ] All 5 statuses defined as constants in `FragmentStatus`
- [ ] `createFragment` inserts into both `decision_fragments` and `decision_events` in a transaction
- [ ] `getFragmentsByCase` returns paginated fragments with filters (agentType, fragmentType, status, confidence range)
- [ ] `getFragmentsByAgent` returns all fragments for a case + agent combination
- [ ] `updateFragmentStatus` updates status, records reviewer, and creates audit event
- [ ] Evidence includes data sources, data points, and LLM reasoning
- [ ] Fragment creation is transactional (both tables or neither)
- [ ] Status updates log to `decision_events` for audit

## Dependencies

- **Depends on**: #3 (Database — `decision_fragments` + `decision_events` tables), #4 (Backend scaffold)
- **Blocks**: #21 (Base Agent — produces fragments), #25 (Event store — receives fragment events)

## Testing Strategy

1. **Create fragment**: Create a fragment, verify it exists in both `decision_fragments` and `decision_events`
2. **Required fields**: Create fragment missing required fields — verify error
3. **Get by case**: Create 5 fragments for a case, verify `getFragmentsByCase` returns all 5
4. **Filter by agent**: Create fragments from 2 agents, filter by one — verify correct subset
5. **Filter by type**: Create mixed types, filter by `sanctions_hit` — verify correct subset
6. **Filter by confidence**: Create fragments with confidence 60, 80, 95 — filter min=70 — verify 80 and 95 returned
7. **Pagination**: Create 15 fragments, request limit=5 offset=5 — verify correct page
8. **Update status**: Update to `human_approved`, verify status changed and audit event created
9. **Update nonexistent**: Update fragment that doesn't exist — verify `NOT_FOUND` error
10. **Transaction rollback**: Simulate DB error during insert — verify neither table has the record
11. **Fragment types**: Verify all `FragmentType` constants are strings
12. **Evidence structure**: Create fragment with full evidence (dataSources, dataPoints, llmReasoning), verify round-trip
