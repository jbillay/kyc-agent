# Case Orchestrator with State Machine

> GitHub Issue: [#23](https://github.com/jbillay/kyc-agent/issues/23)
> Epic: Agent Framework Core (#20)
> Size: L (3-5 days) | Priority: Critical

## Context

The orchestrator manages the KYC case pipeline. When a case is created, the orchestrator drives it through the state machine — triggering agents in the correct order, handling parallel execution (ownership + screening run concurrently), waiting for dependencies, and routing to review. State transitions are persistent (survives restarts) and emit events for WebSocket updates and the audit trail.

## Requirements

### Functional

1. State machine with states: CREATED, ENTITY_RESOLUTION, OWNERSHIP_MAPPING, SCREENING, DOCUMENT_ANALYSIS, RISK_ASSESSMENT, QA_REVIEW, PENDING_HUMAN_REVIEW, APPROVED, REJECTED, ESCALATED, ADDITIONAL_INFO_REQUIRED
2. Workflow definition with agent dependencies
3. Parallel execution: ownership and screening agents run concurrently after entity resolution
4. Dependency checking: risk assessment waits for entity resolution + ownership + screening
5. State transitions emit events (for WebSocket and audit trail)
6. Manual state override capability (with auth) for edge cases
7. Error state handling: if an agent fails, case goes to error state with retry
8. Orchestrator picks up where it left off after restart (persistent state)

### Non-Functional

- State transitions are atomic (database transaction)
- No race conditions on concurrent state updates (pessimistic locking)
- Recoverable: on restart, resumes in-progress cases

## Technical Design

### File: `backend/src/agents/orchestrator.js`

```javascript
const { pool } = require('../db/connection');
const { appendEvent } = require('../services/event-store');

// ─── States ─────────────────────────────────────────

const CaseState = {
  CREATED: 'created',
  ENTITY_RESOLUTION: 'entity_resolution',
  OWNERSHIP_MAPPING: 'ownership_mapping',
  SCREENING: 'screening',
  RISK_ASSESSMENT: 'risk_assessment',
  QA_REVIEW: 'qa_review',
  PENDING_HUMAN_REVIEW: 'pending_human_review',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  ESCALATED: 'escalated',
  ADDITIONAL_INFO_REQUIRED: 'additional_info_required',
  ERROR: 'error',
};

// ─── Workflow Definition ────────────────────────────

/**
 * Defines agent dependencies and execution order.
 *
 * Key design:
 * - `agents` lists what runs in this state
 * - `parallel: true` means agents run concurrently
 * - `dependencies` maps each agent to what must have completed first
 * - `next` is the state to transition to when all agents complete
 */
const WORKFLOW = {
  [CaseState.CREATED]: {
    next: CaseState.ENTITY_RESOLUTION,
    agents: [],
  },
  [CaseState.ENTITY_RESOLUTION]: {
    agents: ['entity-resolution'],
    next: '_parallel_1',
    dependencies: {},
  },
  _parallel_1: {
    agents: ['ownership-ubo', 'screening'],
    parallel: true,
    next: CaseState.RISK_ASSESSMENT,
    dependencies: {
      'ownership-ubo': ['entity-resolution'],
      'screening': ['entity-resolution'],
    },
  },
  [CaseState.RISK_ASSESSMENT]: {
    agents: ['risk-assessment'],
    next: CaseState.QA_REVIEW,
    dependencies: {
      'risk-assessment': ['entity-resolution', 'ownership-ubo', 'screening'],
    },
  },
  [CaseState.QA_REVIEW]: {
    agents: ['qa-agent'],
    next: CaseState.PENDING_HUMAN_REVIEW,
    dependencies: {
      'qa-agent': ['risk-assessment'],
    },
  },
};

/**
 * Valid manual state transitions.
 */
const MANUAL_TRANSITIONS = {
  [CaseState.PENDING_HUMAN_REVIEW]: [
    CaseState.APPROVED,
    CaseState.REJECTED,
    CaseState.ESCALATED,
    CaseState.ADDITIONAL_INFO_REQUIRED,
  ],
  [CaseState.ADDITIONAL_INFO_REQUIRED]: [
    CaseState.PENDING_HUMAN_REVIEW, // Return to review after additional info provided
  ],
  [CaseState.ERROR]: [
    CaseState.ENTITY_RESOLUTION, // Retry from entity resolution
    CaseState.CREATED, // Full restart
  ],
};

// ─── Orchestrator ───────────────────────────────────

class Orchestrator {
  /**
   * @param {Object} deps
   * @param {Object} deps.agentQueue - BullMQ queue for agent jobs
   * @param {Function} deps.emitSocketEvent - WebSocket event emitter
   */
  constructor({ agentQueue, emitSocketEvent }) {
    this.agentQueue = agentQueue;
    this.emitSocketEvent = emitSocketEvent || (() => {});
  }

  /**
   * Start processing a newly created case.
   *
   * @param {string} caseId
   * @returns {Promise<void>}
   */
  async startCase(caseId) {
    await this.transitionState(caseId, CaseState.ENTITY_RESOLUTION);
    await this._enqueueAgents(caseId, CaseState.ENTITY_RESOLUTION);
  }

  /**
   * Called when an agent completes.
   * Checks if all agents for the current state are done, then advances.
   *
   * @param {string} caseId
   * @param {string} agentType
   * @param {'completed'|'failed'|'partial'} status
   * @returns {Promise<void>}
   */
  async onAgentCompleted(caseId, agentType, status) {
    if (status === 'failed') {
      await this.transitionState(caseId, CaseState.ERROR, {
        reason: `Agent ${agentType} failed`,
        failedAgent: agentType,
      });
      return;
    }

    const caseData = await this._getCase(caseId);
    const currentState = caseData.state;
    const workflow = this._getWorkflowForState(currentState);

    if (!workflow) return;

    // Check if all agents for this state are done
    const completedAgents = await this._getCompletedAgents(caseId);
    const allDone = workflow.agents.every((a) => completedAgents.includes(a));

    if (allDone) {
      await this._advanceToNext(caseId, workflow.next);
    }
  }

  /**
   * Transition a case to a new state.
   *
   * @param {string} caseId
   * @param {string} newState
   * @param {Object} [metadata]
   * @returns {Promise<void>}
   */
  async transitionState(caseId, newState, metadata = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Pessimistic lock on the case row
      const result = await client.query(
        `SELECT state FROM cases WHERE id = $1 FOR UPDATE`,
        [caseId]
      );

      if (result.rows.length === 0) {
        throw Object.assign(new Error('Case not found'), { code: 'NOT_FOUND' });
      }

      const previousState = result.rows[0].state;

      // Update case state
      await client.query(
        `UPDATE cases SET state = $1, updated_at = NOW() WHERE id = $2`,
        [newState, caseId]
      );

      // Log state change event
      await client.query(
        `INSERT INTO decision_events
           (case_id, agent_type, step_id, event_type, event_data, created_at)
         VALUES ($1, 'orchestrator', NULL, 'state_change', $2, NOW())`,
        [
          caseId,
          JSON.stringify({
            previousState,
            newState,
            ...metadata,
          }),
        ]
      );

      await client.query('COMMIT');

      // Emit WebSocket event (outside transaction)
      this.emitSocketEvent('case:state_changed', {
        caseId,
        previousState,
        newState,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Manually override a case's state (requires authorized user).
   *
   * @param {string} caseId
   * @param {string} newState
   * @param {string} userId - Who is making the override
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async manualTransition(caseId, newState, userId, reason) {
    const caseData = await this._getCase(caseId);
    const allowed = MANUAL_TRANSITIONS[caseData.state];

    if (!allowed || !allowed.includes(newState)) {
      throw Object.assign(
        new Error(`Cannot transition from '${caseData.state}' to '${newState}'`),
        { code: 'INVALID_TRANSITION', currentState: caseData.state, requestedState: newState }
      );
    }

    await this.transitionState(caseId, newState, {
      manual: true,
      userId,
      reason,
    });

    // If transitioning back to an agent state, re-enqueue
    if (WORKFLOW[newState]?.agents?.length > 0) {
      await this._enqueueAgents(caseId, newState);
    }
  }

  /**
   * Resume processing for cases that were in-progress when the system restarted.
   *
   * @returns {Promise<number>} Number of cases resumed
   */
  async resumeInProgressCases() {
    const agentStates = [
      CaseState.ENTITY_RESOLUTION,
      CaseState.OWNERSHIP_MAPPING,
      CaseState.SCREENING,
      CaseState.RISK_ASSESSMENT,
      CaseState.QA_REVIEW,
    ];

    const result = await pool.query(
      `SELECT id, state FROM cases WHERE state = ANY($1)`,
      [agentStates]
    );

    for (const row of result.rows) {
      const workflow = this._getWorkflowForState(row.state);
      if (workflow) {
        // Check which agents still need to run
        const completedAgents = await this._getCompletedAgents(row.id);
        const pendingAgents = workflow.agents.filter((a) => !completedAgents.includes(a));

        for (const agentType of pendingAgents) {
          await this._enqueueAgent(row.id, agentType);
        }
      }
    }

    return result.rows.length;
  }

  // ─── Internal ─────────────────────────────────────

  /**
   * Advance to the next state in the workflow.
   */
  async _advanceToNext(caseId, nextStateKey) {
    // Map internal keys to actual states
    let nextState = nextStateKey;
    if (nextStateKey === '_parallel_1') {
      // For the parallel state, set both sub-states
      nextState = CaseState.OWNERSHIP_MAPPING; // Primary state label
    }

    await this.transitionState(caseId, nextState);

    const workflow = this._getWorkflowForState(nextState) || WORKFLOW[nextStateKey];
    if (workflow?.agents?.length > 0) {
      await this._enqueueAgents(caseId, nextStateKey);
    }
  }

  /**
   * Enqueue all agents for a workflow state.
   */
  async _enqueueAgents(caseId, stateKey) {
    const workflow = WORKFLOW[stateKey] || this._getWorkflowForState(stateKey);
    if (!workflow) return;

    for (const agentType of workflow.agents) {
      await this._enqueueAgent(caseId, agentType);
    }
  }

  /**
   * Enqueue a single agent job.
   */
  async _enqueueAgent(caseId, agentType) {
    const caseData = await this._getCase(caseId);

    const job = {
      type: 'agent-execution',
      caseId,
      agentType,
      context: {
        caseId,
        entityName: caseData.client_name,
        jurisdiction: caseData.jurisdiction,
        existingData: await this._getExistingAgentData(caseId),
        config: {},
      },
    };

    await this.agentQueue.add(`${agentType}:${caseId}`, job, {
      priority: caseData.priority || 0,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
    });

    this.emitSocketEvent('case:agent_started', {
      caseId,
      agentType,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Get case data.
   */
  async _getCase(caseId) {
    const result = await pool.query(`SELECT * FROM cases WHERE id = $1`, [caseId]);
    if (result.rows.length === 0) {
      throw Object.assign(new Error('Case not found'), { code: 'NOT_FOUND' });
    }
    return result.rows[0];
  }

  /**
   * Get list of completed agent types for a case.
   */
  async _getCompletedAgents(caseId) {
    const result = await pool.query(
      `SELECT DISTINCT agent_type FROM agent_results
       WHERE case_id = $1 AND status = 'completed'`,
      [caseId]
    );
    return result.rows.map((r) => r.agent_type);
  }

  /**
   * Get existing agent results for a case (passed as context to next agent).
   */
  async _getExistingAgentData(caseId) {
    const result = await pool.query(
      `SELECT agent_type, output FROM agent_results
       WHERE case_id = $1 AND status = 'completed'
       ORDER BY completed_at ASC`,
      [caseId]
    );
    const data = {};
    for (const row of result.rows) {
      data[row.agent_type] = row.output;
    }
    return data;
  }

  /**
   * Find the workflow entry for a given case state.
   */
  _getWorkflowForState(state) {
    // Direct match
    if (WORKFLOW[state]) return WORKFLOW[state];

    // Check if the state corresponds to a parallel sub-state
    for (const [key, workflow] of Object.entries(WORKFLOW)) {
      if (workflow.parallel) {
        // ownership_mapping and screening are both in _parallel_1
        if (state === CaseState.OWNERSHIP_MAPPING || state === CaseState.SCREENING) {
          return workflow;
        }
      }
    }

    return null;
  }
}

module.exports = { Orchestrator, CaseState, WORKFLOW, MANUAL_TRANSITIONS };
```

### State Machine Transitions

| From | To | Trigger |
|------|----|---------|
| `created` | `entity_resolution` | `startCase()` |
| `entity_resolution` | `ownership_mapping` | Entity Resolution agent completes |
| `entity_resolution` | `screening` | Entity Resolution agent completes (parallel) |
| `ownership_mapping` + `screening` | `risk_assessment` | Both complete |
| `risk_assessment` | `qa_review` | Risk Assessment agent completes |
| `qa_review` | `pending_human_review` | QA agent completes |
| `pending_human_review` | `approved` / `rejected` / `escalated` / `additional_info_required` | Human decision |
| `error` | `entity_resolution` / `created` | Manual retry |
| Any agent state → `error` | Agent failure |

### Parallel Execution

When entity resolution completes, the orchestrator enqueues both `ownership-ubo` and `screening` jobs simultaneously. Each reports completion independently. Only when **both** have completed does the orchestrator advance to `risk_assessment`.

```
entity-resolution completes
  ├── enqueue ownership-ubo
  └── enqueue screening
       ...
ownership-ubo completes → check: screening done? No → wait
       ...
screening completes → check: ownership-ubo done? Yes → advance to risk_assessment
```

### Restart Recovery

On startup, `resumeInProgressCases()` queries for cases in agent states, checks which agents already completed via `agent_results`, and re-enqueues any that haven't reported completion. This makes the orchestrator crash-safe.

## Acceptance Criteria

- [ ] State machine with all 12 states defined
- [ ] Workflow definition with agent dependencies
- [ ] `startCase()` transitions from CREATED and enqueues entity-resolution
- [ ] `onAgentCompleted()` advances state when all agents for current state are done
- [ ] Parallel execution: ownership and screening run concurrently after entity resolution
- [ ] Risk assessment waits for entity resolution + ownership + screening
- [ ] State transitions emit events to `decision_events` and WebSocket
- [ ] `manualTransition()` validates allowed transitions, records userId and reason
- [ ] Agent failure transitions case to ERROR state
- [ ] `resumeInProgressCases()` re-enqueues incomplete agents after restart
- [ ] State transitions use pessimistic locking (no race conditions)
- [ ] Invalid manual transitions throw `INVALID_TRANSITION` error

## Dependencies

- **Depends on**: #21 (Base Agent), #22 (Decision fragments), #25 (Event store), #3 (Database — `cases`, `agent_results`), #4 (Backend scaffold)
- **Blocks**: #24 (Agent Worker — worker calls orchestrator on completion), #27-#28 (Entity Resolution Agent)

## Testing Strategy

1. **Start case**: Create case, call `startCase()`, verify state is `entity_resolution` and job enqueued
2. **Entity resolution completes**: Call `onAgentCompleted`, verify state advances and parallel jobs enqueued
3. **Parallel completion (first)**: One parallel agent completes — verify state does NOT advance yet
4. **Parallel completion (both)**: Both parallel agents complete — verify state advances to `risk_assessment`
5. **Full pipeline**: Simulate all agents completing in order — verify case reaches `pending_human_review`
6. **Agent failure**: Agent reports `failed` — verify case transitions to `error`
7. **Manual approve**: From `pending_human_review`, call `manualTransition('approved')` — verify transition
8. **Invalid transition**: Try to transition from `approved` to `created` — verify error
9. **Restart recovery**: Set case to `entity_resolution`, no agent result — verify `resumeInProgressCases` re-enqueues
10. **Concurrent transitions**: Two agents complete simultaneously — verify no race condition (pessimistic lock)
11. **Event emission**: Verify `state_change` events in `decision_events` for each transition
12. **WebSocket events**: Verify `case:state_changed` and `case:agent_started` emitted
