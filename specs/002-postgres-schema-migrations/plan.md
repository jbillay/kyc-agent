# Implementation Plan: PostgreSQL Database Schema & Migration System

**Branch**: `002-postgres-schema-migrations` | **Date**: 2026-04-08 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/002-postgres-schema-migrations/spec.md`

## Summary

Replace the scaffold `backend/db/init.sql` (created in feature 001) with the authoritative
full schema aligned to the SPEC.md column definitions. Add a pooled connection module, a
bcrypt-based seed script (insert-only), a node-pg-migrate migration runner with auto-run
on startup, and the CLI commands for manual migration control.

## Technical Context

**Language/Version**: Node.js 20 (JavaScript), SQL (PostgreSQL 16)
**Primary Dependencies**: `pg` (node-postgres connection pool), `bcrypt` (password hashing,
cost 10), `node-pg-migrate` (migration runner, tracks applied versions in DB)
**Storage**: PostgreSQL 16 — subject of this feature
**Testing**: Manual acceptance testing against a running postgres container; integration
tests deferred to future test-infrastructure epic
**Target Platform**: PostgreSQL 16 container from feature 001-docker-compose-stack
**Project Type**: Database infrastructure (schema DDL, connection module, seed, migrations)
**Performance Goals**: Schema creation < 10s; queries at 100k+ cases < 500ms via indexes
**Constraints**: Append-only enforcement via PostgreSQL rules (not application code);
bcrypt cost factor minimum 10; migrations auto-run on API startup (disableable via
`RUN_MIGRATIONS_ON_START=false`); UUID PKs from `gen_random_uuid()` (pgcrypto)
**Scale/Scope**: 9 tables, 1 seed record, migration runner, connection pool module

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status | Notes |
|-----------|------|--------|-------|
| I. Auditability First | `decision_events` table enforces append-only via PostgreSQL rules | ✅ Pass | This feature IS the implementation of Principle I's core requirement |
| II. LLM-Agnostic | No LLM calls in this feature | ✅ Pass | N/A — pure database layer |
| III. Layered Architecture | Database is Layer 0 (below Layer 1); no upward dependencies | ✅ Pass | `connection.js` has no imports from agent, API, or frontend layers |
| IV. Data Sovereignty | All data stays within the PostgreSQL container on the Docker network | ✅ Pass | No external calls |
| V. Config-Driven Compliance | Pool sizes, migration auto-run, DB URL all via env vars | ✅ Pass | `RUN_MIGRATIONS_ON_START`, `PG_POOL_MAX`, `PG_POOL_MIN` |

**All gates pass. No violations.**

*Post-design re-check*: All principles hold after Phase 1. The `migrate.js` auto-run
respects `RUN_MIGRATIONS_ON_START` env var, satisfying Principle V.

## Project Structure

```text
backend/
├── db/
│   ├── init.sql              # REPLACE scaffold — authoritative base schema (9 tables)
│   ├── connection.js         # NEW — pooled pg.Pool connection module
│   ├── migrate.js            # NEW — migration runner (called by API startup + CLI)
│   ├── seed.js               # NEW — insert-only admin user seed (bcrypt)
│   └── migrations/           # NEW — incremental migration files go here
│       └── .gitkeep
└── package.json              # UPDATE — add bcrypt, node-pg-migrate; add npm scripts
```

**Structure Decision**: All database infrastructure files live in `backend/db/`. The
`connection.js` module is the single point of contact for all database queries across
the application. Migration files are plain JS (not SQL) using node-pg-migrate's JS API
for maximum flexibility.

## Complexity Tracking

> No constitution violations to justify.

**Note on init.sql replacement**: The scaffold `init.sql` from feature 001 uses
`uuid_generate_v4()` (uuid-ossp extension) and `TEXT` column types. This feature replaces
it with `gen_random_uuid()` (pgcrypto, built into PostgreSQL 13+) and typed `VARCHAR`
columns matching the authoritative SPEC.md. Since the compose stack uses a named volume
(`pgdata`), the init.sql only runs once on a fresh volume — existing dev environments
must run `docker-compose down -v && docker-compose up` to pick up the new schema.
