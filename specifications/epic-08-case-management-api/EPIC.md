# EPIC: Case Management API

> GitHub Issue: [#33](https://github.com/jbillay/kyc-agent/issues/33)
> Milestone: Phase 1 — Foundation
> Labels: `epic`, `backend`

## Overview

The Case Management API is the REST and WebSocket layer that the frontend (and any future integration) uses to interact with the KYC Agent platform. It covers the full case lifecycle: creating new cases (which triggers the orchestrator), listing and filtering cases, retrieving case details with agent outputs, querying decision fragments for audit and review, and delivering real-time progress updates via WebSocket as agents execute.

This epic focuses on the Cases API and the read-only Fragments API. The Review API (approve/reject/escalate) and Admin/Config APIs are deferred to later epics.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #34 | Cases CRUD API endpoints | L | Critical | `cases-crud/` |
| #35 | Decision fragments API endpoints | M | High | `decision-fragments-api/` |
| #36 | WebSocket real-time events for case progress | M | High | `websocket-events/` |

## Dependency Map

```
#34 Cases CRUD API ──────────────────────────────────┐
    (create, list, get, timeline, documents,          │
     rerun agent, manual state transition)            │
    │                                                 │
    ├── #35 Decision Fragments API                    │
    │   (query fragments per case, filter, paginate)  │
    │                                                 │
    └── #36 WebSocket Real-Time Events                │
        (Socket.io, Redis pub/sub, case subscriptions)│

Recommended implementation order:
  1. #34 Cases CRUD (establishes route structure, service layer, error handling)
  2. #35 Decision Fragments API (read-only, depends on case existence)
  3. #36 WebSocket Events (cross-cutting, depends on case + agent lifecycle)
```

## External Dependencies

```
Infrastructure (#1):
  ├── #3 PostgreSQL Schema     ← cases, agent_results, decision_fragments tables
  ├── #4 Fastify Backend       ← route registration, JSON Schema validation
  └── #6 MinIO Storage         ← document upload storage

Agent Framework (#20):
  ├── #22 Decision Fragments   ← fragment store queried by API
  ├── #23 Orchestrator         ← startCase() triggers agent pipeline
  ├── #24 Agent Worker         ← BullMQ job enqueuing
  └── #25 Event Store          ← timeline endpoint reads events

Data Integration (#13):
  └── #16 Data Caching         ← cache metadata in case responses

Frontend (#38):
  └── #39-#43                  ← consumes all API endpoints and WebSocket events
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 6.1 — Case Management Service (KYCCase typedef)
- Section 7.1 — API Framework (Fastify)
- Section 7.2 — API Endpoint Groups (Cases, Review, Config, Admin)
- Section 7.3 — WebSocket Events (event contracts)
- Section 7.4 — Schema Validation (JSON Schema examples)
- Section 9.1 — Database Schema (cases, agent_results, decision_fragments, decision_events)

## File Layout

```
backend/src/
├── api/
│   ├── index.js              # Route registration (prefix /api/v1)
│   ├── cases/
│   │   ├── routes.js         # Cases route definitions
│   │   ├── handlers.js       # Route handler functions
│   │   └── schemas.js        # JSON Schema definitions
│   └── fragments/
│       ├── routes.js         # Fragment route definitions
│       ├── handlers.js       # Route handler functions
│       └── schemas.js        # JSON Schema definitions
├── services/
│   └── case-management.js    # Case service (business logic)
└── websocket/
    ├── index.js              # Socket.io server setup
    ├── events.js             # Event emitter integration
    └── auth.js               # WebSocket JWT authentication
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Fastify JSON Schema validation | All request/response schemas declared | Automatic 400 errors, self-documenting API, no manual parsing |
| Service layer separation | Handlers delegate to `case-management.js` | Business logic testable without HTTP, reusable by WebSocket handlers |
| Consistent error format | `{ error: { code, message, details } }` | Predictable for frontend error handling |
| Pagination via cursor | `?cursor=id&limit=50` for list endpoints | Stable pagination under concurrent inserts (offset-based skips rows) |
| Redis pub/sub for WebSocket | Agent workers publish; API server subscribes | Multi-process: workers and API server are separate containers |
| Case-scoped WebSocket rooms | Clients join `case:{id}` room | Only receive events for cases they're viewing |

## Definition of Done

- [ ] `POST /api/v1/cases` creates case and triggers orchestrator
- [ ] `GET /api/v1/cases` lists cases with filters, pagination, and sorting
- [ ] `GET /api/v1/cases/:id` returns full case with agent results
- [ ] `GET /api/v1/cases/:id/timeline` returns chronological event stream
- [ ] `POST /api/v1/cases/:id/documents` uploads files to MinIO
- [ ] `POST /api/v1/cases/:id/rerun/:agent` re-enqueues an agent
- [ ] `PATCH /api/v1/cases/:id/state` transitions state with authorization
- [ ] `GET /api/v1/cases/:id/fragments` returns filtered, paginated fragments
- [ ] `GET /api/v1/cases/:id/fragments/:fragmentId` returns single fragment with evidence
- [ ] Socket.io server emits all 7 case event types
- [ ] WebSocket clients can subscribe to specific case rooms
- [ ] Redis pub/sub bridges agent worker events to API server
- [ ] All endpoints use JSON Schema validation
- [ ] Consistent error response format across all endpoints
