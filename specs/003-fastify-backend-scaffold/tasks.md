# Tasks: Fastify Backend Scaffold

**Input**: Design documents from `/specs/003-fastify-backend-scaffold/`  
**Prerequisites**: plan.md ✅ | spec.md ✅ | research.md ✅ | data-model.md ✅ | contracts/ ✅

**Tests**: Included — spec FR-010 explicitly requires a minimal Jest test file.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each increment.

**Context**: The `backend/` directory already exists (from epic-01 feature 002). This task list updates it — it does not start from scratch.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to
- Paths use `backend/` for server code, `tests/backend/` for Jest tests (repo root)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Align project configuration with the spec before any server code is touched. All three tasks touch different files and can run in parallel after reviewing the plan.

- [x] T001 Update `backend/package.json` — upgrade fastify to ^5.0.0, @fastify/cors to ^10.0.0, @fastify/websocket to ^11.0.0, pino to ^9.0.0, minio to ^8.0.0, node-pg-migrate to ^7.0.0; add missing dependencies: @fastify/multipart ^9.0.0, socket.io ^4.8.0, dotenv ^16.4.0, js-yaml ^4.1.0; replace devDependencies (remove nodemon, add jest ^29.7.0); update scripts: dev → `node --watch src/index.js`, add `"test": "jest"` and `"test:watch": "jest --watch"`, add `"db:seed": "node db/seed.js"`; add jest config block pointing test roots to `../../tests/backend`
- [x] T002 [P] Create `backend/jsconfig.json` — compilerOptions: checkJs true, module commonjs, target ES2022, baseUrl ".", paths: {"@db/*": ["db/*"], "@src/*": ["src/*"]}; include src/**/*.js and db/**/*.js; exclude node_modules
- [x] T003 [P] Create full directory skeleton in `backend/src/` with stub files for all missing paths per architecture spec — each stub contains exactly `'use strict';\n\n// TODO: implement\n` and nothing else. Directories and stubs to create: `src/llm/types.js`, `src/llm/llm-service.js`, `src/llm/providers/ollama.js`, `src/llm/providers/vllm.js`, `src/llm/providers/openai-compatible.js`, `src/llm/providers/anthropic.js`, `src/llm/providers/openai.js`, `src/llm/prompt-adapters/mistral.js`, `src/llm/prompt-adapters/llama.js`, `src/llm/prompt-adapters/default.js`, `src/data-sources/types.js`, `src/data-sources/cache.js`, `src/data-sources/registry/types.js`, `src/data-sources/registry/companies-house.js`, `src/data-sources/registry/sec-edgar.js`, `src/data-sources/screening/types.js`, `src/data-sources/screening/ofac.js`, `src/data-sources/screening/uk-hmt.js`, `src/data-sources/screening/un-consolidated.js`, `src/data-sources/screening/fuzzy-matcher.js`, `src/data-sources/media/types.js`, `src/data-sources/media/news-search.js`, `src/agents/types.js`, `src/agents/base-agent.js`, `src/agents/orchestrator.js`, `src/agents/decision-fragment.js`, `src/agents/entity-resolution/agent.js`, `src/agents/entity-resolution/prompts.js`, `src/agents/ownership-ubo/agent.js`, `src/agents/ownership-ubo/prompts.js`, `src/agents/screening/agent.js`, `src/agents/screening/prompts.js`, `src/agents/document-analysis/agent.js`, `src/agents/document-analysis/prompts.js`, `src/agents/risk-assessment/agent.js`, `src/agents/risk-assessment/prompts.js`, `src/agents/qa/agent.js`, `src/agents/qa/prompts.js`, `src/services/case-management.js`, `src/services/document-service.js`, `src/services/rule-engine.js`, `src/services/event-store.js`, `src/services/auth-service.js`, `src/api/admin.js`, `src/api/auth.js`, `src/api/cases.js`, `src/api/config.js`, `src/api/review.js`, `src/api/websocket.js`

**Checkpoint**: package.json updated, jsconfig.json present, full directory skeleton created — ready to implement the server core.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The `buildServer` factory in `index.js` is the enabling core for every user story. All four user stories depend on it.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T004 Rewrite `backend/src/index.js` — implement as follows: (1) `require('dotenv').config()` at top; (2) `async function buildServer()` that creates a Fastify instance with `logger: { level: process.env.LOG_LEVEL || 'info' }`; (3) registers `setErrorHandler` that extracts `error.statusCode || 500` and `error.code || 'INTERNAL_ERROR'`, returns `{ error: { code, message, ...(NODE_ENV==='development' && { stack }) } }` and calls `request.log.error(error)`; (4) defines port as `parseInt(process.env.PORT || '4000')` and host as `process.env.HOST || '0.0.0.0'`; (5) returns `app`; (6) `async function start()` that calls `buildServer()`, then `app.listen({ port, host })`, catches fatal errors; (7) graceful shutdown: `const forceExit = setTimeout(() => { app.log.warn('Drain timeout'); process.exit(1); }, 10_000).unref(); await app.close(); clearTimeout(forceExit); process.exit(0);` registered on SIGTERM and SIGINT; (8) `if (require.main === module) start();`; (9) `module.exports = { buildServer };`

**Checkpoint**: `node backend/src/index.js` starts on port 4000, logs JSON, shuts down gracefully on Ctrl+C — all user story phases can now begin.

---

## Phase 3: User Story 1 — Server Startup and Health Verification (Priority: P1) 🎯 MVP

**Goal**: Expose a compliant health endpoint at the spec-required path so operators and orchestrators can verify server liveness.

**Independent Test**: `node backend/src/index.js && curl http://localhost:4000/api/v1/admin/system/health` → 200 with `{ status: "ok", timestamp: "<ISO8601>", uptime: <number> }`.

- [x] T005 [US1] Update `backend/src/api/routes/health.js` — change route path from `/health` to `/api/v1/admin/system/health`; update handler to return `{ status: 'ok', timestamp: new Date().toISOString(), uptime: process.uptime() }`; update JSON Schema response to include timestamp (type: string) and uptime (type: number) properties
- [x] T006 [US1] Register health route in `buildServer` in `backend/src/index.js` — add `await app.register(require('./api/routes/health'));` after error handler registration (depends on T005)
- [x] T007 [US1] Create `tests/backend/scaffold.test.js` — import `{ buildServer }` from `../../backend/src/index`; use `beforeEach`/`afterEach` to create and close a fresh app instance; write two test groups: (a) health check: `app.inject({ method: 'GET', url: '/api/v1/admin/system/health' })` asserts statusCode 200 and body matches `{ status: 'ok' }` with timestamp string and uptime number; (b) error envelope: `app.inject({ method: 'GET', url: '/does-not-exist' })` asserts statusCode 404 and body has `error.code` (string) and `error.message` (string)

**Checkpoint**: `cd backend && npm test` passes all tests. US1 fully functional and independently verified.

---

## Phase 4: User Story 2 — Cross-Origin Request Support (Priority: P2)

**Goal**: Allow the Vue.js frontend at `http://localhost:3000` to make credentialed API calls without browser CORS blocks.

**Independent Test**: Send `OPTIONS http://localhost:4000/api/v1/admin/system/health` with `Origin: http://localhost:3000` — response includes `Access-Control-Allow-Origin: http://localhost:3000` and `Access-Control-Allow-Credentials: true`.

- [x] T008 [US2] Add `@fastify/cors` to `buildServer` in `backend/src/index.js` — `const cors = require('@fastify/cors');` at top; inside `buildServer`, after Fastify instance creation, add `await app.register(cors, { origin: process.env.CORS_ORIGIN || 'http://localhost:3000', credentials: true });` before route registration

**Checkpoint**: Preflight request from `http://localhost:3000` returns correct CORS headers. US2 independently verifiable with curl or browser DevTools.

---

## Phase 5: User Story 3 — Structured Request Logging (Priority: P3)

**Goal**: Document the structured logging configuration so operators know how to control log verbosity, and provide an `.env.example` that covers all server environment variables.

**Independent Test**: `LOG_LEVEL=debug node backend/src/index.js` → every request produces a JSON log line on stdout containing method, route, statusCode, and responseTime.

- [x] T009 [US3] Create `backend/.env.example` — document all environment variables accepted by the server with their defaults and descriptions: PORT (default: 4000), HOST (default: 0.0.0.0), LOG_LEVEL (default: info, accepted: trace/debug/info/warn/error/fatal), CORS_ORIGIN (default: http://localhost:3000), NODE_ENV (default: development, controls stack trace in error responses), DATABASE_URL (format note, used by node-pg-migrate), RUN_MIGRATIONS_ON_START (default: true)

**Checkpoint**: Developer can copy `.env.example` to `.env`, adjust values, and start the server with correct log verbosity. US3 independently verifiable by tailing stdout.

---

## Phase 6: User Story 4 — Containerized Deployment (Priority: P4)

**Goal**: Produce a Dockerfile that builds a self-contained backend image runnable with `docker run -p 4000:4000 kyc-backend`.

**Independent Test**: `docker build -t kyc-backend ./backend` succeeds; `docker run --rm -p 4000:4000 kyc-backend` starts and `curl http://localhost:4000/api/v1/admin/system/health` returns 200.

- [x] T010 [US4] Create `backend/Dockerfile` — base image `node:22-alpine`; `WORKDIR /app`; `COPY package.json package-lock.json* ./`; `RUN npm ci --production`; `COPY . .`; `EXPOSE 4000`; `CMD ["node", "src/index.js"]`
- [x] T011 [P] [US4] Create `backend/.dockerignore` — exclude: `node_modules`, `npm-debug.log`, `.env`, `.env.local`, `tests/`, `*.test.js`

**Checkpoint**: Docker image builds and passes the health check. US4 independently verifiable with `docker run`.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final validation confirming all acceptance criteria are met end-to-end.

- [x] T012 Run `cd backend && npm install && npm test` — confirm all Jest tests pass with exit code 0; run `docker build -t kyc-backend ./backend` — confirm image builds with no errors; fix any issues found before marking complete

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — all three tasks (T001, T002, T003) can start immediately and run in parallel with each other
- **Foundational (Phase 2)**: T004 requires T001 complete (correct deps in package.json) — **BLOCKS all user stories**
- **User Stories (Phase 3–6)**: All require T004 complete; within each story, tasks are sequential; stories can proceed in priority order or in parallel if staffed
- **Polish (Phase 7)**: Requires all desired stories complete

### User Story Dependencies

- **US1 (P1)**: Starts after T004. T005 → T006 → T007 (sequential within story)
- **US2 (P2)**: Starts after T004. T008 modifies index.js — run after T006 to avoid merge conflicts
- **US3 (P3)**: Starts after T004. T009 is a new file — can run in parallel with US2
- **US4 (P4)**: Starts after US1 (needs working index.js to verify Docker container passes health check). T010 and T011 are independent of each other

### Within US1

- T005 (health.js) before T006 (register route)
- T007 (tests) after T005 and T006

### Parallel Opportunities

- T001, T002, T003 — all parallel (different files, no deps)
- T009, T010, T011 — all parallel (different files)
- T002 and T003 can also run while T001 is in progress (they don't read package.json)

---

## Parallel Example: Setup Phase

```text
# All three can run simultaneously:
Task T001: Update backend/package.json
Task T002: Create backend/jsconfig.json
Task T003: Create backend/src/ skeleton with 46 stub files
```

## Parallel Example: US3 + US4 together

```text
# Once US1 and US2 are complete, these can run simultaneously:
Task T009: Create backend/.env.example
Task T010: Create backend/Dockerfile
Task T011: Create backend/.dockerignore
```

---

## Implementation Strategy

### MVP (User Story 1 only)

1. Phase 1: Setup (T001–T003)
2. Phase 2: Foundational (T004)
3. Phase 3: US1 — health endpoint + tests (T005–T007)
4. **STOP and VALIDATE**: `npm test` passes, `curl /api/v1/admin/system/health` returns 200
5. Proceed to US2–US4 incrementally

### Incremental Delivery

1. Setup + Foundational → server boots, logs JSON
2. US1 → health endpoint + Jest tests → independently testable MVP
3. US2 → CORS → frontend can make requests
4. US3 → env example → operators know how to configure logging
5. US4 → Docker → container-ready
6. Polish → full acceptance criteria confirmed

---

## Notes

- [P] tasks = different files, no blocking dependencies
- [Story] label traces each task to its user story for review and rollback purposes
- The `buildServer` export pattern (T004) is the critical enabler — all Jest tests depend on it
- T003 creates 46 stub files; batch this as a single scripted operation rather than 46 individual edits
- US2 (T008) modifies `index.js` — coordinate with T006 to avoid editing the same file concurrently
- Each story phase ends with a named checkpoint; stop at any checkpoint to validate independently before advancing
