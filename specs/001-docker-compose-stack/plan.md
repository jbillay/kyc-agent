# Implementation Plan: Docker Compose Stack

**Branch**: `001-docker-compose-stack` | **Date**: 2026-04-08 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/001-docker-compose-stack/spec.md`

## Summary

Configure a complete Docker Compose stack that brings up all 8 KYC Agent service categories
from a single `docker-compose up` command with zero external dependencies. The base compose
file is production-safe with localhost-default port bindings and on-failure restart policies.
A separate `docker-compose.override.yml` provides hot-reload volume mounts for development.
PostgreSQL is schema-initialized on first start; MinIO bucket creation is handled by the API
server on boot.

## Technical Context

**Language/Version**: Docker Compose V2 YAML (schema 3.8), Node.js 20-alpine (API / workers),
Vue.js 3 + Vite (frontend)
**Primary Dependencies**: postgres:16, redis:7-alpine, minio/minio, ollama/ollama,
node:20-alpine base images
**Storage**: 4 named Docker volumes — pgdata, redisdata, miniodata, ollamadata
**Testing**: Shell-based acceptance tests (up/down cycle, connectivity probes, persistence
round-trip); no automated test framework for compose itself
**Target Platform**: Linux (primary deployment), macOS and Windows via Docker Desktop
**Project Type**: Infrastructure configuration (docker-compose files, Dockerfiles,
environment templates)
**Performance Goals**: Cold start < 5 min (excluding LLM model downloads); warm start < 30s
**Constraints**: Localhost port binding by default (overridable); on-failure restart for app
services; unless-stopped for infra services; zero external network calls for core function
**Scale/Scope**: 8 service categories; 2 agent-worker replicas by default; single node

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Gate | Status | Notes |
|-----------|------|--------|-------|
| I. Auditability First | `init.sql` mount establishes the append-only event store schema | ✅ Pass | PostgreSQL rules enforcing append-only on `decision_events` must be in `init.sql` |
| II. LLM-Agnostic | Ollama is the default provider; `OLLAMA_BASE_URL` injected into agent-worker | ✅ Pass | `LLM_CONFIG_PATH` must be mounted into agent-worker container |
| III. Layered Architecture | Services map to architectural layers; no cross-layer networking shortcuts | ✅ Pass | Frontend calls API only; agents never call frontend |
| IV. Data Sovereignty | This feature IS the standalone deployment — no external services | ✅ Pass | Core mandate directly implemented here |
| V. Config-Driven Compliance | Config YAML files mounted into agent-worker via volume | ✅ Pass | `config/` directory must be mounted at `/app/config` |

**All gates pass. No violations to justify.**

*Post-design re-check*: All principles hold after Phase 1 design. The override file introduces
source volume mounts in development only — no sovereignty concern as it is local code, not
external services.

## Project Structure

```text
# Repository root — infrastructure files created by this feature
docker-compose.yaml              # Base compose (production-safe)
docker-compose.override.yml      # Dev overlay (hot-reload, volume mounts)
.env.example                     # Complete documented variable reference

backend/
├── Dockerfile                   # Shared image for api, agent-worker, screening-sync
└── db/
    └── init.sql                 # PostgreSQL schema initialization (mounted on first start)

frontend/
└── Dockerfile                   # Vue.js 3 + Vite build image
```

**Structure Decision**: Repository-root infrastructure files with per-service Dockerfile in
each service subdirectory. No monorepo tooling needed; Docker Compose resolves build contexts.

## Complexity Tracking

> No constitution violations to justify.
