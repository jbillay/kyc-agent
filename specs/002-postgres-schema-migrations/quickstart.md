# Quickstart Validation Guide: PostgreSQL Database Schema & Migration System

**Branch**: `002-postgres-schema-migrations` | **Date**: 2026-04-08

This guide validates all three user stories against a running PostgreSQL instance.
Run these steps in order after implementation is complete.

**Prerequisite**: PostgreSQL container must be running (`docker-compose up postgres`).

---

## Step 1: Bootstrap a Fresh Database (User Story 1 — P1)

**What we're validating**: All 9 tables, all constraints, all indexes, and append-only
enforcement are created by `init.sql` on a clean volume.

```bash
# Reset to a clean state (DESTRUCTIVE — destroys all data)
docker-compose down -v
docker-compose up postgres -d

# Wait for postgres to be healthy, then verify tables exist
docker-compose exec postgres psql -U kyc_user -d kyc_agent -c "\dt"
```

**Expected output**: 9 tables listed: `users`, `cases`, `agent_results`,
`decision_fragments`, `decision_events`, `documents`, `screening_lists`,
`screening_entries`, `data_source_cache`.

---

## Step 2: Verify CHECK Constraint Enforcement (User Story 1 — Acceptance Scenario 2)

```bash
# Attempt to insert a case with an invalid state — should be rejected
docker-compose exec postgres psql -U kyc_user -d kyc_agent -c "
  INSERT INTO cases (client_name, client_type, jurisdiction, state)
  VALUES ('Test Corp', 'corporate', 'GB', 'INVALID_STATE');
"
```

**Expected**: `ERROR: new row for relation "cases" violates check constraint`

---

## Step 3: Verify Append-Only Enforcement (User Story 1 — Acceptance Scenario 3)

```bash
# Insert a test event
docker-compose exec postgres psql -U kyc_user -d kyc_agent -c "
  INSERT INTO decision_events (case_id, agent_type, step_id, event_type, event_data)
  VALUES (gen_random_uuid(), 'system', 'init', 'test_event', '{\"test\": true}');
"

# Attempt to UPDATE — should silently do nothing
docker-compose exec postgres psql -U kyc_user -d kyc_agent -c "
  UPDATE decision_events SET event_type = 'modified' WHERE event_type = 'test_event';
  SELECT COUNT(*) FROM decision_events WHERE event_type = 'modified';
"
```

**Expected**: `UPDATE 0` and `count = 0` — the row is unchanged.

```bash
# Attempt to DELETE — should silently do nothing
docker-compose exec postgres psql -U kyc_user -d kyc_agent -c "
  DELETE FROM decision_events WHERE event_type = 'test_event';
  SELECT COUNT(*) FROM decision_events WHERE event_type = 'test_event';
"
```

**Expected**: `DELETE 0` and `count = 1` — the row still exists.

---

## Step 4: Run the Seed Script (User Story 2 — P2)

```bash
cd backend && node db/seed.js
```

**Expected output**:
```
Admin user created: admin@kycagent.local
⚠ WARNING: Change the default admin password immediately.
```

**Verify the admin was inserted with a hashed password**:
```bash
docker-compose exec postgres psql -U kyc_user -d kyc_agent -c "
  SELECT email, role, is_active, LEFT(password_hash, 7) AS hash_prefix
  FROM users WHERE role = 'admin';
"
```

**Expected**: One row with `email = admin@kycagent.local`, `role = admin`,
`is_active = true`, `hash_prefix = $2b$10$` (bcrypt cost 10 prefix).

---

## Step 5: Verify Seed Idempotency (User Story 2 — Acceptance Scenario 2)

```bash
# Run seed a second time — should skip, not duplicate or overwrite
cd backend && node db/seed.js
```

**Expected output**: `Seed skipped: admin account already exists`

**Verify still only one admin**:
```bash
docker-compose exec postgres psql -U kyc_user -d kyc_agent -c "
  SELECT COUNT(*) FROM users WHERE role = 'admin';
"
```

**Expected**: `count = 1`

---

## Step 6: Migration Round-Trip (User Story 3 — P3)

**6a — Apply pending migrations (should be zero on fresh DB)**:
```bash
cd backend && npm run migrate:up
```

**Expected**: `No migrations to run` (the base schema is in `init.sql`, not migrations).

**6b — Create and apply a test migration**:
```bash
cd backend && npm run migrate:create test-add-column
# Edit the generated file to add/drop a test column on 'users'
```

Add this content to the generated migration file:
```js
exports.up = (pgm) => {
  pgm.addColumn('users', { test_col: { type: 'TEXT', notNull: false } });
};
exports.down = (pgm) => {
  pgm.dropColumn('users', 'test_col');
};
```

```bash
cd backend && npm run migrate:up
```

**Expected**: Migration applied. Verify:
```bash
docker-compose exec postgres psql -U kyc_user -d kyc_agent -c "
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'users' AND column_name = 'test_col';
"
```
**Expected**: One row — `test_col` exists.

**6c — Roll back the test migration**:
```bash
cd backend && npm run migrate:down
```

**Verify column removed**:
```bash
docker-compose exec postgres psql -U kyc_user -d kyc_agent -c "
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'users' AND column_name = 'test_col';
"
```
**Expected**: Zero rows — `test_col` is gone.

---

## Step 7: Auto-Run on Startup

```bash
# Start the API server — migrations should auto-run before accepting requests
cd backend && npm start
```

**Expected log output includes**:
```
Running database migrations...
Migrations complete.
Server listening on 0.0.0.0:4000
```

```bash
# Disable auto-run and verify startup still works
RUN_MIGRATIONS_ON_START=false npm start
```

**Expected**: Server starts WITHOUT the migration log lines.

---

## Step 8: Slow Query Warning (FR-010)

```bash
# Run a query that takes > 1s (use pg_sleep for testing)
docker-compose exec postgres psql -U kyc_user -d kyc_agent -c "SELECT pg_sleep(1.1);"
```

Trigger the same through `connection.js` in a test script — verify the console shows:
```
WARN: Slow query (1234ms): SELECT pg_sleep(1.1)
```

---

## Validation Summary

| Check | Story | Pass Criteria |
|-------|-------|--------------|
| 9 tables created | US1 | `\dt` lists all 9 |
| CHECK constraint enforcement | US1 | INSERT with invalid enum rejected |
| Append-only UPDATE blocked | US1 | UPDATE returns 0 rows affected |
| Append-only DELETE blocked | US1 | DELETE returns 0 rows affected |
| Seed creates admin | US2 | Row exists with bcrypt `$2b$10$` prefix |
| Seed is idempotent | US2 | Second run skips; count stays 1 |
| Migration applies forward | US3 | Column added after `migrate:up` |
| Migration reverses cleanly | US3 | Column removed after `migrate:down` |
| Auto-run on startup | US3 | Migration log appears before listen |
| Auto-run disableable | US3 | `RUN_MIGRATIONS_ON_START=false` skips |
| Slow query warning | FR-010 | WARN logged for queries > 1s |
