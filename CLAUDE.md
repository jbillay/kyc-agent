# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

KYC Agent is an agentic AI platform that automates Know Your Customer (KYC) processes for regulated financial institutions. AI agents execute entire KYC cases — entity resolution, ownership tracing, sanctions/PEP screening, risk assessment — with humans performing QA on the output.

**Key design constraints:**
- LLM-agnostic: defaults to open-source models via Ollama; no commercial API dependency
- Standalone: entire stack runs from `docker-compose up`; no external cloud services required
- Data sovereign: all data stays within the deployment boundary
- Auditable: every agent action, LLM call, and decision is an immutable event (append-only `decision_events` table)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vue.js 3 (Composition API) + JavaScript, Pinia, Vue Router, Vue Flow, PrimeVue/Naive UI, Vite |
| API | Fastify with JSON Schema validation, Socket.io for WebSocket |
| Backend | Node.js (JavaScript), JSDoc for types, Joi/Zod for runtime validation |
| Job Queue | BullMQ (Redis-backed) for agent execution |
| Database | PostgreSQL 16 (JSONB for agent outputs, append-only event store) |
| Document Storage | MinIO (S3-compatible) |
| LLM Runtime | Ollama (default), pluggable providers (vLLM, OpenAI-compatible, Anthropic, OpenAI) |
| Deployment | Docker Compose |

## Commands

```bash
# Start the full stack
docker-compose up

# Start with rebuild
docker-compose up --build

# Start specific services
docker-compose up postgres redis ollama

# Run backend
cd backend && npm install && npm start

# Run frontend
cd frontend && npm install && npm run dev

# Run tests (backend)
cd backend && npm test

# Run a single test file
cd backend && npx jest path/to/test.js

# Run frontend tests
cd frontend && npm test
```

## Architecture (6 Layers)

The system is layered bottom-up. Each layer only depends on layers below it.

### Layer 1: LLM Abstraction (`backend/src/llm/`)
Every LLM call goes through `llm-service.js`. No agent calls an LLM directly. Providers implement a common `LLMProvider` interface (`complete`, `isAvailable`, `listModels`). Task-based model routing maps `LLMTaskType` (reasoning, extraction, screening, classification, summarization) to specific models per provider via `config/llm.yaml`. Prompt adapters handle model-specific formatting.

### Layer 2: Data Integration (`backend/src/data-sources/`)
Abstracts external data behind provider interfaces. Three categories:
- **Registry** (`registry/`): Companies House (UK), SEC EDGAR (US) — `RegistryProvider` interface
- **Screening** (`screening/`): OFAC SDN, UK HMT, UN, EU sanctions lists — locally cached, fuzzy-matched
- **Media** (`media/`): Adverse media via news search APIs + LLM relevance analysis

All responses are cached in PostgreSQL (`data_source_cache` table) with query hash + TTL for audit reproducibility.

### Layer 3: Agent Framework (`backend/src/agents/`)
Team model with specialized agents coordinated by an **Orchestrator** (`orchestrator.js`). Agents extend `BaseAgent` and execute sequential steps, each producing **Decision Fragments** — the core audit unit linking decisions to evidence and LLM reasoning.

**Agent pipeline (state machine):**
```
CREATED → ENTITY_RESOLUTION → [PARALLEL: ownership-ubo + screening] → RISK_ASSESSMENT → QA_OR_REVIEW → PENDING_HUMAN_REVIEW → APPROVED/REJECTED/ESCALATED
```

Six specialized agents:
1. **Entity Resolution** — resolves client to verified registry entity
2. **Ownership & UBO** — traces ownership chains, identifies UBOs (25% threshold)
3. **Screening** — sanctions, PEP, adverse media screening with LLM-based hit evaluation
4. **Document Analysis** — classifies docs, extracts data, cross-references registry
5. **Risk Assessment** — applies rule engine + LLM analysis, generates risk narrative
6. **QA** — automated QA for low-risk/high-confidence cases

Agents run as BullMQ jobs in `backend/src/workers/agent-worker.js` (2 replicas by default).

### Layer 4: Core Services (`backend/src/services/`)
- `case-management.js` — case lifecycle and state machine
- `event-store.js` — append-only decision event stream (PostgreSQL rules prevent UPDATE/DELETE)
- `rule-engine.js` — configurable risk scoring from `config/risk-rules.yaml`
- `document-service.js` — MinIO file management
- `auth-service.js` — JWT-based RBAC (analyst, senior_analyst, compliance_officer, admin)

### Layer 5: API (`backend/src/api/`)
Fastify REST endpoints: `/api/v1/cases`, `/api/v1/review`, `/api/v1/config`, `/api/v1/admin`, `/api/v1/audit`. Socket.io pushes real-time events (case state changes, agent progress, fragment additions).

### Layer 6: Frontend (`frontend/src/`)
Vue.js 3 SPA. Key views: Dashboard (Kanban), Case Detail (tabbed: entity, ownership tree, screening, documents, risk, audit trail), Review Queue, Config Admin.

## Key Patterns

- **Decision Fragments**: Every agent decision has type, confidence (0-100), evidence with data sources, and review status. Fragment types are prefixed by domain (e.g., `sanctions_clear`, `ubo_identified`, `risk_factor_identified`). Fragments can be `auto_approved`, `pending_review`, or overridden by humans.
- **Append-only event store**: The `decision_events` table uses PostgreSQL rules to prevent updates/deletes. All agent activity is reconstructable from events.
- **Data source caching**: External API responses are cached by `(provider, query_hash, fetched_at)` so cases can prove what data was available at decision time.
- **Model routing by task type**: Different LLM tasks (reasoning vs extraction vs classification) route to different models. Configuration lives in `config/llm.yaml`.

## Configuration Files

- `config/llm.yaml` — LLM providers, model routing per task type, retry settings
- `config/risk-rules.yaml` — country risk, industry risk, ownership complexity, screening risk, thresholds, review routing
- `config/data-sources.yaml` — registry and screening source configuration
- `config/screening-sources.yaml` — sanctions list URLs and update schedules

## Database

PostgreSQL with 7 core tables: `cases`, `agent_results`, `decision_fragments`, `decision_events`, `documents`, `screening_lists`, `screening_entries`, `users`. Schema init is in `backend/db/init.sql`. The `decision_events` table is append-only (enforced by PostgreSQL rules).

## Docker Services

| Service | Port | Purpose |
|---------|------|---------|
| frontend | 3000 | Vue.js SPA |
| api | 4000 | Fastify API + WebSocket |
| agent-worker | - | BullMQ consumer (2 replicas) |
| screening-sync | - | Periodic sanctions list updater |
| postgres | 5432 | Primary database |
| redis | 6379 | Job queue + pubsub |
| minio | 9000/9001 | Document storage |
| ollama | 11434 | LLM inference |

## MVP Phases

- **Phase 1 (Foundation)**: Docker setup, LLM abstraction + Ollama, Companies House integration, Entity Resolution Agent, OFAC/HMT screening, basic frontend
- **Phase 2 (Intelligence)**: Ownership/UBO agent, adverse media, document analysis, risk assessment + narrative, ownership tree viz, WebSocket updates
- **Phase 3 (Review & Polish)**: QA agent, human review workflow, audit trail export, config UI, auth/RBAC, dashboard analytics
