# Research: Fastify Backend Scaffold

**Phase**: 0 — Research  
**Branch**: `003-fastify-backend-scaffold`  
**Date**: 2026-04-09

## Existing Codebase State

**Decision**: The `backend/` directory already exists with a partial implementation. The plan must update it to match the spec rather than create it from scratch.

**Rationale**: Prior work (epic-01 feature 002 — postgres schema & migrations) established the backend skeleton. The existing code is functional for that scope but does not satisfy the Fastify scaffold spec requirements.

**Delta — what already exists:**

| Artefact | Status | Notes |
|----------|--------|-------|
| `backend/package.json` | Needs update | Fastify v4 → v5; missing jest, dotenv, @fastify/multipart, socket.io, js-yaml; wrong node-pg-migrate version; wrong dev script |
| `backend/src/index.js` | Needs rewrite | No CORS, no error handler, no graceful shutdown, no env-configurable port, no `buildServer` export, MinIO init is premature for scaffold |
| `backend/src/api/routes/health.js` | Needs update | Wrong path (`/health` → `/api/v1/admin/system/health`), missing uptime/timestamp fields |
| `backend/src/workers/agent-worker.js` | Exists | Stub — keep as-is |
| `backend/src/workers/screening-sync.js` | Exists | Stub — keep as-is |
| `backend/Dockerfile` | Missing | Must create |
| `backend/.dockerignore` | Missing | Must create |
| `backend/jsconfig.json` | Missing | Must create |
| Directory skeleton | Partial | Most `src/` subdirectories and stub files are missing |

---

## Research Finding 1: Fastify v4 → v5 Migration

**Decision**: Upgrade to Fastify v5.x (as specified).

**Rationale**: Fastify v5 is the current stable release and what the spec targets. Key breaking changes relevant to this scaffold:

- `fastify()` call is unchanged; options API is the same
- Plugin registration via `app.register()` is unchanged
- `setErrorHandler` signature is unchanged
- Logger interface is unchanged (still pino under the hood)
- `@fastify/cors` peer-requires Fastify v4+ (v10 supports Fastify v5)
- `@fastify/websocket` v11 targets Fastify v5

**Alternatives considered**: Stay on v4 — rejected because spec explicitly requires v5 and `@fastify/websocket` v11.

---

## Research Finding 2: `buildServer` Factory Pattern for Testability

**Decision**: Export a `buildServer()` async factory from `src/index.js`; keep `start()` as a separate top-level call only run when the file is the entry point.

**Rationale**: Jest tests use `buildServer()` to get a Fastify instance and call `app.inject()` for HTTP assertions without binding to a port. This avoids `EADDRINUSE` flakiness in test runs and follows the Fastify documentation's recommended test pattern.

```js
// src/index.js
async function buildServer() { ... }
async function start() { const app = await buildServer(); await app.listen(...); }

if (require.main === module) start();
module.exports = { buildServer };
```

**Alternatives considered**: Binding the server in tests and using a random port — rejected because it adds network overhead and `app.inject()` is simpler and faster.

---

## Research Finding 3: Graceful Shutdown with Force-Exit Timeout

**Decision**: Implement a 10-second drain window using `setTimeout` with an `unref()` call; force `process.exit(1)` after the window if `app.close()` has not resolved.

**Rationale**: `app.close()` in Fastify closes the HTTP server (stops accepting new connections) and waits for in-flight requests to complete. If a request hangs beyond the timeout, the `setTimeout` callback fires and force-exits. Using `.unref()` ensures the timer does not prevent Node.js from exiting normally if `app.close()` resolves before the timeout.

```js
const shutdown = async (signal) => {
  app.log.info(`${signal} received — draining...`);
  const forceExit = setTimeout(() => {
    app.log.warn('Drain timeout exceeded — forcing exit');
    process.exit(1);
  }, 10_000).unref();
  await app.close();
  clearTimeout(forceExit);
  process.exit(0);
};
```

**Alternatives considered**: `process.exit(0)` immediately — rejected (unsafe, drops in-flight requests). Indefinite wait — rejected by clarification Q2.

---

## Research Finding 4: Jest + Fastify Testing Pattern

**Decision**: Use `app.inject()` for all HTTP assertions in Jest tests. No test server is bound to a port.

**Rationale**: `app.inject()` simulates HTTP requests through Fastify's routing internals without binding a socket. Tests are faster, portable, and never produce `EADDRINUSE` errors. Each test creates a fresh app instance via `buildServer()` and calls `app.close()` in `afterEach`.

```js
const { buildServer } = require('../../src/index');

let app;
beforeEach(async () => { app = await buildServer(); });
afterEach(async () => { await app.close(); });

test('health check returns 200', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/admin/system/health' });
  expect(res.statusCode).toBe(200);
  expect(JSON.parse(res.body)).toMatchObject({ status: 'ok' });
});
```

**Alternatives considered**: Supertest with `app.listen()` — rejected; adds complexity and port management overhead.

---

## Research Finding 5: Directory Skeleton Stub Convention

**Decision**: Each stub file contains exactly: `'use strict';\n\n// TODO: implement\n` and exports nothing. Files are created but not registered with the server in this scaffold.

**Rationale**: The spec requires all directories and stub files to exist so that future PRs can add implementation without `mkdir` noise. Empty stubs with a `'use strict'` header are valid CommonJS modules that will not throw when accidentally `require()`d.

**Alternatives considered**: Exporting an empty object — marginally safer but adds boilerplate with no benefit at scaffold stage. Rejected for simplicity.
