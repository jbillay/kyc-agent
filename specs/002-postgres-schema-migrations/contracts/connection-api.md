# Contract: Database Connection Module API

**Branch**: `002-postgres-schema-migrations` | **Date**: 2026-04-08

This document defines the public interface exported by `backend/db/connection.js`.
All backend modules that need database access MUST import from this module exclusively.
No other module may instantiate `pg.Pool` directly.

---

## Exported Functions

### `query(text, params?)`

Execute a parameterized SQL query using the shared connection pool.

```
query(text: string, params?: any[]) → Promise<QueryResult>
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | `string` | Yes | SQL query string with `$1`, `$2`, … placeholders |
| `params` | `any[]` | No | Values for placeholders (default: empty) |

**Returns**: `Promise<QueryResult>` where `QueryResult.rows` is the array of result rows.

**Side Effects**:
- Logs a `WARN` to stdout if the query takes longer than 1000 ms (FR-010).
- Increments pool metrics (internal; not exposed).

**Errors**: Rejects with a `pg` `DatabaseError` if the query fails (constraint violation,
syntax error, connection loss, etc.). Callers are responsible for catching.

**Example**:
```js
const { rows } = await query(
  'SELECT id, email FROM users WHERE role = $1 LIMIT $2',
  ['admin', 10]
);
```

---

### `getClient()`

Acquire a dedicated client from the pool for multi-statement transactions.
**Must** be released with `client.release()` in a `finally` block.

```
getClient() → Promise<PoolClient>
```

**Returns**: `Promise<PoolClient>` — a raw `pg` client with `query`, `release` methods.

**Usage pattern**:
```js
const client = await getClient();
try {
  await client.query('BEGIN');
  await client.query('INSERT INTO cases (...) VALUES (...)');
  await client.query('INSERT INTO decision_events (...) VALUES (...)');
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  client.release();
}
```

**Errors**: Rejects with a connection timeout error if no pool connection is available
within `PG_POOL_CONN_TIMEOUT_MS` (default 5000 ms).

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | (required) | PostgreSQL connection string — `postgres://user:pass@host:port/db` |
| `PG_POOL_MAX` | `20` | Maximum connections in the pool |
| `PG_POOL_MIN` | `2` | Minimum idle connections kept alive |
| `PG_POOL_IDLE_TIMEOUT_MS` | `30000` | Close idle connections after this many ms |
| `PG_POOL_CONN_TIMEOUT_MS` | `5000` | Reject acquire attempt if no connection within this many ms |

---

## Constraints

- `DATABASE_URL` MUST be set before the module is first imported; the pool is created
  at module load time. A missing `DATABASE_URL` will throw synchronously at startup.
- `PG_POOL_MAX` MUST be ≤ PostgreSQL `max_connections` minus headroom for admin sessions.
  The default `20` assumes `max_connections = 100`.
- Callers MUST NOT hold a `getClient()` client across `await` boundaries that could
  time out — always wrap in `try/finally`.
