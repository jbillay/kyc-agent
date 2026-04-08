# EPIC: Agent Framework Core

> GitHub Issue: [#20](https://github.com/jbillay/kyc-agent/issues/20)
> Milestone: Phase 1 — Foundation
> Labels: `epic`, `agent`

## Overview

The custom agent framework that powers all KYC automation. Specialized agents handle specific tasks (entity resolution, screening, ownership tracing, etc.), coordinated by an orchestrator that manages the case state machine. Every agent action produces Decision Fragments — atomic, auditable units that link decisions to evidence and LLM reasoning. Agent jobs run as BullMQ background tasks for scalability.

This layer sits between the Data Integration Layer (Layer 2) and Core Services (Layer 4). Agents consume data through provider interfaces and produce decision fragments that drive the case forward.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #21 | Base agent class with step execution lifecycle | L | Critical | `base-agent/` |
| #22 | Decision fragment store and model | M | Critical | `decision-fragments/` |
| #23 | Case orchestrator with state machine | L | Critical | `orchestrator/` |
| #24 | BullMQ agent worker for job processing | M | Critical | `agent-worker/` |
| #25 | Event store service for immutable audit logging | M | Critical | `event-store/` |

## Dependency Map

```
#22 Decision Fragment Store ────────────────────────┐
    (fragment model, CRUD, event logging)            │
    │                                                │
    ▼                                                │
#25 Event Store ─────────────────────────────────────┤
    (append-only audit log)                          │
    │                                                │
    ▼                                                │
#21 Base Agent ──────────────────────────────────────┤
    (step lifecycle, fragment production,             │
     LLM + data source integration)                  │
    │                                                │
    ▼                                                │
#23 Orchestrator ────────────────────────────────────┤
    (state machine, dependency resolution,            │
     parallel execution)                              │
    │                                                │
    ▼                                                │
#24 Agent Worker                                     │
    (BullMQ consumer, job dispatch,                  │
     result storage, progress events)                │

Recommended implementation order:
  1. #22 Decision Fragment Store (core data model)
  2. #25 Event Store (audit infrastructure)
  3. #21 Base Agent (depends on #22, #25)
  4. #23 Orchestrator (depends on #21)
  5. #24 Agent Worker (depends on #21, #23)
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 5.1 — Agent Architecture Overview (team model)
- Section 5.2 — Base Agent Interface (`AgentContext`, `AgentStep`, `AgentResult`)
- Section 5.3 — Decision Fragment Model (types, evidence, status lifecycle)
- Section 5.4 — Specialized Agents (Entity Resolution, Ownership, Screening, etc.)
- Section 5.5 — Orchestrator (state machine, `WORKFLOW` definition, `AgentJob` payload)

## File Layout

```
backend/src/agents/
├── base-agent.js           # BaseAgent class with step lifecycle
├── decision-fragment.js    # Fragment types, model, CRUD service
├── orchestrator.js         # State machine, dependency resolution
└── agent-registry.js       # Maps agentType → agent class (for worker)

backend/src/services/
├── event-store.js          # Append-only event store service
└── case-management.js      # Case lifecycle (used by orchestrator)

backend/src/workers/
└── agent-worker.js         # BullMQ consumer, job dispatch
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sequential steps within agent | Ordered step execution | Each step may depend on previous step output; enables granular audit trail |
| Parallel agents across pipeline | BullMQ job dependencies | Ownership and screening are independent; running in parallel halves latency |
| Decision Fragments as core unit | Atomic, typed, with evidence | Regulatory requirement: every decision must be traceable to data and reasoning |
| Append-only event store | PostgreSQL rules prevent UPDATE/DELETE | Immutability guarantees for regulators; reconstruction from event stream |
| BullMQ for job processing | Redis-backed queue with priorities | Scalable via worker replicas; built-in retry, backoff, dead letter queue |
| Error per step, not per agent | Step-level error handling | A failed step doesn't necessarily invalidate the entire agent run |

## Agent Pipeline (State Machine)

```
CREATED
  │
  ▼
ENTITY_RESOLUTION ─────────────── entity-resolution agent
  │
  ├──► OWNERSHIP_MAPPING ──────── ownership-ubo agent    ┐
  │                                                       ├── parallel
  └──► SCREENING ──────────────── screening agent         ┘
         │
         ▼
RISK_ASSESSMENT ───────────────── risk-assessment agent
  │
  ▼
QA_OR_REVIEW ──────────────────── qa agent (low risk)
  │
  ├──► APPROVED
  ├──► PENDING_HUMAN_REVIEW
  ├──► REJECTED
  ├──► ESCALATED
  └──► ADDITIONAL_INFO_REQUIRED
```

## Definition of Done

- [ ] `BaseAgent` class handles full step lifecycle with error handling, retries, and progress events
- [ ] `DecisionFragment` model supports all fragment types with typed evidence and status tracking
- [ ] Fragments stored in both `decision_fragments` (queryable) and `decision_events` (append-only)
- [ ] Orchestrator state machine manages all state transitions with dependency resolution
- [ ] Parallel agent execution works (ownership + screening run concurrently)
- [ ] BullMQ worker processes agent jobs with configurable concurrency and retry
- [ ] Event store provides immutable, append-only audit trail with sequential ordering
- [ ] All state transitions emit events for WebSocket and audit trail
- [ ] A mock agent can be executed end-to-end: create case → orchestrate → produce fragments → store results
