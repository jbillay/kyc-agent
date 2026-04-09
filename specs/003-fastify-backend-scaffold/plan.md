# Implementation Plan: Fastify Backend Scaffold

**Branch**: `003-fastify-backend-scaffold` | **Date**: 2026-04-09 | **Spec**: [spec.md](spec.md)  
**Input**: Feature specification from `/specs/003-fastify-backend-scaffold/spec.md`

## Summary

Update and complete the existing `backend/` directory to match the architecture specification: upgrade Fastify to v5, wire CORS and structured error handling, implement a spec-compliant health endpoint at `/api/v1/admin/system/health`, add graceful shutdown with a 10-second force-exit drain window, create the full directory skeleton with stub files, align `package.json` with all required dependencies, add `jsconfig.json` and `.dockerignore`, and deliver a minimal Jest test suite covering the health endpoint and error envelope.

> **Context**: The `backend/` directory already exists from epic-01 feature 002 (postgres schema). The plan updates it — it does not start from scratch.

---

## Technical Context

**Language/Version**: Node.js 22, JavaScript (CommonJS — `require`/`module.exports`)  
**Primary Dependencies**: Fastify 5.x, @fastify/cors 10.x, @fastify/multipart 9.x, @fastify/websocket 11.x, pino 9.x, dotenv 16.x, jest 29.x  
**Storage**: PostgreSQL 16 — `db/connection.js` stub only (no live DB calls in scaffold)  
**Testing**: Jest 29 — `app.inject()` pattern, no port binding  
**Target Platform**: Linux/Alpine container (Docker), Node.js 22 on host for dev  
**Project Type**: Web service (REST API + WebSocket server, Layer 5 per architecture)  
**Performance Goals**: Health endpoint < 50 ms; server ready < 3 s from process launch  
**Constraints**: CommonJS only; no transpile step; force-exit after 10 s drain; stack trace suppressed in non-development  
**Scale/Scope**: Single server process; 2 agent worker replicas out of scope for this feature

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applicable | Status | Notes |
|-----------|-----------|--------|-------|
| I — Auditability First | No | N/A | Scaffold introduces no agents, decision fragments, or event store interactions |
| II — LLM-Agnostic Interface | No | N/A | No LLM calls; `src/llm/` is stubbed only |
| III — Strict Layered Architecture | Yes | **PASS** | `src/index.js` is Layer 5 (API entry point); all stub directories are placed in their correct layer; no cross-layer imports |
| IV — Data Sovereignty | Yes | **PASS** | Dockerfile produces a self-contained image; no external service calls at startup in this scaffold |
| V — Config-Driven Compliance Logic | No | N/A | No compliance or risk logic introduced |

**Post-Phase 1 re-check**: No design decisions introduced violations. Constitution Check confirmed PASS.

---

## Project Structure

### Documentation (this feature)

```text
specs/003-fastify-backend-scaffold/
├── plan.md              ← this file
├── research.md          ← Phase 0 output
├── data-model.md        ← Phase 1 output
├── quickstart.md        ← Phase 1 output
├── contracts/
│   └── http-api.md      ← Phase 1 output
├── checklists/
│   └── requirements.md
└── tasks.md             ← Phase 2 output (/speckit.tasks — not created here)
```

### Source Code — changes to `backend/`

```text
backend/
├── package.json              UPDATE — upgrade deps, add jest/dotenv/missing packages
├── jsconfig.json             CREATE
├── Dockerfile                CREATE
├── .dockerignore             CREATE
├── db/
│   ├── connection.js         EXISTS — keep (stub from feature 002)
│   ├── seed.js               EXISTS — keep
│   └── migrations/           EXISTS — keep
└── src/
    ├── index.js              REWRITE — buildServer factory, CORS, error handler,
    │                                   env-configurable port, graceful shutdown
    ├── api/
    │   ├── admin.js          CREATE — stub
    │   ├── auth.js           CREATE — stub
    │   ├── cases.js          CREATE — stub
    │   ├── config.js         CREATE — stub
    │   ├── review.js         CREATE — stub
    │   ├── websocket.js      CREATE — stub
    │   └── routes/
    │       └── health.js     UPDATE — correct path, add timestamp + uptime
    ├── llm/
    │   ├── types.js          CREATE — stub
    │   ├── llm-service.js    CREATE — stub
    │   ├── providers/
    │   │   ├── ollama.js     CREATE — stub
    │   │   ├── vllm.js       CREATE — stub
    │   │   ├── openai-compatible.js  CREATE — stub
    │   │   ├── anthropic.js  CREATE — stub
    │   │   └── openai.js     CREATE — stub
    │   └── prompt-adapters/
    │       ├── mistral.js    CREATE — stub
    │       ├── llama.js      CREATE — stub
    │       └── default.js    CREATE — stub
    ├── data-sources/
    │   ├── types.js          CREATE — stub
    │   ├── cache.js          CREATE — stub
    │   ├── registry/
    │   │   ├── types.js      CREATE — stub
    │   │   ├── companies-house.js   CREATE — stub
    │   │   └── sec-edgar.js  CREATE — stub
    │   ├── screening/
    │   │   ├── types.js      CREATE — stub
    │   │   ├── ofac.js       CREATE — stub
    │   │   ├── uk-hmt.js     CREATE — stub
    │   │   ├── un-consolidated.js   CREATE — stub
    │   │   └── fuzzy-matcher.js     CREATE — stub
    │   └── media/
    │       ├── types.js      CREATE — stub
    │       └── news-search.js       CREATE — stub
    ├── agents/
    │   ├── types.js          CREATE — stub
    │   ├── base-agent.js     CREATE — stub
    │   ├── orchestrator.js   CREATE — stub
    │   ├── decision-fragment.js     CREATE — stub
    │   ├── entity-resolution/
    │   │   ├── agent.js      CREATE — stub
    │   │   └── prompts.js    CREATE — stub
    │   ├── ownership-ubo/
    │   │   ├── agent.js      CREATE — stub
    │   │   └── prompts.js    CREATE — stub
    │   ├── screening/
    │   │   ├── agent.js      CREATE — stub
    │   │   └── prompts.js    CREATE — stub
    │   ├── document-analysis/
    │   │   ├── agent.js      CREATE — stub
    │   │   └── prompts.js    CREATE — stub
    │   ├── risk-assessment/
    │   │   ├── agent.js      CREATE — stub
    │   │   └── prompts.js    CREATE — stub
    │   └── qa/
    │       ├── agent.js      CREATE — stub
    │       └── prompts.js    CREATE — stub
    ├── services/
    │   ├── case-management.js       CREATE — stub
    │   ├── document-service.js      CREATE — stub
    │   ├── rule-engine.js           CREATE — stub
    │   ├── event-store.js           CREATE — stub
    │   └── auth-service.js          CREATE — stub
    └── workers/
        ├── agent-worker.js   EXISTS — keep (stub from prior work)
        └── screening-sync.js EXISTS — keep (stub from prior work)

tests/
└── backend/
    └── scaffold.test.js      CREATE — health check + error envelope Jest tests
```

**Structure Decision**: Option 2 (Web application layout). `backend/` is the server. Tests live in `tests/backend/` at repo root to keep them separate from production source — consistent with the Jest config that will be added to `package.json`.

---

## Implementation Notes

### `backend/package.json` — key changes

- `fastify`: `^4.0.0` → `^5.0.0`
- `@fastify/cors`: `^9.0.0` → `^10.0.0`
- `@fastify/websocket`: `^8.0.0` → `^11.0.0`
- Add `@fastify/multipart`: `^9.0.0`
- Add `socket.io`: `^4.8.0`
- Add `dotenv`: `^16.4.0`
- Add `js-yaml`: `^4.1.0`
- `node-pg-migrate`: `^6.0.0` → `^7.0.0`
- `pino`: `^8.0.0` → `^9.0.0`
- `minio`: `^7.0.0` → `^8.0.0`
- `dev` script: `nodemon src/index.js` → `node --watch src/index.js`
- Add `test` and `test:watch` scripts using jest
- devDependencies: replace `nodemon` with `jest ^29.7.0`

### `backend/src/index.js` — complete rewrite

Key behaviours:
1. `require('dotenv').config()` at top
2. `buildServer()` async factory — registers CORS, error handler, health route; returns app
3. Error handler: extracts `statusCode`, `code`, `message`; conditionally includes `stack`
4. `start()` calls `buildServer()`, then `app.listen({ port, host })`
5. Graceful shutdown: 10-second `setTimeout` with `.unref()` for force-exit; `app.close()` then `process.exit(0)`
6. `if (require.main === module) start();` guard
7. `module.exports = { buildServer };`

### `backend/src/api/routes/health.js` — path correction

- Route path: `/health` → `/api/v1/admin/system/health`
- Response body: add `timestamp` (ISO 8601) and `uptime` (process.uptime())
- JSON Schema response updated to reflect new shape

### Jest test file: `tests/backend/scaffold.test.js`

Two test groups:
1. **Health check**: `GET /api/v1/admin/system/health` → 200, body has `status: 'ok'`, `timestamp` (string), `uptime` (number)
2. **Error envelope**: request to a non-existent route → 404, body has `error.code` and `error.message`

---

## Complexity Tracking

> No Constitution violations to justify.

---
