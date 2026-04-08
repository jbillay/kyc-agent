# Data Model: Docker Compose Stack

**Branch**: `001-docker-compose-stack` | **Date**: 2026-04-08

This feature is infrastructure configuration. The "data model" is the environment variable
schema, service topology, and volume layout — the inputs and outputs that other features
depend on.

---

## Environment Variable Schema

All variables are overridable via `.env`. Defaults shown below are applied by Docker Compose
when the variable is absent.

### PostgreSQL

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `PG_USER` | `kyc` | string | PostgreSQL username |
| `PG_PASSWORD` | `kyc` | string | PostgreSQL password (change in production) |
| `PG_DB` | `kycagent` | string | PostgreSQL database name |
| `PG_HOST` | `127.0.0.1` | string | Host binding address for port 5432 |
| `PG_PORT` | `5432` | int | Host-side port for PostgreSQL |

### Redis

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `REDIS_HOST` | `127.0.0.1` | string | Host binding address for port 6379 |
| `REDIS_PORT` | `6379` | int | Host-side port for Redis |

### MinIO

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `MINIO_ACCESS_KEY` | `minioadmin` | string | MinIO root username (change in production) |
| `MINIO_SECRET_KEY` | `minioadmin` | string | MinIO root password (change in production) |
| `MINIO_HOST` | `127.0.0.1` | string | Host binding address for API port 9000 |
| `MINIO_API_PORT` | `9000` | int | Host-side port for MinIO S3 API |
| `MINIO_CONSOLE_HOST` | `127.0.0.1` | string | Host binding address for console port 9001 |
| `MINIO_CONSOLE_PORT` | `9001` | int | Host-side port for MinIO web console |

### Ollama

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `OLLAMA_HOST` | `127.0.0.1` | string | Host binding address for port 11434 |
| `OLLAMA_PORT` | `11434` | int | Host-side port for Ollama inference API |

### API Server

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `API_HOST` | `127.0.0.1` | string | Host binding address for port 4000 |
| `API_PORT` | `4000` | int | Host-side port for Fastify API + WebSocket |
| `JWT_SECRET` | `change-me-in-production` | string | JWT signing secret (MUST change in production) |
| `NODE_ENV` | `development` | enum | `development` or `production` |

### Frontend

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `FRONTEND_HOST` | `127.0.0.1` | string | Host binding address for port 3000 |
| `FRONTEND_PORT` | `3000` | int | Host-side port for Vue.js SPA |

### Agent Workers

| Variable | Default | Type | Description |
|----------|---------|------|-------------|
| `AGENT_WORKER_REPLICAS` | `2` | int | Number of agent-worker container replicas |

---

## Service Topology

```
frontend ──────────────────────────────────────────► api
                                                      │
                          ┌───────────────────────────┤
                          │                           │
                          ▼                           ▼
                    agent-worker               screening-sync
                          │                           │
              ┌───────────┼────────────┐             │
              ▼           ▼            ▼             ▼
          postgres       redis        minio       postgres
              ▲           ▲
              │           │
           ollama      (pubsub)
```

### Dependency Graph (startup ordering)

| Service | Depends On (health) | Depends On (started) |
|---------|---------------------|----------------------|
| api | postgres, redis | minio |
| agent-worker | postgres, redis | ollama |
| screening-sync | postgres | — |
| frontend | — | api |

---

## Volume Schema

| Volume Name | Mounted In | Container Path | Purpose |
|-------------|------------|----------------|---------|
| `pgdata` | postgres | `/var/lib/postgresql/data` | PostgreSQL data files |
| `redisdata` | redis | `/data` | Redis AOF/RDB persistence files |
| `miniodata` | minio | `/data` | Object store files (documents) |
| `ollamadata` | ollama | `/root/.ollama` | Downloaded LLM model weights |

---

## Init Script: `backend/db/init.sql`

Executed once by PostgreSQL on first container start (when `pgdata` volume is empty).
Must define all 7 core tables:

| Table | Purpose |
|-------|---------|
| `cases` | KYC case records |
| `agent_results` | Per-agent execution outputs |
| `decision_fragments` | Atomic audit units (type, confidence, evidence, review status) |
| `decision_events` | Append-only event stream (PostgreSQL rules block UPDATE/DELETE) |
| `documents` | Document metadata (file stored in MinIO) |
| `screening_lists` | Screening list metadata (OFAC, HMT, UN, EU) |
| `screening_entries` | Individual screening entries (name, type, aliases) |
| `users` | Platform users with RBAC roles |

The `decision_events` table MUST include PostgreSQL rules:
```sql
CREATE RULE no_update_decision_events AS ON UPDATE TO decision_events DO INSTEAD NOTHING;
CREATE RULE no_delete_decision_events AS ON DELETE TO decision_events DO INSTEAD NOTHING;
```
