# Base Agent Class with Step Execution Lifecycle

> GitHub Issue: [#21](https://github.com/jbillay/kyc-agent/issues/21)
> Epic: Agent Framework Core (#20)
> Size: L (3-5 days) | Priority: Critical

## Context

Every specialized agent (Entity Resolution, Screening, Ownership, etc.) shares a common lifecycle: initialize, execute steps sequentially, produce decision fragments, handle errors per step, and compile results. The `BaseAgent` class encapsulates this lifecycle so that subclasses only implement step-specific logic. Each step is a discrete unit producing its own decision fragments and LLM calls, enabling granular audit trails.

## Requirements

### Functional

1. `BaseAgent` class with `execute(context)` that runs the full lifecycle
2. Abstract `executeStep(stepName, context, previousSteps)` for subclasses
3. Step lifecycle: initialize → execute each step sequentially → compile results
4. Each step produces `AgentStep` with: stepId, name, status, timing, decision fragments, LLM calls
5. Error handling per step: catch errors, log them, mark step as failed, decide whether to continue or abort
6. Retry logic: configurable max retries per step with backoff
7. Progress reporting: emit events when steps start/complete
8. Timeout handling: configurable per-step and per-agent timeouts
9. Final `AgentResult` includes: all steps, all fragments, overall confidence, timing

### Non-Functional

- Agents are stateless between executions (all state in `AgentContext` and database)
- Step execution is deterministic given the same context and external data
- Memory-efficient: no unbounded accumulation during long agent runs

## Technical Design

### File: `backend/src/agents/base-agent.js`

```javascript
const crypto = require('crypto');
const { createFragment } = require('./decision-fragment');
const { appendEvent } = require('../services/event-store');

/**
 * @typedef {Object} AgentContext
 * @property {string} caseId
 * @property {string} entityName
 * @property {string} jurisdiction
 * @property {Object} existingData - Data from previous agents
 * @property {Object} config - Client-specific configuration
 */

/**
 * @typedef {Object} AgentStep
 * @property {string} stepId - UUID
 * @property {string} name
 * @property {string} description
 * @property {'pending'|'running'|'completed'|'failed'|'skipped'} status
 * @property {string} [startedAt] - ISO 8601
 * @property {string} [completedAt] - ISO 8601
 * @property {import('./decision-fragment').DecisionFragment[]} decisionFragments
 * @property {Object[]} llmCalls - References to LLM call logs
 * @property {string} [error] - Error message if step failed
 * @property {number} [retryCount]
 */

/**
 * @typedef {Object} AgentResult
 * @property {string} agentId - Unique run ID
 * @property {string} agentType
 * @property {string} caseId
 * @property {'completed'|'failed'|'partial'} status
 * @property {AgentStep[]} steps
 * @property {Object} output - Structured output for downstream agents
 * @property {import('./decision-fragment').DecisionFragment[]} decisionFragments
 * @property {number} confidence - 0-100 overall confidence
 * @property {string} startedAt
 * @property {string} completedAt
 * @property {number} totalLLMCalls
 * @property {number} totalLatencyMs
 */

/**
 * @typedef {Object} AgentConfig
 * @property {number} [maxRetries=2] - Max retries per step
 * @property {number} [retryBackoffMs=1000] - Base backoff between retries
 * @property {number} [stepTimeoutMs=120000] - Per-step timeout (2 min)
 * @property {number} [agentTimeoutMs=600000] - Total agent timeout (10 min)
 * @property {boolean} [continueOnStepFailure=false] - Continue to next step if one fails
 */

/**
 * Base Agent class — all specialized agents extend this.
 *
 * Lifecycle:
 *   1. Initialize agent run (generate agentId, record start time)
 *   2. Execute each step sequentially
 *   3. For each step:
 *      a. Emit 'step:started' event
 *      b. Call subclass executeStep()
 *      c. Handle errors with retry logic
 *      d. Emit 'step:completed' or 'step:failed' event
 *   4. Compile and return AgentResult
 */
class BaseAgent {
  /**
   * @param {string} agentType - e.g., 'entity-resolution', 'screening'
   * @param {string[]} stepNames - Ordered list of step names
   * @param {AgentConfig} [agentConfig]
   */
  constructor(agentType, stepNames, agentConfig = {}) {
    this.agentType = agentType;
    this.stepNames = stepNames;
    this.config = {
      maxRetries: 2,
      retryBackoffMs: 1000,
      stepTimeoutMs: 120000,
      agentTimeoutMs: 600000,
      continueOnStepFailure: false,
      ...agentConfig,
    };

    /** @type {Function|null} - Set by worker to receive progress events */
    this.onProgress = null;
  }

  /**
   * Execute the full agent lifecycle.
   *
   * @param {AgentContext} context
   * @returns {Promise<AgentResult>}
   */
  async execute(context) {
    const agentId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const completedSteps = [];
    const allFragments = [];
    let totalLLMCalls = 0;
    let status = 'completed';

    const agentTimeout = this._createTimeout(this.config.agentTimeoutMs, 'Agent timeout exceeded');

    try {
      for (const stepName of this.stepNames) {
        const step = await this._runStep(stepName, context, completedSteps, agentId);
        completedSteps.push(step);

        if (step.decisionFragments) {
          allFragments.push(...step.decisionFragments);
        }
        totalLLMCalls += (step.llmCalls || []).length;

        if (step.status === 'failed' && !this.config.continueOnStepFailure) {
          status = 'partial';
          break;
        }
      }

      // Check if all steps completed successfully
      const allCompleted = completedSteps.every((s) => s.status === 'completed');
      if (!allCompleted && status !== 'partial') {
        status = 'partial';
      }
    } catch (err) {
      status = 'failed';
      // Log the agent-level error
      await this._emitEvent(context.caseId, agentId, null, 'agent_error', {
        error: err.message,
      });
    } finally {
      agentTimeout.clear();
    }

    const completedAt = new Date().toISOString();
    const output = await this.compileOutput(context, completedSteps, allFragments);
    const confidence = this._calculateConfidence(allFragments);

    const result = {
      agentId,
      agentType: this.agentType,
      caseId: context.caseId,
      status,
      steps: completedSteps,
      output,
      decisionFragments: allFragments,
      confidence,
      startedAt,
      completedAt,
      totalLLMCalls,
      totalLatencyMs: new Date(completedAt) - new Date(startedAt),
    };

    return result;
  }

  /**
   * Execute a single step — implemented by subclasses.
   *
   * @abstract
   * @param {string} stepName
   * @param {AgentContext} context
   * @param {AgentStep[]} previousSteps
   * @returns {Promise<AgentStep>}
   */
  async executeStep(stepName, context, previousSteps) {
    throw new Error(`executeStep not implemented for ${this.agentType}`);
  }

  /**
   * Compile the final structured output from completed steps.
   * Override in subclasses for agent-specific output shapes.
   *
   * @param {AgentContext} context
   * @param {AgentStep[]} steps
   * @param {import('./decision-fragment').DecisionFragment[]} fragments
   * @returns {Promise<Object>}
   */
  async compileOutput(context, steps, fragments) {
    return { steps: steps.map((s) => s.name), fragmentCount: fragments.length };
  }

  // ─── Internal ─────────────────────────────────────────

  /**
   * Run a single step with retry and timeout logic.
   *
   * @param {string} stepName
   * @param {AgentContext} context
   * @param {AgentStep[]} previousSteps
   * @param {string} agentId
   * @returns {Promise<AgentStep>}
   */
  async _runStep(stepName, context, previousSteps, agentId) {
    const stepId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    await this._emitEvent(context.caseId, agentId, stepId, 'step_started', {
      stepName,
    });
    this._reportProgress('step:started', { stepName, stepId });

    let lastError = null;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const stepTimeout = this._createTimeout(
          this.config.stepTimeoutMs,
          `Step '${stepName}' timeout exceeded`
        );

        try {
          const result = await Promise.race([
            this.executeStep(stepName, context, previousSteps),
            stepTimeout.promise,
          ]);

          const completedAt = new Date().toISOString();
          const step = {
            stepId,
            name: stepName,
            description: result.description || stepName,
            status: 'completed',
            startedAt,
            completedAt,
            decisionFragments: result.decisionFragments || [],
            llmCalls: result.llmCalls || [],
            retryCount: attempt,
          };

          // Persist fragments
          for (const fragment of step.decisionFragments) {
            fragment.stepId = stepId;
            fragment.caseId = context.caseId;
            fragment.agentType = this.agentType;
            await createFragment(fragment);
          }

          await this._emitEvent(context.caseId, agentId, stepId, 'step_completed', {
            stepName,
            fragmentCount: step.decisionFragments.length,
            llmCallCount: step.llmCalls.length,
          });
          this._reportProgress('step:completed', { stepName, stepId });

          return step;
        } finally {
          stepTimeout.clear();
        }
      } catch (err) {
        lastError = err;

        if (attempt < this.config.maxRetries) {
          const backoff = this.config.retryBackoffMs * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, backoff));
        }
      }
    }

    // All retries exhausted
    const completedAt = new Date().toISOString();
    const failedStep = {
      stepId,
      name: stepName,
      description: stepName,
      status: 'failed',
      startedAt,
      completedAt,
      decisionFragments: [],
      llmCalls: [],
      error: lastError?.message || 'Unknown error',
      retryCount: this.config.maxRetries,
    };

    await this._emitEvent(context.caseId, agentId, stepId, 'step_failed', {
      stepName,
      error: lastError?.message,
      retries: this.config.maxRetries,
    });
    this._reportProgress('step:failed', { stepName, stepId, error: lastError?.message });

    return failedStep;
  }

  /**
   * Calculate overall confidence from fragment confidences.
   * Uses weighted average — fragments with lower confidence pull the score down.
   *
   * @param {import('./decision-fragment').DecisionFragment[]} fragments
   * @returns {number} 0-100
   */
  _calculateConfidence(fragments) {
    if (fragments.length === 0) return 0;
    const sum = fragments.reduce((acc, f) => acc + (f.confidence || 0), 0);
    return Math.round(sum / fragments.length);
  }

  /**
   * Create a timeout that rejects after ms.
   * @param {number} ms
   * @param {string} message
   * @returns {{ promise: Promise<never>, clear: () => void }}
   */
  _createTimeout(ms, message) {
    let timer;
    const promise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return { promise, clear: () => clearTimeout(timer) };
  }

  /**
   * Emit an event to the event store.
   */
  async _emitEvent(caseId, agentId, stepId, eventType, data) {
    try {
      await appendEvent(caseId, this.agentType, stepId, eventType, {
        agentId,
        ...data,
      });
    } catch (err) {
      // Fail-open: don't crash agent because event store failed
      console.error(`Failed to emit event ${eventType}:`, err.message);
    }
  }

  /**
   * Report progress to the worker (for WebSocket forwarding).
   * @param {string} event
   * @param {Object} data
   */
  _reportProgress(event, data) {
    if (typeof this.onProgress === 'function') {
      this.onProgress(event, { agentType: this.agentType, ...data });
    }
  }
}

module.exports = { BaseAgent };
```

### Step Return Shape

`executeStep()` must return an object with:

```javascript
{
  description: 'Human-readable step description',
  decisionFragments: [/* DecisionFragment objects */],
  llmCalls: [/* LLM call log references */],
}
```

### Agent Lifecycle

```
execute(context)
  │
  ├── Generate agentId, record startedAt
  │
  ├── For each stepName in this.stepNames:
  │     │
  │     ├── Emit 'step_started' event
  │     │
  │     ├── Call this.executeStep(stepName, context, previousSteps)
  │     │     ├── Success → persist fragments, emit 'step_completed'
  │     │     └── Failure → retry with backoff → if exhausted, emit 'step_failed'
  │     │
  │     ├── If failed and !continueOnStepFailure → break
  │     │
  │     └── Accumulate step, fragments, LLM call count
  │
  ├── Call this.compileOutput(context, steps, fragments)
  │
  └── Return AgentResult
```

### Error Handling Strategy

| Scenario | Behavior |
|----------|----------|
| Step throws error | Retry up to `maxRetries` with exponential backoff |
| All retries exhausted | Mark step as `failed`; if `continueOnStepFailure`, continue; else stop |
| Agent timeout | Abort current step, mark agent as `failed` |
| Step timeout | Abort current attempt, count as retry |
| Event store failure | Fail-open — log error, continue execution |
| Fragment store failure | Propagate error (data integrity is critical) |

## Acceptance Criteria

- [ ] `BaseAgent` class with `execute(context)` running the full lifecycle
- [ ] `executeStep(stepName, context, previousSteps)` abstract method for subclasses
- [ ] Each step produces `AgentStep` with stepId, name, status, timing, fragments, LLM calls
- [ ] Step-level error handling: catch, log, mark as failed, decide continue or abort
- [ ] Retry logic: configurable `maxRetries` with exponential backoff
- [ ] Progress events emitted on step start/complete/fail
- [ ] Per-step and per-agent timeout handling
- [ ] `AgentResult` includes all steps, all fragments, overall confidence, timing
- [ ] Confidence calculated as weighted average of fragment confidences
- [ ] Decision fragments persisted via `createFragment`
- [ ] Events emitted to event store (fail-open)
- [ ] Unit tests with a mock agent implementation

## Dependencies

- **Depends on**: #22 (Decision fragment store), #25 (Event store service), #4 (Backend scaffold)
- **Blocks**: #27-#28 (Entity Resolution Agent), #23 (Orchestrator needs agent instances)

## Testing Strategy

1. **Happy path**: Mock agent with 3 steps, all succeed — verify `AgentResult` status is `completed`
2. **Step failure**: Mock agent where step 2 throws — verify step marked `failed`, agent stops
3. **Continue on failure**: Set `continueOnStepFailure: true`, step 2 fails — verify step 3 still runs
4. **Retry success**: Step fails on attempt 1, succeeds on attempt 2 — verify `retryCount: 1`
5. **Retry exhaustion**: Step fails all retries — verify step status `failed`, error message set
6. **Timeout**: Step takes longer than `stepTimeoutMs` — verify timeout error
7. **Agent timeout**: Total execution exceeds `agentTimeoutMs` — verify agent aborted
8. **Fragment persistence**: Verify `createFragment` called for each fragment from each step
9. **Event emission**: Verify `step_started`, `step_completed`, `step_failed` events emitted
10. **Confidence calculation**: Verify average of fragment confidences
11. **Progress callback**: Set `onProgress`, verify callbacks received
12. **Empty agent**: Agent with zero steps — verify completes with empty result
