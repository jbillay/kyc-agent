---
description: "Task list for Docker Compose Stack implementation"
---

# Tasks: Docker Compose Stack

**Input**: Design documents from `specs/001-docker-compose-stack/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

**Tests**: Not requested in spec — no test tasks generated.

**Organization**: Tasks grouped by user story. US1 (stand-up) is independently deliverable
as MVP. US2 (configuration) and US3 (persistence) extend the base compose file.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1, US2, US3)
- File paths are relative to repository root

---

## Phase 1: Setup

**Purpose**: Confirm repository structure is in place before creating files.

- [x] T001 Verify repository root contains `backend/` and `frontend/` directories; create
  `backend/db/` subdirectory if absent

**Checkpoint**: Directory structure confirmed — Phase 2 can begin.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core files all user stories depend on. MUST complete before any story work.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [x] T002 [P] Create `backend/Dockerfile` — Node.js 20-alpine base image; `WORKDIR /app`;
  `COPY package*.json ./`; `RUN npm ci --omit=dev`; `COPY src/ ./src/`; `COPY config/ ./config/`;
  `EXPOSE 4000`; default `CMD ["node", "src/index.js"]`
- [x] T003 [P] Create `frontend/Dockerfile` — multi-stage build: stage 1 node:20-alpine
  `npm run build` outputs `/app/dist`; stage 2 nginx:alpine copies `/app/dist` to
  `/usr/share/nginx/html`; `EXPOSE 3000`
- [x] T004 Create `backend/db/init.sql` — define all 7 core tables (`cases`, `agent_results`,
  `decision_fragments`, `decision_events`, `documents`, `screening_lists`, `screening_entries`,
  `users`) plus PostgreSQL no-update/no-delete rules on `decision_events`:
  `CREATE RULE no_update_decision_events AS ON UPDATE TO decision_events DO INSTEAD NOTHING;`
  and matching delete rule

**Checkpoint**: Foundation ready — user story implementation can begin.

---

## Phase 3: User Story 1 — Stand Up the Full Platform (Priority: P1) 🎯 MVP

**Goal**: `docker-compose up` starts all 8 service categories from a clean machine with
zero manual intervention.

**Independent Test**: Run `docker-compose up -d`; confirm `docker-compose ps` shows all
services running/healthy; verify frontend reachable at `http://127.0.0.1:3000`.

### Implementation for User Story 1

- [x] T005 [US1] Create `docker-compose.yaml` — define all 8 services with:
  - **Infrastructure** (restart: `unless-stopped`): `postgres` (image: postgres:16,
    healthcheck: `pg_isready`, volume: `pgdata:/var/lib/postgresql/data`, init.sql mount),
    `redis` (image: redis:7-alpine, healthcheck: `redis-cli ping`, volume: `redisdata:/data`),
    `minio` (image: minio/minio, command: `server /data --console-address ":9001"`, volume:
    `miniodata:/data`), `ollama` (image: ollama/ollama, volume: `ollamadata:/root/.ollama`,
    GPU passthrough block commented out)
  - **Application** (restart: `on-failure`): `api` (build: `./backend`, depends_on postgres/redis
    healthy + minio started, `MINIO_ENDPOINT=minio`, `REDIS_URL=redis://redis:6379`,
    `DATABASE_URL` with postgres service name), `agent-worker` (build: `./backend`,
    command: `node src/workers/agent-worker.js`, depends_on postgres/redis healthy + ollama
    started, `OLLAMA_BASE_URL=http://ollama:11434`, `LLM_CONFIG_PATH=/app/config/llm.yaml`,
    deploy replicas: `${AGENT_WORKER_REPLICAS:-2}`), `screening-sync` (build: `./backend`,
    command: `node src/workers/screening-sync.js`, depends_on postgres healthy),
    `frontend` (build: `./frontend`, depends_on api started, `VITE_API_URL` and `VITE_WS_URL`
    env vars)
  - **Volumes section**: declare `pgdata`, `redisdata`, `miniodata`, `ollamadata`
- [x] T006 [US1] Add `GET /health` route returning `{"status": "ok"}` with HTTP 200 in
  `backend/src/api/routes/health.js`; register route in `backend/src/api/index.js` (or
  main Fastify server file)
- [x] T007 [US1] Add MinIO `documents` bucket initialization in `backend/src/index.js`
  API server startup — after MinIO client is created, call `bucketExists('documents')`;
  if false, call `makeBucket('documents')`; log result; wrap in try/catch with startup error

**Checkpoint**: US1 complete — `docker-compose up` starts all services independently.

---

## Phase 4: User Story 2 — Configure Without Code Changes (Priority: P2)

**Goal**: Any port, credential, or replica count changeable via `.env` alone.

**Independent Test**: Add `API_PORT=4001` to `.env`; run `docker-compose up -d api`;
confirm API responds on port 4001 and port 4000 is no longer bound.

### Implementation for User Story 2

- [x] T008 [US2] Update `docker-compose.yaml` port bindings to localhost-default syntax
  for all 7 exposed ports:
  `"${PG_HOST:-127.0.0.1}:${PG_PORT:-5432}:5432"`,
  `"${REDIS_HOST:-127.0.0.1}:${REDIS_PORT:-6379}:6379"`,
  `"${MINIO_HOST:-127.0.0.1}:${MINIO_API_PORT:-9000}:9000"`,
  `"${MINIO_CONSOLE_HOST:-127.0.0.1}:${MINIO_CONSOLE_PORT:-9001}:9001"`,
  `"${OLLAMA_HOST:-127.0.0.1}:${OLLAMA_PORT:-11434}:11434"`,
  `"${API_HOST:-127.0.0.1}:${API_PORT:-4000}:4000"`,
  `"${FRONTEND_HOST:-127.0.0.1}:${FRONTEND_PORT:-3000}:3000"`
- [x] T009 [P] [US2] Create `.env.example` documenting all 18 environment variables with
  grouped sections (PostgreSQL, Redis, MinIO, Ollama, API Server, Frontend, Agent Workers);
  mark `PG_PASSWORD`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `JWT_SECRET` with
  `# ⚠ Change in production` inline comments; include note that `_HOST` vars control
  interface binding and `0.0.0.0` exposes to network

**Checkpoint**: US1 and US2 complete — platform starts and is fully configurable via `.env`.

---

## Phase 5: User Story 3 — Survive a Restart With Persistent Data (Priority: P3)

**Goal**: Data written before a restart is 100% recoverable after restart (without `down -v`).

**Independent Test**: Insert a row into `users` table; run `docker-compose restart postgres`;
query the row and confirm it is still present. Restart full stack and confirm MinIO file
and Ollama model cache are intact.

### Implementation for User Story 3

- [x] T010 [US3] Verify volume mount paths in `docker-compose.yaml` are correct for all
  4 persistence-critical services: `postgres` → `pgdata:/var/lib/postgresql/data`,
  `redis` → `redisdata:/data`, `minio` → `miniodata:/data`,
  `ollama` → `ollamadata:/root/.ollama`; fix any incorrect paths; confirm `docker-compose
  down` (without `-v`) leaves volumes intact by checking `docker volume ls` after teardown

**Checkpoint**: US1, US2, US3 complete — all user stories independently functional.

---

## Phase 6: Development Override (FR-012)

**Purpose**: Developer hot-reload experience without modifying the production-safe base
compose file.

- [x] T011 Create `docker-compose.override.yml` — override `api` and `agent-worker`
  services with bind mount `./backend/src:/app/src:ro` and CMD `["node_modules/.bin/nodemon",
  "src/index.js"]` (api) / `["node_modules/.bin/nodemon", "src/workers/agent-worker.js"]`
  (agent-worker); override `frontend` with bind mount `./frontend/src:/app/src:ro` and CMD
  `["npm", "run", "dev", "--", "--host", "0.0.0.0"]`; add comment explaining the file is
  auto-merged by Docker Compose V2 and is safe to customize locally

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Documentation and validation completing all acceptance criteria.

- [x] T012 Update `README.md` — add **Setup** section with: prerequisites (Docker Desktop
  4.x+, 16GB RAM, 8 CPU, 50GB disk), quick start (`docker-compose up`), first-run note on
  Ollama model pull (`docker-compose exec ollama ollama pull mistral`), environment
  configuration (copy `.env.example` to `.env`, production credential warnings),
  development workflow (override file auto-merge), teardown warning (`down -v` destroys data)
- [ ] T013 [P] Run `specs/001-docker-compose-stack/quickstart.md` validation suite — execute
  all 9 steps (cold start, health checks, networking, MinIO bucket, `.env` override,
  persistence, on-failure restart, clean teardown, dev hot-reload); record any failures
  as issues before marking feature complete

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Setup — **BLOCKS all user stories**
- **US1 (Phase 3)**: Depends on Foundational — creates `docker-compose.yaml` + server health
- **US2 (Phase 4)**: Depends on US1 — modifies compose file port bindings; creates `.env.example`
- **US3 (Phase 5)**: Depends on US1 — verifies volumes already declared in compose file
- **Dev Override (Phase 6)**: Depends on US1 — overrides services defined in compose file
- **Polish (Phase 7)**: Depends on US1–US3 and Dev Override being complete

### User Story Dependencies

- **US1 (P1)**: Starts after Foundational — no story dependencies
- **US2 (P2)**: Depends on US1 (modifies `docker-compose.yaml`); independently testable
- **US3 (P3)**: Depends on US1 (verifies US1 artifact); independently testable

### Within Each Phase

- T002 and T003 can run in parallel (different Dockerfile paths)
- T008 and T009 can run in parallel (different files: compose vs .env.example)
- T012 and T013 can run in parallel (documentation vs validation)

---

## Parallel Opportunities

### Phase 2 (Foundational)

```bash
# These can start simultaneously:
Task T002: Create backend/Dockerfile
Task T003: Create frontend/Dockerfile
# T004 must wait for nothing — also can start immediately
Task T004: Create backend/db/init.sql
```

### Phase 4 (US2)

```bash
# These can start simultaneously after T005:
Task T008: Update docker-compose.yaml port bindings
Task T009: Create .env.example
```

### Phase 7 (Polish)

```bash
# These can start simultaneously:
Task T012: Update README.md
Task T013: Run quickstart.md validation
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001)
2. Complete Phase 2: Foundational (T002, T003, T004)
3. Complete Phase 3: US1 (T005, T006, T007)
4. **STOP and VALIDATE**: `docker-compose up` starts all services — MVP delivered
5. All subsequent phases improve the experience but the platform is usable

### Incremental Delivery

1. T001 → T002+T003+T004 → T005+T006+T007 → **MVP: platform starts**
2. T008+T009 → **Config: any port/credential changeable via `.env`**
3. T010 → **Persistence: data survives restarts**
4. T011 → **Dev UX: hot-reload without rebuild**
5. T012+T013 → **Complete: documented and validated**

---

## Notes

- [P] tasks = different files, no shared dependencies within that phase
- Each user story phase produces an independently testable increment
- No test tasks generated (not requested in spec)
- T005 is the largest single task — the full `docker-compose.yaml` — but it is one atomic
  file that should not be split across multiple tasks
- T008 modifies T005's output; sequence is intentional (US1 → US2)
- The `docker-compose.override.yml` (T011) is automatically merged by Docker Compose V2
  when present; no operator action needed
