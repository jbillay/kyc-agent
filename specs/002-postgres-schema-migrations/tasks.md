# Tasks: PostgreSQL Database Schema & Migration System

**Input**: Design documents from `/specs/002-postgres-schema-migrations/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅, quickstart.md ✅

**Organization**: Tasks grouped by user story — each story is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete dependencies)
- **[Story]**: User story this task belongs to (US1, US2, US3)

---

## Phase 1: Setup

**Purpose**: Install dependencies and create the directory structure required by all user stories.

- [x] T001 Add `pg`, `bcrypt`, `node-pg-migrate` to `backend/package.json` dependencies and run `npm install`
- [x] T002 Create `backend/db/migrations/` directory with a `.gitkeep` placeholder file

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: The database connection module is required by EVERY user story and by the API startup sequence.
All user story work is blocked until this phase is complete.

**⚠️ CRITICAL**: No user story work can begin until T003 is complete.

- [x] T003 Implement `backend/db/connection.js` — export `query(text, params)` and `getClient()` using `pg.Pool`; read pool config from env vars (`DATABASE_URL`, `PG_POOL_MAX`, `PG_POOL_MIN`, `PG_POOL_IDLE_TIMEOUT_MS`, `PG_POOL_CONN_TIMEOUT_MS`); log a WARN for any query exceeding 1000 ms; pool is created at module load time

**Checkpoint**: Connection module complete — user story work can now proceed.

---

## Phase 3: User Story 1 — Bootstrap a Fresh Database (Priority: P1) 🎯 MVP

**Goal**: Replace the scaffold `init.sql` with the authoritative 9-table schema so that a fresh
PostgreSQL container initializes with all tables, constraints, indexes, and append-only enforcement.

**Independent Test**: Run `docker-compose down -v && docker-compose up postgres -d`, then verify
all 9 tables exist (`\dt`), a CHECK constraint rejects invalid enum values, and UPDATE/DELETE on
`decision_events` return 0 rows affected.

- [x] T004 [US1] Replace `backend/db/init.sql` — write the authoritative schema with `CREATE EXTENSION IF NOT EXISTS pgcrypto`, `CREATE EXTENSION IF NOT EXISTS pg_trgm`, and `CREATE TABLE IF NOT EXISTS` for all 9 tables: `users`, `cases`, `agent_results`, `decision_fragments`, `decision_events`, `documents`, `screening_lists`, `screening_entries`, `data_source_cache` — include all columns, types, CHECK constraints, NOT NULL constraints, DEFAULT values, FOREIGN KEY references, UNIQUE constraints, and indexes exactly as specified in `specs/002-postgres-schema-migrations/data-model.md`
- [x] T005 [US1] Add append-only enforcement to `backend/db/init.sql` — two PostgreSQL rules after `CREATE TABLE decision_events`: `CREATE RULE no_update_events AS ON UPDATE TO decision_events DO INSTEAD NOTHING` and `CREATE RULE no_delete_events AS ON DELETE TO decision_events DO INSTEAD NOTHING`

**Checkpoint**: User Story 1 complete — fresh container should pass all quickstart.md Steps 1–3.

---

## Phase 4: User Story 2 — Establish a Default Admin Account (Priority: P2)

**Goal**: Create a standalone seed script that inserts a bcrypt-hashed admin user on first run,
and silently skips if any admin already exists.

**Independent Test**: Run `node db/seed.js` twice against a schema-initialized database; verify
one admin row exists with a `$2b$10$` hash prefix, and that the second run logs "Seed skipped"
without changing any data.

- [x] T006 [US2] Create `backend/db/seed.js` — check for any existing `role = 'admin'` row; if found, log `"Seed skipped: admin account already exists"` and exit 0; if not found, hash the password `admin` with `bcrypt.hash('admin', 10)`, insert `{ email: 'admin@kycagent.local', name: 'System Admin', role: 'admin', password_hash, is_active: true }` into `users`, log `"Admin user created: admin@kycagent.local"` and `"⚠ WARNING: Change the default admin password immediately."`, exit 0; on any error, log the error and exit 1

**Checkpoint**: User Story 2 complete — quickstart.md Steps 4–5 should pass.

---

## Phase 5: User Story 3 — Apply Incremental Schema Changes (Priority: P3)

**Goal**: Add a node-pg-migrate runner that auto-applies pending migrations before the API starts,
plus manual npm scripts for operator-controlled migration management.

**Independent Test**: Run `npm run migrate:up` (no-op on fresh DB), create a test migration with
`npm run migrate:create`, apply it, verify the change, then roll back with `npm run migrate:down`
and verify the change is reversed.

- [x] T007 [US3] Create `backend/db/migrate.js` — export `async function runMigrations()` that calls `node-pg-migrate` programmatically (using its `run` API or `node-pg-migrate/dist/src/runner`) with `{ databaseUrl: process.env.DATABASE_URL, migrationsTable: 'pgmigrations', dir: path.join(__dirname, 'migrations'), direction: 'up', count: Infinity }`; log `"Running database migrations..."` before and `"Migrations complete."` after; let errors propagate (fail-fast)
- [x] T008 [US3] Add npm scripts to `backend/package.json`: `"migrate:up": "node-pg-migrate up"`, `"migrate:down": "node-pg-migrate down"`, `"migrate:create": "node-pg-migrate create"`, `"migrate:status": "node-pg-migrate status"`, `"db:seed": "node db/seed.js"`; also add a `node-pg-migrate` config block pointing `migrations-dir` to `db/migrations` and `database-url-var` to `DATABASE_URL`
- [x] T009 [US3] Update `backend/src/index.js` startup sequence — import `runMigrations` from `../db/migrate.js`; before `fastify.listen(...)`, add: `if (process.env.RUN_MIGRATIONS_ON_START !== 'false') { await runMigrations(); }`

**Checkpoint**: User Story 3 complete — quickstart.md Steps 6–7 should pass.

---

## Phase 6: Polish & Cross-Cutting Concerns

- [x] T010 Update `.env.example` at repo root — add the new env vars with defaults and comments: `DATABASE_URL`, `PG_POOL_MAX`, `PG_POOL_MIN`, `PG_POOL_IDLE_TIMEOUT_MS`, `PG_POOL_CONN_TIMEOUT_MS`, `RUN_MIGRATIONS_ON_START`; group them under a `# Database` section header
- [ ] T011 Run quickstart.md validation steps 1–8 against a live postgres container to confirm all acceptance scenarios pass

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 — no dependency on US2 or US3
- **US2 (Phase 4)**: Depends on Phase 2 — no dependency on US1 or US3
- **US3 (Phase 5)**: Depends on Phase 2; T009 also requires `backend/src/index.js` to exist (from feature 001)
- **Polish (Phase 6)**: Depends on all user stories complete

### User Story Dependencies

- **US1**: Independently testable after T003 (connection.js) — no dependency on US2/US3
- **US2**: Independently testable after T003 (connection.js) — no dependency on US1/US3
- **US3**: Independently testable after T003; T009 depends on T007 (migrate.js must exist first)

### Within Phase 3 (US1)

- T004 and T005 are sequential — T005 adds rules to the same `init.sql` written by T004

### Within Phase 5 (US3)

- T007 before T009 (migrate.js must exist before index.js imports it)
- T008 can run in parallel with T007 (different files: migrate.js vs package.json)

### Parallel Opportunities

- Phase 2 completes → US1, US2, and the T007/T008 part of US3 can all start in parallel
- T007 [US3] and T008 [US3] can run in parallel (different files)
- T010 (polish) can run in parallel with T011

---

## Parallel Example: After Foundational Phase

```bash
# Once T003 (connection.js) is done, these can start in parallel:
Task A: "T004 [US1] Replace backend/db/init.sql with 9-table schema"
Task B: "T006 [US2] Create backend/db/seed.js"
Task C: "T007 [US3] Create backend/db/migrate.js"
Task D: "T008 [US3] Add npm scripts to backend/package.json"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational — T003 connection.js
3. Complete Phase 3: User Story 1 — T004–T005 (init.sql with 9 tables)
4. **STOP and VALIDATE**: `docker-compose down -v && docker-compose up postgres`, run `\dt`, test constraints
5. Deploy if ready — every other service can now connect to a real schema

### Incremental Delivery

1. Setup + Foundational → connection module ready
2. User Story 1 → full schema bootstrapped (MVP)
3. User Story 2 → seed admin; platform is operable
4. User Story 3 → migration system in place; schema can evolve safely

---

## Notes

- init.sql only runs once per Docker volume. Devs must run `docker-compose down -v && docker-compose up` to re-apply a changed init.sql (documented in quickstart.md).
- The scaffold init.sql from feature 001 uses `uuid_generate_v4()` (uuid-ossp). T004 replaces it with `gen_random_uuid()` (pgcrypto). This is a breaking change requiring a volume reset.
- node-pg-migrate creates the `pgmigrations` tracking table automatically on first `migrate:up` run — it must NOT be in init.sql.
- The `migrations/` directory starts empty (`.gitkeep` only). The first real migration will be `001-*` and comes from a future feature branch.
