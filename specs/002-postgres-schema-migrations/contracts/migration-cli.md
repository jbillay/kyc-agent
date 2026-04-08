# Contract: Migration CLI & Startup Runner

**Branch**: `002-postgres-schema-migrations` | **Date**: 2026-04-08

This document defines the npm scripts and programmatic API for the migration system
(`backend/db/migrate.js`) and the seed script (`backend/db/seed.js`).

---

## npm Scripts (defined in `backend/package.json`)

| Script | Command | Description |
|--------|---------|-------------|
| `npm run migrate:up` | `node-pg-migrate up` | Apply all pending migrations in ascending order |
| `npm run migrate:down` | `node-pg-migrate down` | Reverse the most recently applied migration |
| `npm run migrate:create <name>` | `node-pg-migrate create <name>` | Scaffold a new migration file in `db/migrations/` |
| `npm run migrate:status` | `node-pg-migrate status` | List applied and pending migrations |
| `npm run db:seed` | `node db/seed.js` | Insert the default admin user (idempotent, insert-only) |

---

## Programmatic API: `migrate.js`

`backend/db/migrate.js` exports a single async function used by the API startup sequence.

### `runMigrations()`

```
runMigrations() → Promise<void>
```

Applies all pending migrations using `node-pg-migrate` programmatically.
Resolves when all pending migrations have been applied (or when there are none).
Rejects if any migration fails — the error propagates and the API server startup
is aborted (fail-fast behavior).

**Called by** `backend/src/index.js` before `fastify.listen()` when
`RUN_MIGRATIONS_ON_START !== 'false'`.

---

## Startup Integration

**Environment variable**: `RUN_MIGRATIONS_ON_START`

| Value | Behavior |
|-------|---------|
| `true` (default) | `runMigrations()` is called before the server starts accepting requests |
| `false` | Migration auto-run is skipped; operator is responsible for applying migrations |

**Startup sequence** (when `RUN_MIGRATIONS_ON_START` is not `'false'`):
```
1. Parse env vars
2. Initialize connection pool (connection.js)
3. Call runMigrations() → await completion
4. Call fastify.listen({ port: 4000, host: '0.0.0.0' })
```

No request is accepted until step 4 completes. If migrations fail (step 3 rejects),
the process exits with a non-zero code and the container restarts via Docker policy.

---

## Migration File Convention

Migration files MUST follow the naming convention: `NNN-description.js`

| Component | Rule |
|-----------|------|
| `NNN` | Three-digit zero-padded sequence number (e.g., `001`, `002`, `010`) |
| `description` | Kebab-case description of the change (e.g., `add-cases-table`) |
| Extension | `.js` (node-pg-migrate JS format) |

Each file MUST export `up` and `down` functions:
```js
exports.up = (pgm) => { /* forward migration */ };
exports.down = (pgm) => { /* reverse migration */ };
```

Migration numbers are globally unique. A conflict (two files with the same number)
must be resolved before merging. The `pgmigrations` table (managed by node-pg-migrate)
records applied migrations by filename to prevent duplicate execution.

---

## Seed Script: `seed.js`

`backend/db/seed.js` is a standalone script (not imported by other modules).

**Behavior**:
1. Checks for any existing user with `role = 'admin'`.
2. If found: logs `"Seed skipped: admin account already exists"` and exits with code 0.
3. If not found: hashes `admin` with bcrypt (cost factor 10), inserts
   `{ email: 'admin@kycagent.local', name: 'System Admin', role: 'admin', ... }`,
   logs a `⚠ WARNING: Change the default admin password immediately.`

**Idempotency**: Safe to run multiple times. Never overwrites or modifies an existing
admin account under any circumstances.

**Exit codes**:
- `0` — success (seed applied or skipped)
- `1` — error (database connection failure, unexpected error)
