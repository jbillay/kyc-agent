# HTTP API Contract: Backend Scaffold

**Version**: 0.1.0  
**Base URL**: `http://localhost:4000`  
**Branch**: `003-fastify-backend-scaffold`

---

## Endpoint: Health Check

```
GET /api/v1/admin/system/health
```

**Auth required**: No  
**Purpose**: Liveness probe for Docker healthchecks, orchestrators, and operator diagnostics.

### Response — 200 OK

```json
{
  "status": "ok",
  "timestamp": "2026-04-09T12:00:00.000Z",
  "uptime": 123.456
}
```

| Field | Type | Description |
|-------|------|-------------|
| `status` | `string` | Always `"ok"` when the server is alive |
| `timestamp` | `string` (ISO 8601) | UTC datetime of the response |
| `uptime` | `number` | Server process uptime in seconds |

---

## Standard Error Envelope

All non-2xx responses from any endpoint use this structure:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route GET:/api/v1/unknown not found",
    "stack": "Error: ...\n    at ..."
  }
}
```

| Field | Type | Always present | Description |
|-------|------|---------------|-------------|
| `error.code` | `string` | Yes | Machine-readable error code |
| `error.message` | `string` | Yes | Human-readable description |
| `error.stack` | `string` | Only in `development` | Stack trace for debugging |

### Error Codes

| Code | HTTP Status | When |
|------|-------------|------|
| `NOT_FOUND` | 404 | No matching route |
| `VALIDATION_ERROR` | 400 | Schema validation failure |
| `INTERNAL_ERROR` | 500 | Unhandled server error |

---

## CORS Policy

| Header | Value |
|--------|-------|
| `Access-Control-Allow-Origin` | Value of `CORS_ORIGIN` env var (default: `http://localhost:3000`) |
| `Access-Control-Allow-Credentials` | `true` |
| `Access-Control-Allow-Methods` | `GET, POST, PUT, PATCH, DELETE, OPTIONS` |

Requests from origins other than the configured `CORS_ORIGIN` receive no CORS headers and are blocked by the browser.
