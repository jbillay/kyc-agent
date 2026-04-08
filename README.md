# KYC Agent

Agentic AI platform that automates Know Your Customer (KYC) processes for regulated
financial institutions. AI agents execute entire KYC cases — entity resolution, ownership
tracing, sanctions/PEP screening, risk assessment — with humans performing QA on the output.

## Prerequisites

- **Docker Desktop 4.x+** (or Docker Engine 24+ with Compose V2)
- **16 GB RAM** minimum, **8 CPU cores**, **50 GB free disk**
- Git

## Quick Start

```bash
# 1. Clone the repository
git clone <repo-url>
cd kyc-agent

# 2. (Optional) Configure environment
cp .env.example .env
# Edit .env to override ports, credentials, or replica counts

# 3. Start the full stack
docker-compose up

# Access the platform:
#   Frontend:      http://localhost:3000
#   API:           http://localhost:4000
#   MinIO console: http://localhost:9001  (minioadmin / minioadmin)
#   Ollama:        http://localhost:11434
```

## Pull an LLM Model

The platform defaults to Mistral. Pull it after the stack is running:

```bash
docker-compose exec ollama ollama pull mistral
```

Model weights are stored in the `ollamadata` volume and survive container restarts.

## Environment Configuration

All configuration is managed via `.env`. Copy `.env.example` to `.env` and edit:

```bash
cp .env.example .env
```

Key variables:

| Variable | Default | Notes |
|----------|---------|-------|
| `PG_PASSWORD` | `kyc` | ⚠ Change in production |
| `MINIO_ACCESS_KEY` | `minioadmin` | ⚠ Change in production |
| `MINIO_SECRET_KEY` | `minioadmin` | ⚠ Change in production |
| `JWT_SECRET` | `change-me-in-production` | ⚠ Change in production |
| `AGENT_WORKER_REPLICAS` | `2` | Parallel agent workers |
| `API_PORT` | `4000` | Override if port conflicts |

**Port binding**: All services bind to `127.0.0.1` (localhost) by default. To allow
remote access, set the corresponding `_HOST` variable to `0.0.0.0` — but you **must**
also change the default credentials before doing so.

## Development Workflow

The `docker-compose.override.yml` file is automatically merged when you run
`docker-compose up`. It adds:

- **Hot-reload** for backend and workers (nodemon watches `src/`)
- **Vite HMR** for the frontend (changes reflect instantly in the browser)

No rebuild needed after code changes. To force a full image rebuild:

```bash
docker-compose up --build
```

To skip the override file (production mode locally):

```bash
docker-compose -f docker-compose.yaml up
```

## Services

| Service | Port | Purpose |
|---------|------|---------|
| Frontend | 3000 | Vue.js 3 SPA |
| API | 4000 | Fastify REST API + WebSocket |
| Agent Worker | — | BullMQ job consumers (2 replicas) |
| Screening Sync | — | Periodic sanctions list updater |
| PostgreSQL | 5432 | Primary database |
| Redis | 6379 | Job queue + pub/sub |
| MinIO | 9000 / 9001 | Document storage + console |
| Ollama | 11434 | LLM inference |

## Teardown

```bash
# Stop containers (preserves volumes)
docker-compose down

# Stop and remove all data (DESTRUCTIVE — cannot be undone)
docker-compose down -v
```

> ⚠ `docker-compose down -v` permanently deletes all database records, uploaded
> documents, and downloaded LLM model weights.

## Architecture

See [kyc-agent-architecture.md](kyc-agent-architecture.md) for the full system design,
including the 6-layer architecture, agent pipeline, and data model.
