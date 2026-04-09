# Data Model: Fastify Backend Scaffold

**Phase**: 1 — Design  
**Branch**: `003-fastify-backend-scaffold`  
**Date**: 2026-04-09

> This feature introduces no database tables. The data model covers the runtime configuration schema and the two wire-format contracts exchanged with HTTP clients.

---

## Entity 1: Server Configuration

Resolved from environment variables at process startup. All fields have documented defaults; the server MUST NOT fail to start if any variable is absent.

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `PORT` | integer | `4000` | TCP port the server listens on |
| `HOST` | string | `'0.0.0.0'` | Bind address |
| `LOG_LEVEL` | string | `'info'` | Pino log level (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `CORS_ORIGIN` | string | `'http://localhost:3000'` | Single allowed CORS origin (credentials-enabled) |
| `NODE_ENV` | string | `'development'` | Controls stack trace exposure in error responses |

**Constraints:**
- `PORT` must parse to a valid integer; the server crashes on startup if unparseable (acceptable — operator error)
- `LOG_LEVEL` values outside Pino's accepted set default to `'info'` at the Pino level (library behaviour, not custom handling)

---

## Entity 2: Health Report

Returned by `GET /api/v1/admin/system/health`.

```
{
  status:    string   — always "ok" when the endpoint responds
  timestamp: string   — ISO 8601 UTC datetime of the response
  uptime:    number   — process uptime in seconds (float, Node.js process.uptime())
}
```

**Constraints:**
- `status` is a static string `"ok"`; the endpoint does not perform database or dependency checks in this scaffold
- `timestamp` is produced by `new Date().toISOString()`
- `uptime` is produced by `process.uptime()`

---

## Entity 3: Error Response

Standard envelope returned for all non-2xx responses.

```
{
  error: {
    code:     string   — machine-readable error code (e.g. "NOT_FOUND", "INTERNAL_ERROR")
    message:  string   — human-readable description
    stack?:   string   — present ONLY when NODE_ENV === "development"
  }
}
```

**Error code mapping:**

| HTTP Status | Code | Trigger |
|-------------|------|---------|
| 400 | `VALIDATION_ERROR` | Request body/params fail schema validation |
| 401 | `UNAUTHORIZED` | Missing or invalid JWT (future feature) |
| 403 | `FORBIDDEN` | Insufficient role (future feature) |
| 404 | `NOT_FOUND` | Route does not exist |
| 500 | `INTERNAL_ERROR` | Unhandled error in route handler |

**Constraints:**
- `stack` MUST NOT appear when `NODE_ENV !== 'development'`
- `code` defaults to `'INTERNAL_ERROR'` if the thrown error does not carry a `code` property
- `statusCode` defaults to `500` if the thrown error does not carry `statusCode`
