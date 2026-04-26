# BullMQ Agent Worker for Job Processing

> GitHub Issue: [#24](https://github.com/jbillay/kyc-agent/issues/24)
> Epic: Agent Framework Core (#20)
> Size: M (1-3 days) | Priority: Critical

## Context

Agent jobs run as background tasks processed by BullMQ workers. When the orchestrator enqueues a job (e.g., "run entity-resolution for case X"), the worker picks it up, instantiates the correct agent, executes it, stores results, and notifies the orchestrator. Workers are horizontally scalable via Docker Compose replicas (default: 2).

## Requirements

### Functional

1. BullMQ queue named `agent-jobs` configured with Redis connection
2. Worker picks up jobs, instantiates the correct agent, calls `agent.execute(context)`
3. Stores results in `agent_results` table
4. Notifies orchestrator of completion
5. Emits WebSocket events for progress
6. Job priority support (higher priority for escalated cases)
7. Configurable concurrency (default: 2 concurrent jobs per worker)
8. Failed job retry with exponential backoff (max 3 attempts)
9. Dead letter queue for permanently failed jobs

### Non-Functional

- Workers are stateless and can be scaled horizontally
- Job processing is idempotent (re-processing a job produces the same result)
- Graceful shutdown: finish current job before exiting

## Technical Design

### File: `backend/src/workers/agent-worker.js`

```javascript
const { Worker, Queue } = require('bullmq');
const { pool } = require('../db/connection');

// Agent registry — maps agentType to class
const agentRegistry = new Map();

/**
 * Register an agent class for a given type.
 *
 * @param {string} agentType
 * @param {typeof import('../agents/base-agent').BaseAgent} AgentClass
 */
function registerAgent(agentType, AgentClass) {
  agentRegistry.set(agentType, AgentClass);
}

/**
 * Create and start the agent worker.
 *
 * @param {Object} config
 * @param {Object} config.redis - Redis connection options { host, port }
 * @param {number} [config.concurrency=2]
 * @param {import('../agents/orchestrator').Orchestrator} config.orchestrator
 * @param {Function} [config.emitSocketEvent]
 * @returns {Worker}
 */
function createAgentWorker(config) {
  const { redis, concurrency = 2, orchestrator, emitSocketEvent } = config;

  const worker = new Worker(
    'agent-jobs',
    async (job) => {
      const { caseId, agentType, context } = job.data;

      console.log(`[agent-worker] Processing ${agentType} for case ${caseId}`);

      // Instantiate the agent
      const AgentClass = agentRegistry.get(agentType);
      if (!AgentClass) {
        throw new Error(`Unknown agent type: ${agentType}`);
      }

      const agent = new AgentClass();

      // Wire up progress reporting → WebSocket + BullMQ progress
      agent.onProgress = (event, data) => {
        job.updateProgress({ event, ...data });
        if (emitSocketEvent) {
          emitSocketEvent(`case:agent_step_completed`, {
            caseId,
            agentType,
            ...data,
          });
        }
      };

      // Execute the agent
      const result = await agent.execute(context);

      // Store result in agent_results table
      await storeAgentResult(caseId, agentType, result);

      // Notify orchestrator
      await orchestrator.onAgentCompleted(caseId, agentType, result.status);

      // Emit completion event
      if (emitSocketEvent) {
        emitSocketEvent('case:agent_completed', {
          caseId,
          agentType,
          status: result.status,
          confidence: result.confidence,
          fragmentCount: result.decisionFragments.length,
          timestamp: new Date().toISOString(),
        });
      }

      return {
        status: result.status,
        confidence: result.confidence,
        fragmentCount: result.decisionFragments.length,
      };
    },
    {
      connection: redis,
      concurrency,
      limiter: {
        max: 10,
        duration: 60000, // Max 10 jobs per minute per worker (safety valve)
      },
    }
  );

  // ─── Event Handlers ────────────────────────────────

  worker.on('completed', (job, returnValue) => {
    console.log(
      `[agent-worker] Completed ${job.data.agentType} for case ${job.data.caseId}:`,
      returnValue
    );
  });

  worker.on('failed', (job, err) => {
    console.error(
      `[agent-worker] Failed ${job?.data?.agentType} for case ${job?.data?.caseId}:`,
      err.message
    );
  });

  worker.on('error', (err) => {
    console.error('[agent-worker] Worker error:', err.message);
  });

  return worker;
}

/**
 * Store an agent result in the database.
 *
 * @param {string} caseId
 * @param {string} agentType
 * @param {import('../agents/base-agent').AgentResult} result
 */
async function storeAgentResult(caseId, agentType, result) {
  await pool.query(
    `INSERT INTO agent_results
       (id, case_id, agent_type, status, output, confidence,
        started_at, completed_at, total_llm_calls, total_latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (case_id, agent_type)
     DO UPDATE SET
       status = EXCLUDED.status,
       output = EXCLUDED.output,
       confidence = EXCLUDED.confidence,
       completed_at = EXCLUDED.completed_at,
       total_llm_calls = EXCLUDED.total_llm_calls,
       total_latency_ms = EXCLUDED.total_latency_ms`,
    [
      result.agentId, caseId, agentType, result.status,
      JSON.stringify(result.output), result.confidence,
      result.startedAt, result.completedAt,
      result.totalLLMCalls, result.totalLatencyMs,
    ]
  );
}

/**
 * Create the BullMQ queue (used by orchestrator to add jobs).
 *
 * @param {Object} redis - Redis connection options
 * @returns {Queue}
 */
function createAgentQueue(redis) {
  return new Queue('agent-jobs', {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  });
}

/**
 * Graceful shutdown — wait for current jobs to finish.
 *
 * @param {Worker} worker
 * @param {number} [timeoutMs=30000]
 */
async function shutdownWorker(worker, timeoutMs = 30000) {
  console.log('[agent-worker] Shutting down gracefully...');
  await worker.close(false); // false = don't force
  // BullMQ's close() waits for in-progress jobs by default
}

module.exports = {
  registerAgent,
  createAgentWorker,
  createAgentQueue,
  storeAgentResult,
  shutdownWorker,
};
```

### File: `backend/src/agents/agent-registry.js`

```javascript
const { registerAgent } = require('../workers/agent-worker');

/**
 * Register all available agents.
 * Called at worker startup.
 */
function registerAllAgents() {
  // Phase 1
  // const { EntityResolutionAgent } = require('./entity-resolution');
  // registerAgent('entity-resolution', EntityResolutionAgent);

  // Phase 2
  // const { OwnershipUBOAgent } = require('./ownership-ubo');
  // registerAgent('ownership-ubo', OwnershipUBOAgent);
  // const { ScreeningAgent } = require('./screening');
  // registerAgent('screening', ScreeningAgent);
  // const { RiskAssessmentAgent } = require('./risk-assessment');
  // registerAgent('risk-assessment', RiskAssessmentAgent);

  // Phase 3
  // const { QAAgent } = require('./qa-agent');
  // registerAgent('qa-agent', QAAgent);
}

module.exports = { registerAllAgents };
```

### Job Payload

```javascript
{
  type: 'agent-execution',
  caseId: 'uuid',
  agentType: 'entity-resolution',
  context: {
    caseId: 'uuid',
    entityName: 'Barclays Bank PLC',
    jurisdiction: 'GB',
    existingData: { /* outputs from previous agents */ },
    config: { /* client-specific overrides */ }
  }
}
```

### Job Processing Flow

```
Redis Queue (agent-jobs)
  │
  ▼
Worker picks up job
  │
  ├── Look up AgentClass from registry
  │
  ├── Instantiate agent, wire onProgress callback
  │
  ├── Call agent.execute(context)
  │     ├── Steps execute sequentially
  │     ├── Progress events → WebSocket + BullMQ progress
  │     └── Returns AgentResult
  │
  ├── Store result in agent_results table
  │
  ├── Notify orchestrator.onAgentCompleted()
  │
  └── Emit case:agent_completed WebSocket event
```

### BullMQ Configuration

| Setting | Value | Rationale |
|---------|-------|-----------|
| Queue name | `agent-jobs` | Single queue for all agent types |
| Concurrency | 2 per worker | Balance throughput vs resource usage |
| Max attempts | 3 | Retry transient failures |
| Backoff | Exponential, 5s base | Avoid hammering on failure |
| Remove on complete | Keep last 1000 | Audit trail, but don't fill Redis |
| Remove on fail | Keep last 5000 | Debugging failed jobs |
| Rate limit | 10 jobs/min/worker | Safety valve against runaway |

### Docker Compose Scaling

```yaml
agent-worker:
  build: ./backend
  command: node src/workers/agent-worker.js
  deploy:
    replicas: 2
  depends_on:
    - redis
    - postgres
```

## Acceptance Criteria

- [ ] BullMQ queue `agent-jobs` configured with Redis connection
- [ ] Worker instantiates correct agent based on `agentType` from registry
- [ ] Worker calls `agent.execute(context)` and stores results in `agent_results`
- [ ] Worker notifies orchestrator on completion
- [ ] WebSocket events emitted: `case:agent_step_completed`, `case:agent_completed`
- [ ] Job priority support (higher priority jobs processed first)
- [ ] Configurable concurrency (default 2)
- [ ] Failed jobs retried with exponential backoff (max 3 attempts)
- [ ] Dead letter behavior: permanently failed jobs retained in Redis
- [ ] Unknown agent type throws error
- [ ] Graceful shutdown: finishes current job before exiting
- [ ] `storeAgentResult` upserts (handles re-runs)

## Dependencies

- **Depends on**: #21 (Base Agent), #23 (Orchestrator), #3 (Database — `agent_results` table), #2 (Docker Compose — Redis service)
- **Blocks**: #27-#28 (Entity Resolution Agent — first agent to be processed by worker)

## Testing Strategy

1. **Job processing**: Enqueue a job with a mock agent, verify agent executed and result stored
2. **Agent registry**: Register mock agent, enqueue job — verify correct class instantiated
3. **Unknown agent**: Enqueue job with unregistered agent type — verify error thrown
4. **Result storage**: Verify `agent_results` row created with correct fields
5. **Orchestrator notification**: Verify `onAgentCompleted` called with correct status
6. **Progress events**: Verify `onProgress` callback produces WebSocket events
7. **Retry on failure**: Agent throws error — verify job retried
8. **Permanent failure**: Agent fails 3 times — verify job in failed state
9. **Priority**: Enqueue low and high priority jobs — verify high priority processed first
10. **Concurrent processing**: Enqueue 4 jobs with concurrency=2 — verify 2 run at a time
11. **Graceful shutdown**: Call `shutdownWorker` while job is running — verify job completes before exit
12. **Upsert**: Run same agent twice for same case — verify result updated, not duplicated
