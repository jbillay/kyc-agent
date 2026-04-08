# EPIC: Infrastructure & DevOps Setup

> GitHub Issue: [#1](https://github.com/jbillay/kyc-agent/issues/1)
> Milestone: Phase 1 — Foundation
> Labels: `epic`, `devops`

## Overview

Set up the complete development and deployment infrastructure for the KYC Agent platform. This epic delivers the foundational layer that all subsequent epics build upon — a single `docker-compose up` command that brings up the entire stack.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #2 | Docker Compose stack with all infrastructure services | M | Critical | `docker-compose/` |
| #3 | PostgreSQL database schema and migration system | M | Critical | `database/` |
| #4 | Backend project scaffold (Fastify) | M | Critical | `backend-scaffold/` |
| #5 | Frontend project scaffold (Vue.js 3 + Vite) | M | Critical | `frontend-scaffold/` |
| #6 | MinIO document storage service | S | High | `minio-storage/` |

## Dependency Map

```
#2 Docker Compose ──────────────────────────────────────┐
   ├── #3 Database Schema (needs PostgreSQL running)     │
   ├── #4 Backend Scaffold (needs DB, Redis, MinIO)      │ All depend on
   ├── #5 Frontend Scaffold (needs API server running)   │ Docker Compose
   └── #6 MinIO Storage (needs MinIO + backend)          │
                                                         │
Recommended implementation order:                        │
  1. #2 Docker Compose                                   │
  2. #3 Database Schema  (parallel with #4)              │
  3. #4 Backend Scaffold (parallel with #3)              │
  4. #6 MinIO Storage    (after #4)                      │
  5. #5 Frontend Scaffold (after #4)                     │
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 2.1 — High-Level Architecture (Docker Compose stack diagram)
- Section 10 — Deployment (Docker Compose configuration, hardware requirements)
- Section 11 — Project Structure (directory layout)
- Section 9.1 — Database Schema Overview

## Infrastructure Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| postgres | `postgres:16` | 5432 | Primary database (cases, events, fragments) |
| redis | `redis:7-alpine` | 6379 | BullMQ job queue + pub/sub for WebSocket |
| minio | `minio/minio` | 9000, 9001 | S3-compatible document storage |
| ollama | `ollama/ollama` | 11434 | Local LLM inference runtime |
| api | Custom (Fastify) | 4000 | REST API + WebSocket server |
| agent-worker | Custom (Node.js) | — | BullMQ consumer (2 replicas) |
| screening-sync | Custom (Node.js) | — | Periodic sanctions list updater |
| frontend | Custom (Vue.js) | 3000 | SPA served via Vite/nginx |

## Definition of Done

- [ ] `docker-compose up` starts all 8 services with zero manual intervention
- [ ] Database is initialized with full schema on first start
- [ ] Backend responds to `GET /api/v1/admin/system/health` with 200
- [ ] Frontend loads at `http://localhost:3000` and shows a shell layout
- [ ] MinIO `documents` bucket exists and accepts uploads
- [ ] Ollama is reachable and can pull models
- [ ] `docker-compose down -v` cleanly tears everything down
- [ ] All environment variables are documented in `.env.example`
