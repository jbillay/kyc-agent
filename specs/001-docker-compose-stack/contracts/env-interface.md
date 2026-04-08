# Contract: Environment Variable Interface

**Feature**: Docker Compose Stack | **Date**: 2026-04-08

This contract defines the complete `.env` interface — every variable the compose stack
reads, its type, default, and whether it is safe to leave at default in development.

## Contract Rules

- All variables are OPTIONAL. Docker Compose applies inline defaults when absent.
- Variables marked **⚠ Change in production** MUST be overridden before any deployment
  where services are accessible beyond localhost.
- `_HOST` variables control the network interface binding for the corresponding port.
  Set to `0.0.0.0` only when remote access is explicitly required.

## Complete Variable Reference

```env
# ─── PostgreSQL ────────────────────────────────────────────────────────────────
PG_USER=kyc
PG_PASSWORD=kyc                    # ⚠ Change in production
PG_DB=kycagent
PG_HOST=127.0.0.1                  # Binding address — set 0.0.0.0 for remote access
PG_PORT=5432

# ─── Redis ─────────────────────────────────────────────────────────────────────
REDIS_HOST=127.0.0.1
REDIS_PORT=6379

# ─── MinIO ─────────────────────────────────────────────────────────────────────
MINIO_ACCESS_KEY=minioadmin        # ⚠ Change in production
MINIO_SECRET_KEY=minioadmin        # ⚠ Change in production
MINIO_HOST=127.0.0.1
MINIO_API_PORT=9000
MINIO_CONSOLE_HOST=127.0.0.1
MINIO_CONSOLE_PORT=9001

# ─── Ollama ────────────────────────────────────────────────────────────────────
OLLAMA_HOST=127.0.0.1
OLLAMA_PORT=11434

# ─── API Server ────────────────────────────────────────────────────────────────
API_HOST=127.0.0.1
API_PORT=4000
JWT_SECRET=change-me-in-production # ⚠ Change in production
NODE_ENV=development               # Set to "production" for prod deployments

# ─── Frontend ──────────────────────────────────────────────────────────────────
FRONTEND_HOST=127.0.0.1
FRONTEND_PORT=3000

# ─── Agent Workers ─────────────────────────────────────────────────────────────
AGENT_WORKER_REPLICAS=2            # Number of parallel agent-worker containers
```

## Internal Service URLs (not in .env — resolved by Docker DNS)

These connection strings are hardcoded to Docker service names inside the compose file.
They are not overridable via `.env` and do not appear in `.env.example`.

| Variable | Value (internal) | Used By |
|----------|-----------------|---------|
| `DATABASE_URL` | `postgresql://${PG_USER}:${PG_PASSWORD}@postgres:5432/${PG_DB}` | api, agent-worker, screening-sync |
| `REDIS_URL` | `redis://redis:6379` | api, agent-worker |
| `MINIO_ENDPOINT` | `minio` | api, agent-worker |
| `OLLAMA_BASE_URL` | `http://ollama:11434` | agent-worker |

## Health Check Endpoints

| Service | Health Check Command | Interval | Retries |
|---------|---------------------|----------|---------|
| postgres | `pg_isready -U ${PG_USER} -d ${PG_DB}` | 5s | 5 |
| redis | `redis-cli ping` | 5s | 5 |
| api | `wget -q -O- http://localhost:4000/health` | 10s | 3 |

The `api` health check is informational only — no services depend on it via
`condition: service_healthy`. It allows operators to verify application readiness
independently from infrastructure readiness.
