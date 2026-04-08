# EPIC: Configuration UI

> GitHub Issue: [#75](https://github.com/jbillay/kyc-agent/issues/75)
> Milestone: Phase 3 — Review & Polish
> Labels: `epic`, `config`

## Overview

Admin interface for managing the KYC Agent platform's runtime configuration: risk rules, LLM providers, data sources, users, and system health. This epic eliminates the need for administrators to edit YAML files directly by providing a web-based configuration UI with real-time validation, preview capabilities, and hot-reload support.

Configuration changes are a sensitive operation in a regulated KYC platform — every modification to risk rules or screening sources can affect case outcomes. All configuration changes are therefore logged as `config_change` events in the immutable event store, providing a full audit trail of who changed what and when.

The epic consists of two stories: a backend Configuration API that reads/writes YAML configuration files with validation and hot-reload, and a frontend admin interface with tabbed views for each configuration domain.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #76 | Configuration API endpoints | M | High | `configuration-api/` |
| #77 | Admin configuration views in frontend | L | High | `admin-config-views/` |

## Dependency Map

```
Configuration API (backend) ──────────────────────────┐
    (GET/PUT risk-rules, llm, data-sources,           │
     GET/POST/PATCH admin/users, system health/stats)  │
    │                                                  │
    └──► #77 Admin Configuration Views ────────────────┘
         (tabbed admin page: risk rules, LLM config,
          data sources, user management, system health)

Recommended implementation order:
  1. #76 Configuration API endpoints (backend foundation)
  2. #77 Admin configuration views (depends on config API for all data)
```

## External Dependencies

```
Infrastructure (#1):
  └── #3 Database             ← users table (CRUD for user management)

LLM Abstraction (#7):
  └── #8 LLM Service          ← isAvailable() for connection testing, model listing
  └── #12 YAML Config Loader  ← llm.yaml reading/writing, hot-reload mechanism

Data Integration (#13):
  └── #14 Data Source Provider ← data-sources.yaml config, screening list sync status

Agent Framework (#20):
  └── #25 Event Store          ← config_change events for audit trail

Risk Assessment (#56):
  └── #58 Rule Engine          ← risk-rules.yaml reading/writing, hot-reload

Authentication (#67):
  └── Auth Service             ← JWT authentication for all endpoints
  └── #70 RBAC Middleware      ← admin role required for config/user management

Frontend (#38):
  └── #5 Frontend Scaffold     ← Vue Router, Pinia, component library

Case Management API (#33):
  └── #36 WebSocket Events     ← optional: broadcast config change notifications
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 3.3 — Supported LLM Providers (provider list and configuration)
- Section 3.4 — Model Routing Configuration (`config/llm.yaml` structure)
- Section 6.4 — Rule Engine (`config/risk-rules.yaml` full schema)
- Section 6.5 — Authentication & Authorization (role hierarchy, admin permissions)
- Section 7.2 — Configuration API endpoints (GET/PUT for risk-rules, llm, data-sources)
- Section 7.2 — Admin/Audit API (user CRUD, system health, system stats)
- Section 8.2.4 — Configuration View (`/admin/config`)

## File Layout

```
backend/src/api/
├── config.js                    # Configuration API routes (/api/v1/config/*)
└── admin.js                     # Admin API routes (/api/v1/admin/*)

backend/src/services/
├── config-service.js            # Configuration read/write/validate/hot-reload
└── system-health-service.js     # Service health checks and system statistics

frontend/src/views/
└── ConfigView.vue               # /admin/config page with tab navigation

frontend/src/stores/
└── config.js                    # Pinia config store (risk rules, LLM, data sources, users)

frontend/src/components/config/
├── RiskRulesEditor.vue          # Risk rules form-based editor with preview
├── LlmConfigEditor.vue         # LLM provider/model configuration
├── DataSourcesEditor.vue       # Data source settings and sync controls
├── UserManagement.vue           # User list, create, edit, deactivate
└── SystemHealth.vue             # Service status, disk usage, queue stats

frontend/src/composables/
└── useConfig.js                 # Config composable (fetch, save, validate)
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Config storage | YAML files (not database) | Consistent with existing config approach; files are version-controllable and human-readable |
| Config hot-reload | Write to YAML, then trigger in-memory reload | Avoids service restart; changes take effect immediately |
| API key handling | Never return API keys in GET responses (masked/omitted) | Prevents accidental exposure via browser DevTools or logs |
| Config change audit | Log every change as `config_change` event in event store | Regulatory requirement: who changed what configuration and when |
| Form vs YAML editor | Form-based primary, CodeMirror as advanced alternative | Forms prevent syntax errors; YAML editor for power users |
| Validation approach | JSON Schema validation on API, preview before save on frontend | Two layers: API prevents invalid configs, frontend shows impact |
| User management | CRUD via admin API, not self-registration | Controlled access in regulated environment; admin provisions accounts |
| System health | Poll-based status checks | Simple, no additional infrastructure; health endpoints are lightweight |

## Configuration Domains

### Risk Rules (`config/risk-rules.yaml`)
- Country risk lists (high/medium risk countries with score additions)
- Industry risk codes and keywords (SIC codes, keywords, score additions)
- Ownership risk thresholds (layers, cross-border, nominee, no-UBO scores)
- Screening risk scores (sanctions hit, PEP, adverse media severity)
- Risk rating thresholds (low/medium/high/very_high score ranges)
- Review routing rules (QA agent eligibility, senior analyst escalation)

### LLM Configuration (`config/llm.yaml`)
- Default provider selection
- Provider connection settings (base URL, timeout, retry, API keys)
- Model routing per task type (reasoning, extraction, screening, classification, summarization)

### Data Sources (`config/data-sources.yaml` + `config/screening-sources.yaml`)
- Registry provider settings (Companies House API key, SEC EDGAR)
- Screening list sources (OFAC, UK HMT, UN, EU — URLs, update schedules)
- Screening list sync status and manual sync trigger

### User Management
- User list with role and active status
- Create new users (email, name, role, initial password)
- Edit user role (analyst, senior_analyst, compliance_officer, admin)
- Activate/deactivate users

### System Health
- Service connectivity (PostgreSQL, Redis, MinIO, Ollama)
- Disk usage and storage statistics
- BullMQ queue statistics (pending, active, completed, failed jobs)

## Definition of Done

- [ ] `GET /api/v1/config/risk-rules` returns current risk rules (parsed YAML)
- [ ] `PUT /api/v1/config/risk-rules` validates and updates risk rules with hot-reload
- [ ] `GET /api/v1/config/llm` returns LLM configuration (API keys redacted)
- [ ] `PUT /api/v1/config/llm` validates and updates LLM configuration with hot-reload
- [ ] `GET /api/v1/config/data-sources` returns data source configuration
- [ ] `PUT /api/v1/config/data-sources` validates and updates data source configuration
- [ ] `GET /api/v1/admin/users` returns user list (passwords excluded)
- [ ] `POST /api/v1/admin/users` creates new user with hashed password
- [ ] `PATCH /api/v1/admin/users/:id` updates user role/status
- [ ] `GET /api/v1/admin/system/health` returns service connectivity status
- [ ] `GET /api/v1/admin/system/stats` returns queue and storage statistics
- [ ] All config changes logged as `config_change` events in event store
- [ ] API keys never returned in GET responses
- [ ] All endpoints require admin role (RBAC enforced)
- [ ] All endpoints validated with Fastify JSON Schema
- [ ] Configuration page at `/admin/config` with 5 tabs
- [ ] Risk Rules tab: form editor with preview of rule changes before saving
- [ ] LLM Configuration tab: provider selection, model assignment, test connection button
- [ ] Data Sources tab: provider settings, sync status, manual sync trigger
- [ ] User Management tab: user list, create/edit/deactivate users
- [ ] System Health tab: service status indicators, disk usage, queue statistics
- [ ] Admin-only route guard on `/admin/config`
- [ ] Success/error feedback on all save operations
