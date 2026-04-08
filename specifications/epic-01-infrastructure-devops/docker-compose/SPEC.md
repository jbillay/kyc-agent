# Docker Compose Stack

> GitHub Issue: [#2](https://github.com/jbillay/kyc-agent/issues/2)
> Epic: Infrastructure & DevOps Setup (#1)
> Size: M (1-3 days) | Priority: Critical

## Context

The KYC Agent platform must run from a single `docker-compose up` command with zero external dependencies beyond Docker. This is a core design principle — data sovereignty requires the entire stack to be self-contained within the client's infrastructure.

## Requirements

### Functional

1. A single `docker-compose.yaml` at the project root starts all services
2. All services communicate over a shared Docker network
3. PostgreSQL is initialized with the database schema on first start (via `init.sql` mount)
4. MinIO creates a default `documents` bucket on first start
5. Ollama container is configured and can pull models on demand
6. All configuration is externalizable via a `.env` file
7. `docker-compose down -v` cleanly removes all data and volumes
8. README documents the setup process

### Non-Functional

- Cold start (first `docker-compose up`) completes in under 5 minutes (excluding model downloads)
- Warm start (subsequent `docker-compose up`) completes in under 30 seconds
- Minimum resource requirements: 16 GB RAM, 8 CPU cores, 50 GB disk

## Technical Design

### File: `docker-compose.yaml`

```yaml
version: '3.8'

services:
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    ports:
      - "${FRONTEND_PORT:-3000}:3000"
    environment:
      - VITE_API_URL=http://localhost:${API_PORT:-4000}
      - VITE_WS_URL=ws://localhost:${API_PORT:-4000}
    depends_on:
      - api

  api:
    build:
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "${API_PORT:-4000}:4000"
    environment:
      - DATABASE_URL=postgresql://${PG_USER:-kyc}:${PG_PASSWORD:-kyc}@postgres:5432/${PG_DB:-kycagent}
      - REDIS_URL=redis://redis:6379
      - MINIO_ENDPOINT=minio
      - MINIO_PORT=9000
      - MINIO_ACCESS_KEY=${MINIO_ACCESS_KEY:-minioadmin}
      - MINIO_SECRET_KEY=${MINIO_SECRET_KEY:-minioadmin}
      - JWT_SECRET=${JWT_SECRET:-change-me-in-production}
      - NODE_ENV=${NODE_ENV:-development}
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      minio:
        condition: service_started

  agent-worker:
    build:
      context: ./backend
      dockerfile: Dockerfile
    command: ["node", "src/workers/agent-worker.js"]
    environment:
      - DATABASE_URL=postgresql://${PG_USER:-kyc}:${PG_PASSWORD:-kyc}@postgres:5432/${PG_DB:-kycagent}
      - REDIS_URL=redis://redis:6379
      - MINIO_ENDPOINT=minio
      - MINIO_PORT=9000
      - LLM_CONFIG_PATH=/app/config/llm.yaml
      - OLLAMA_BASE_URL=http://ollama:11434
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      ollama:
        condition: service_started
    deploy:
      replicas: ${AGENT_WORKER_REPLICAS:-2}

  screening-sync:
    build:
      context: ./backend
      dockerfile: Dockerfile
    command: ["node", "src/workers/screening-sync.js"]
    environment:
      - DATABASE_URL=postgresql://${PG_USER:-kyc}:${PG_PASSWORD:-kyc}@postgres:5432/${PG_DB:-kycagent}

  postgres:
    image: postgres:16
    ports:
      - "${PG_PORT:-5432}:5432"
    environment:
      - POSTGRES_USER=${PG_USER:-kyc}
      - POSTGRES_PASSWORD=${PG_PASSWORD:-kyc}
      - POSTGRES_DB=${PG_DB:-kycagent}
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./backend/db/init.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${PG_USER:-kyc} -d ${PG_DB:-kycagent}"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports:
      - "${REDIS_PORT:-6379}:6379"
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5

  minio:
    image: minio/minio
    ports:
      - "${MINIO_API_PORT:-9000}:9000"
      - "${MINIO_CONSOLE_PORT:-9001}:9001"
    environment:
      - MINIO_ROOT_USER=${MINIO_ACCESS_KEY:-minioadmin}
      - MINIO_ROOT_PASSWORD=${MINIO_SECRET_KEY:-minioadmin}
    command: server /data --console-address ":9001"
    volumes:
      - miniodata:/data

  ollama:
    image: ollama/ollama
    ports:
      - "${OLLAMA_PORT:-11434}:11434"
    volumes:
      - ollamadata:/root/.ollama
    # GPU support (uncomment for NVIDIA GPU):
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]

volumes:
  pgdata:
  redisdata:
  miniodata:
  ollamadata:
```

### File: `.env.example`

```env
# PostgreSQL
PG_USER=kyc
PG_PASSWORD=kyc
PG_DB=kycagent
PG_PORT=5432

# Redis
REDIS_PORT=6379

# MinIO
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_API_PORT=9000
MINIO_CONSOLE_PORT=9001

# Ollama
OLLAMA_PORT=11434

# API Server
API_PORT=4000
JWT_SECRET=change-me-in-production
NODE_ENV=development

# Frontend
FRONTEND_PORT=3000

# Agent Workers
AGENT_WORKER_REPLICAS=2
```

### Health Checks

PostgreSQL and Redis include health checks so that dependent services (api, agent-worker) wait for them to be ready. This prevents startup race conditions.

### Network

All services use the default Docker Compose network. Service names (`postgres`, `redis`, `minio`, `ollama`) act as DNS hostnames within the network.

### Volumes

| Volume | Service | Purpose |
|--------|---------|---------|
| `pgdata` | postgres | Persistent database storage |
| `redisdata` | redis | Redis AOF/RDB persistence |
| `miniodata` | minio | Document file storage |
| `ollamadata` | ollama | Downloaded LLM model weights |

### MinIO Bucket Initialization

The `documents` bucket should be created by the API server on startup (see MinIO Storage spec #6). Alternatively, a one-time init container can be used:

```yaml
  minio-init:
    image: minio/mc
    depends_on:
      - minio
    entrypoint: >
      /bin/sh -c "
      sleep 5;
      mc alias set local http://minio:9000 minioadmin minioadmin;
      mc mb --ignore-existing local/documents;
      exit 0;
      "
```

## Acceptance Criteria

- [ ] `docker-compose up` starts all 8 services (postgres, redis, minio, ollama, api, agent-worker x2, screening-sync, frontend)
- [ ] All services are on a shared Docker network and can communicate by service name
- [ ] PostgreSQL is initialized with the database schema via `init.sql` on first start
- [ ] MinIO `documents` bucket exists after startup
- [ ] Ollama container is running and responds on port 11434
- [ ] `.env.example` documents all configurable variables
- [ ] `docker-compose down -v` cleanly removes all containers and volumes
- [ ] README.md includes setup instructions

## Dependencies

- **Depends on**: Nothing (this is the foundational story)
- **Blocks**: #3 (Database), #4 (Backend), #5 (Frontend), #6 (MinIO)

## Testing Strategy

1. **Clean start test**: `docker-compose down -v && docker-compose up -d` — verify all services reach healthy state
2. **Connectivity test**: From the `api` container, verify connections to postgres, redis, minio, ollama
3. **Persistence test**: Write data, restart containers, verify data persists
4. **Clean teardown test**: `docker-compose down -v` — verify no volumes or containers remain
5. **Port conflict test**: Verify `.env` overrides work for all exposed ports
