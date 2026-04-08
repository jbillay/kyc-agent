# Research: PostgreSQL Database Schema & Migration System

**Branch**: `002-postgres-schema-migrations` | **Date**: 2026-04-08

## Decision 1: Migration Library — node-pg-migrate

**Decision**: Use `node-pg-migrate` for incremental migrations.

**Rationale**: node-pg-migrate is PostgreSQL-specific (no generic abstraction overhead),
supports JS migration files (allowing conditional logic and data migrations alongside DDL),
tracks applied migrations in a `pgmigrations` table automatically, and integrates with npm
scripts cleanly. It is the most widely used migration library for Node.js + PostgreSQL stacks.

**Alternatives considered**:
- `db-migrate` — more generic, supports multiple databases, but the abstraction adds
  unnecessary complexity for a PostgreSQL-only project
- `Flyway` — Java-based, excellent for enterprise teams but requires JVM; incompatible
  with a Node.js-only build chain
- `Knex migrations` — tied to the Knex query builder; adding Knex solely for migrations
  would introduce a large dependency for one use case
- Hand-rolled SQL migrations with a custom tracking table — viable but reinvents the wheel

---

## Decision 2: init.sql vs. Migration-Only Approach

**Decision**: Use `init.sql` as the base schema (run by Docker on first container start)
plus node-pg-migrate for all subsequent changes. Migrations begin at `001` after the
base schema is established.

**Rationale**: The `init.sql` Docker entrypoint ensures the schema is ready before any
service connects, with zero application-layer involvement. Combining this with a migration
system gives the best of both worlds: Docker handles the cold-start problem, while
node-pg-migrate handles ongoing schema evolution. The pgmigrations tracking table is created
by node-pg-migrate on first run and does not need to be in `init.sql`.

**Key implication**: Developers resetting their local environment must use
`docker-compose down -v && docker-compose up` (not just `up`) to re-apply `init.sql`.
This is documented in the quickstart.

**Alternatives considered**:
- Migration-only (no init.sql) — would require the first migration to contain the full
  schema; creating a 500-line migration file is harder to review and maintain than a
  focused `init.sql`
- init.sql only (no migrations) — would require modifying `init.sql` for every schema
  change, with no version tracking or rollback capability

---

## Decision 3: Auto-Run on Startup Implementation

**Decision**: In `backend/src/index.js`, call the migration runner before `fastify.listen()`.
Controlled by `RUN_MIGRATIONS_ON_START` env var (default `true`).

**Implementation pattern**:
```js
if (process.env.RUN_MIGRATIONS_ON_START !== 'false') {
  await runMigrations();
}
await fastify.listen({ port: 4000, host: '0.0.0.0' });
```

**Rationale**: Running migrations synchronously before the server starts ensures no
request can hit the API with a stale schema. The env var disables auto-run for production
environments where migrations are applied by a separate deployment step (e.g., CI/CD
pipeline) before the application is started.

**Alternatives considered**:
- Fire-and-forget migration on startup — risks race conditions where the first requests
  arrive before migrations complete
- Separate Docker service that runs migrations before API starts — possible but adds
  container complexity; the env var approach is simpler for a single-node stack

---

## Decision 4: bcrypt Cost Factor

**Decision**: bcrypt with cost factor 10 (default in most bcrypt libraries).

**Rationale**: Cost 10 produces a hash in ~100ms on modern hardware — fast enough to not
impair seed script performance, slow enough to resist brute-force attacks. OWASP recommends
a minimum cost factor that takes at least 100ms; factor 10 meets this. Factor 12 would
double the time with no compliance requirement difference for this use case.

**Alternatives considered**:
- Cost factor 12 — more secure margin but unnecessary for a seed-only script; the seeded
  password is intended to be changed immediately
- Argon2 — OWASP's current top recommendation but requires a native Node.js addon
  (`argon2` npm package uses node-gyp), complicating Docker builds on Alpine Linux
- scrypt — Node.js built-in (no dependency) but less familiar to compliance auditors

---

## Decision 5: Connection Pool Configuration Defaults

**Decision**: `pg.Pool` with `max: 20`, `min: 2`, `idleTimeoutMillis: 30000`,
`connectionTimeoutMillis: 5000`. All configurable via env vars.

**Rationale**: 20 max connections is sufficient for a single API process + worker processes
on a development/staging stack. The 5-second connection timeout fails fast on database
unavailability rather than hanging indefinitely. The 30-second idle timeout releases
connections cleanly when load drops.

**Pool exhaustion behavior**: When all 20 connections are in use, new `pool.query()` calls
queue internally in pg.Pool and are served as connections free up. The
`connectionTimeoutMillis: 5000` controls the maximum wait time — if no connection frees
within 5 seconds, the query rejects with an error. This fail-fast behavior is appropriate
for a regulated platform where hanging requests are worse than clear errors.

**Alternatives considered**:
- No minimum (`min: 0`) — pool would create connections from scratch on first request
  after idle periods, causing latency spikes
- Higher max (50+) — appropriate for high-throughput production but PostgreSQL has a
  default `max_connections: 100`; leaving headroom for admin connections and other
  processes is prudent

---

## Decision 6: Seed Script — Insert-Only Guard

**Decision**: Check for any existing admin user before inserting. If any user with
`role = 'admin'` exists, exit silently with a log message.

**Implementation pattern**:
```js
const { rows } = await query(
  "SELECT id FROM users WHERE role = 'admin' LIMIT 1"
);
if (rows.length > 0) {
  console.log('Seed skipped: admin account already exists');
  return;
}
// Create admin user...
```

**Rationale**: Checking for any admin (not just the specific seed email) prevents creating
a duplicate if an admin was created through the UI. Using an upsert would silently
overwrite a changed password, which is a security concern. The insert-only approach is
explicit and auditable.

**Alternatives considered**:
- Check by email only (`admin@kycagent.local`) — would create a second admin if the
  seed email was changed; checking by role is more robust
- Upsert (always overwrite) — rejected during clarification; violates the spec requirement
  that the seed never overwrites a changed password
