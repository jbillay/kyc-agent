# Implementation Plan: Data Source Response Caching and Versioning

**Branch**: `013-data-source-caching` | **Date**: 2026-04-26 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/013-data-source-caching/spec.md`

## Summary

Implement a transparent PostgreSQL-backed cache layer for all external data source responses so that KYC decisions can prove exactly what data was available at decision time. The cache wraps any `RegistryProvider` or `ScreeningProvider` method call, looks up a SHA-256-keyed entry in the `data_source_cache` table before hitting the external source, stores every response with a configurable per-provider TTL, and never deletes entries (audit-preserving, append-only). A companion `withCache` wrapper makes the layer transparent to callers.

## Technical Context

**Language/Version**: Node.js >= 22.0.0 — JavaScript (CommonJS, `'use strict'`)  
**Primary Dependencies**: `pg` (via `backend/db/connection.js` shared pool), `crypto` (built-in Node.js SHA-256)  
**Storage**: PostgreSQL 16 — `data_source_cache` table already exists in `backend/db/init.sql`  
**Testing**: Jest 29 — tests root at `tests/backend/`; run via `cd backend && npm test`  
**Target Platform**: Linux server (Docker container), `docker-compose up`  
**Project Type**: Backend library module — Layer 2 (Data Integration)  
**Performance Goals**: Cache lookups < 50ms (SC-001)  
**Constraints**: Append-only (entries never deleted); data sovereignty (all cached in local PostgreSQL)  
**Scale/Scope**: One cache entry per external data fetch; unbounded growth by design; no archiving in scope

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Auditability First | ✅ PASS | Cache entries are append-only by design; entries are never deleted; `case_id` links each fetch to the triggering case; `fetched_at` + `expires_at` allow reconstruction of what data was available at any historical point. This feature directly implements the constitution's mandate: "Audit reproducibility MUST be preserved by caching external data source responses in PostgreSQL (`data_source_cache`) keyed by `(provider, query_hash, fetched_at)`." |
| II. LLM-Agnostic Provider Interface | ✅ N/A | This feature does not touch the LLM layer. |
| III. Strict Layered Architecture | ✅ PASS | `cache.js` and `cached-provider.js` live in Layer 2 (Data Integration). They depend only on the shared DB pool (`backend/db/connection.js`, shared infrastructure) and wrap Layer 2 provider interfaces. No upward dependencies. |
| IV. Data Sovereignty | ✅ PASS | All cached responses remain in the local PostgreSQL instance. No data egress introduced. |
| V. Configuration-Driven | ✅ PASS | Per-provider TTL values come from `config/data-sources.yaml` (`cache_ttl_hours`). No TTL values are hardcoded as compliance logic. Default 24h fallback is a safe operational default, not a compliance threshold. |

**Post-Phase 1 re-check**: No new dependencies or architectural violations introduced by the design. Passed.

## Project Structure

### Documentation (this feature)

```text
specs/013-data-source-caching/
├── plan.md              ← this file
├── research.md          ← Phase 0 output
├── data-model.md        ← Phase 1 output
├── contracts/           ← Phase 1 output
│   ├── data-source-cache.md
│   └── cached-provider.md
└── tasks.md             ← Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
backend/
├── src/
│   └── data-sources/
│       ├── cache.js                  # IMPLEMENT — DataSourceCache class (currently TODO stub)
│       └── cached-provider.js        # CREATE — withCache / withCacheScreening wrappers
└── db/
    └── init.sql                      # READ-ONLY — data_source_cache table already defined

config/
└── data-sources.yaml                 # UPDATE — add cache_ttl_hours for screening providers

tests/
└── backend/
    └── data-sources/
        ├── cache.test.js             # CREATE — 10 unit test scenarios
        └── cached-provider.test.js  # CREATE — withCache / withCacheScreening unit tests
```

**Structure Decision**: Web application layout (Option 2). Backend-only change; no frontend or API layer touched. The cache module lives entirely within `backend/src/data-sources/` (Layer 2) with tests in `tests/backend/data-sources/`.

## Complexity Tracking

> No Constitution Check violations — table omitted.
