# Feature Specification: PostgreSQL Database Schema & Migration System

**Feature Branch**: `002-postgres-schema-migrations`
**Created**: 2026-04-08
**Status**: Draft
**Input**: specifications/epic-01-infrastructure-devops/database/SPEC.md

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Bootstrap a Fresh Database (Priority: P1)

When the platform is started for the first time, the database is automatically created with
the complete schema — all tables, constraints, indexes, and audit-enforcement rules — so
that backend services can immediately begin storing cases, events, and agent outputs.

**Why this priority**: Every other feature in the platform depends on the schema being
present. Without it, no data can be written and no service can function. This is the
prerequisite for all agent and API work.

**Independent Test**: Start a fresh PostgreSQL instance, apply the initialization script,
then verify all 9 tables exist with their constraints and indexes.

**Acceptance Scenarios**:

1. **Given** a clean database with no existing schema, **When** the initialization script
   runs, **Then** all 9 tables are created with their columns, constraints, and indexes.
2. **Given** the schema has been applied, **When** a service attempts to INSERT a record
   with an invalid enum value (e.g., a case state not in the allowed list), **Then** the
   database rejects the insert with a constraint violation.
3. **Given** the schema has been applied, **When** a service attempts to UPDATE or DELETE
   a row in the audit event table, **Then** the operation silently does nothing — the row
   is unchanged and no error is returned to the caller.

---

### User Story 2 — Establish a Default Admin Account (Priority: P2)

On first deployment, a platform administrator can log in immediately using a known default
account, so they can access the system and create additional users without needing out-of-band
setup steps.

**Why this priority**: Without a seed admin account, the platform is inaccessible after
initial deployment. The seed data is a one-time bootstrap step, but it is critical for
operators to get started.

**Independent Test**: Run the seed script against a schema-initialized database; confirm
the admin user record exists with a valid, securely hashed password.

**Acceptance Scenarios**:

1. **Given** the schema exists and the seed script has not been run, **When** the seed
   script runs, **Then** an admin user account is created with the email
   `admin@kycagent.local` and a securely hashed password.
2. **Given** an admin user already exists in the system, **When** the seed script runs,
   **Then** the script exits without creating a duplicate or modifying the existing account
   in any way — credentials, roles, and all other fields are preserved exactly as-is.

---

### User Story 3 — Apply Incremental Schema Changes (Priority: P3)

A developer introducing a new feature that requires a database change can create a numbered
migration file, run it forward (and reverse it if needed), and trust that the schema version
is tracked so the same migration is never applied twice.

**Why this priority**: As the platform evolves across 16 epics, schema changes are
inevitable. Without a migration system, changes require manual SQL execution and carry
high risk of environment drift between development, staging, and production.

**Independent Test**: Create a test migration that adds a column, run it forward against
a schema-initialized database, verify the column exists, then run it in reverse and verify
the column is removed.

**Acceptance Scenarios**:

1. **Given** the migration system is configured, **When** the API server starts (or a
   developer runs the migration command manually), **Then** all pending migrations are
   applied in numbered order and the applied version is recorded.
2. **Given** a migration has already been applied, **When** the migration command runs
   again, **Then** the already-applied migration is skipped — no duplicate execution.
3. **Given** a migration has been applied, **When** the developer runs the rollback
   command, **Then** the most recent migration is reversed and the schema version is
   decremented.

---

### Edge Cases

- What happens if the initialization script is run against a database that already has the
  schema? All `CREATE TABLE` statements use `IF NOT EXISTS` so re-running is safe and
  idempotent.
- What happens if the seed script fails mid-run (e.g., database connection drops)? The
  script uses a single upsert operation — partial state is not possible.
- What happens if a migration file is deleted after being applied? The migration system
  records applied versions by number; a missing file does not cause failures on subsequent
  runs, but the rollback for that version becomes unavailable.
- What happens if two developers create migrations with the same number? The migration
  system will detect the conflict when both files exist; the convention is to resolve via
  code review before merging.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: An initialization script MUST create all 9 tables on a blank database:
  `users`, `cases`, `agent_results`, `decision_fragments`, `decision_events`, `documents`,
  `screening_lists`, `screening_entries`, `data_source_cache`.
- **FR-002**: All initialization script `CREATE TABLE` statements MUST be idempotent
  (safe to run on a database that already has the schema, with no error or data loss).
- **FR-003**: The `decision_events` table MUST enforce append-only behavior: UPDATE and
  DELETE operations MUST be silently ignored at the database level (no application-layer
  enforcement required).
- **FR-004**: All tables MUST enforce data integrity via CHECK constraints on enum columns
  (e.g., case state, risk rating, agent type, review status).
- **FR-005**: All tables MUST have appropriate indexes to support queries at 100,000+ case
  volume without full-table scans on common access patterns (by state, by case ID, by
  creation date).
- **FR-006**: All primary keys MUST be universally unique identifiers generated by the
  database (not application-generated sequential integers).
- **FR-007**: A seed script MUST create a default administrator account using a securely
  hashed password if and only if no administrator account already exists. If any admin
  account is present, the script MUST exit silently without modifying any data.
- **FR-008**: The seed script MUST NOT store the plain-text password anywhere — only a
  bcrypt hash (minimum cost factor 10) produced at runtime. The hashing algorithm MUST
  be bcrypt to meet audit and compliance review requirements.
- **FR-009**: A database connection module MUST provide pooled connections with configurable
  minimum and maximum pool sizes via environment variables.
- **FR-010**: The connection module MUST log a warning for any query that exceeds 1 second
  in execution time.
- **FR-011**: A migration system MUST be available so that schema changes introduced after
  initial deployment can be applied incrementally, tracked by version number, and reversed
  if needed.
- **FR-012**: The migration system MUST prevent the same migration from being applied more
  than once.
- **FR-013**: The API server MUST run all pending migrations automatically on startup,
  before accepting any requests. This behavior MUST be disableable via an environment
  variable (`RUN_MIGRATIONS_ON_START=false`) for environments where operators control
  migration timing explicitly.
- **FR-014**: A standalone migration command MUST be available so operators can run, roll
  back, or inspect migrations independently of the application startup process.

### Key Entities

- **Table**: A named relation in the database with typed columns, constraints (NOT NULL,
  CHECK, UNIQUE, FOREIGN KEY), and indexes. Nine tables constitute the complete schema.
- **Migration**: A numbered, named file defining a forward (up) and reverse (down)
  transformation of the schema. Applied in ascending number order; reversed in descending.
- **Seed Record**: An initial data record inserted into the database at deploy time to
  allow the platform to be used immediately. The admin user is the only seed record.
- **Connection Pool**: A managed set of reusable database connections shared across all
  application processes, bounded by configurable minimum and maximum sizes.
- **Append-Only Rule**: A database-level constraint (not application code) that prevents
  any modification or removal of existing rows in the audit event table.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The complete schema (9 tables, all indexes, all constraints) is created on a
  blank database in under 10 seconds.
- **SC-002**: The initialization script can be re-run on an existing schema with no errors
  and no data loss — 100% idempotent.
- **SC-003**: An attempt to modify or delete any audit event row results in 0 rows affected,
  verified by a before/after row count.
- **SC-004**: The default admin account is accessible immediately after the seed script
  runs — no manual steps required.
- **SC-005**: Any individual migration can be applied and reversed without leaving the
  schema in an inconsistent state.
- **SC-006**: The schema sustains 100,000 case records and 1,000,000 audit events with
  all common queries (fetch by case ID, fetch by state, fetch events for a case) completing
  in under 500ms via indexes.

## Clarifications

### Session 2026-04-08

- Q: Should pending migrations run automatically on application startup, or must they be triggered manually? → A: Both — auto-run on startup (configurable via env var); manual command also available.
- Q: What should the seed script do when the admin account already exists? → A: Insert only if absent — if any admin user exists, skip silently; never overwrite credentials.
- Q: Which password hashing algorithm should be used for the seed admin account? → A: bcrypt — industry standard, built-in cost factor, universally auditable by compliance reviewers.

## Assumptions

- The database service is running and accepting connections before the initialization
  script or seed script is executed (dependency on feature 001-docker-compose-stack).
- The default admin password (`admin`) is intentionally weak and documented as
  requiring immediate change in production; the seed script logs a prominent warning.
- bcrypt with cost factor 10 is used for password hashing; cost factor may be increased
  in future migrations as hardware improves without breaking existing hashes.
- Migration files are numbered sequentially starting from `001` and use a consistent
  naming convention (`NNN-description.js`) enforced by developer convention.
- The connection pool is shared within a single Node.js process; each worker process
  (API server, agent-worker) has its own pool instance.
- The `data_source_cache` table stores external API responses for audit reproducibility;
  it is not a general-purpose cache and its TTL is set per provider configuration.
