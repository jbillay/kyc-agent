'use strict';

const { query } = require('../../db/connection');

/**
 * Emit an immutable event to the append-only decision_events table.
 *
 * The decision_events table enforces append-only semantics at the database level
 * via PostgreSQL rules that block UPDATE and DELETE. Callers must never attempt
 * to modify or retract an emitted event.
 *
 * @param {Object} opts
 * @param {string} opts.caseId      - UUID of the associated KYC case
 * @param {string} opts.agentType   - Originating agent or service (e.g. 'document-service')
 * @param {string} opts.stepId      - Step within the agent/service (e.g. 'upload')
 * @param {string} opts.eventType   - Canonical event name (e.g. 'document_uploaded')
 * @param {Object} opts.eventData   - Arbitrary JSON payload for the event
 * @returns {Promise<void>}
 */
async function emit({ caseId, agentType, stepId, eventType, eventData }) {
  await query(
    `INSERT INTO decision_events (case_id, agent_type, step_id, event_type, event_data)
     VALUES ($1, $2, $3, $4, $5)`,
    [caseId, agentType, stepId, eventType, JSON.stringify(eventData)]
  );
}

module.exports = { emit };
