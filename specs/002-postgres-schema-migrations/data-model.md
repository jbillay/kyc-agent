# Data Model: PostgreSQL Database Schema & Migration System

**Branch**: `002-postgres-schema-migrations` | **Date**: 2026-04-08

This document is the authoritative column-level schema for all 9 tables. All column names,
types, constraints, and indexes are specified here. `init.sql` implements this exactly.

---

## Table 1: `users`

Stores platform users with RBAC roles. Referenced by all other tables that track who
performed an action.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `email` | `VARCHAR(255)` | NOT NULL, UNIQUE | |
| `name` | `VARCHAR(255)` | NOT NULL | |
| `role` | `VARCHAR(30)` | NOT NULL, CHECK IN `('analyst','senior_analyst','compliance_officer','admin')` | |
| `password_hash` | `VARCHAR(255)` | NOT NULL | bcrypt hash |
| `is_active` | `BOOLEAN` | NOT NULL, DEFAULT `true` | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `NOW()` | |
| `last_login_at` | `TIMESTAMPTZ` | nullable | Updated on login |

**Indexes**: none beyond PK + unique email constraint.

---

## Table 2: `cases`

Central KYC case record. Drives the agent pipeline state machine.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `client_name` | `VARCHAR(500)` | NOT NULL | |
| `client_type` | `VARCHAR(20)` | NOT NULL, CHECK IN `('corporate','individual')` | |
| `jurisdiction` | `VARCHAR(10)` | NOT NULL | ISO country code |
| `registration_number` | `VARCHAR(100)` | nullable | Companies House / SEC number |
| `additional_identifiers` | `JSONB` | DEFAULT `'{}'` | LEI, tax IDs, etc. |
| `state` | `VARCHAR(50)` | NOT NULL, DEFAULT `'CREATED'` | See state machine below |
| `dd_level` | `VARCHAR(20)` | NOT NULL, DEFAULT `'standard'`, CHECK IN `('simplified','standard','enhanced')` | Due diligence level |
| `risk_score` | `INTEGER` | CHECK 0–100, nullable | Set by risk assessment agent |
| `risk_rating` | `VARCHAR(20)` | CHECK IN `('low','medium','high','very_high')`, nullable | |
| `assigned_reviewer` | `UUID` | FK → `users(id)`, nullable | Human reviewer |
| `review_decision` | `VARCHAR(30)` | CHECK IN `('approved','rejected','escalated','additional_info')`, nullable | |
| `review_comment` | `TEXT` | nullable | |
| `reviewed_at` | `TIMESTAMPTZ` | nullable | |
| `source` | `VARCHAR(20)` | DEFAULT `'manual'`, CHECK IN `('api','manual','batch')` | How the case was created |
| `tags` | `TEXT[]` | nullable | Free-form labels |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `NOW()` | |
| `updated_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `NOW()` | |
| `completed_at` | `TIMESTAMPTZ` | nullable | Set when APPROVED/REJECTED/ESCALATED |

**Case State Machine**:
```
CREATED → ENTITY_RESOLUTION → OWNERSHIP_UBO → SCREENING → RISK_ASSESSMENT
        → QA_REVIEW → PENDING_HUMAN_REVIEW → APPROVED | REJECTED | ESCALATED
```

**Indexes**:
- `idx_cases_state` ON `(state)`
- `idx_cases_risk_rating` ON `(risk_rating)`
- `idx_cases_assigned_reviewer` ON `(assigned_reviewer)`
- `idx_cases_created_at` ON `(created_at DESC)`
- `idx_cases_client_name` ON `(client_name)`

---

## Table 3: `agent_results`

One record per agent per case. Stores the complete output of each agent execution.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `case_id` | `UUID` | NOT NULL, FK → `cases(id)` | |
| `agent_type` | `VARCHAR(50)` | NOT NULL | e.g. `entity_resolution`, `screening` |
| `status` | `VARCHAR(20)` | NOT NULL, CHECK IN `('completed','failed','partial')` | |
| `output` | `JSONB` | NOT NULL | Structured agent output |
| `confidence` | `INTEGER` | CHECK 0–100, nullable | Overall agent confidence |
| `steps` | `JSONB` | NOT NULL | Array of step records |
| `total_llm_calls` | `INTEGER` | nullable | |
| `total_latency_ms` | `INTEGER` | nullable | |
| `started_at` | `TIMESTAMPTZ` | NOT NULL | |
| `completed_at` | `TIMESTAMPTZ` | nullable | |
| UNIQUE | | `(case_id, agent_type)` | One result per agent per case |

**Indexes**: `idx_agent_results_case` ON `(case_id)`

---

## Table 4: `decision_fragments`

Atomic audit units — each agent decision step with evidence and review status.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `case_id` | `UUID` | NOT NULL, FK → `cases(id)` | |
| `agent_type` | `VARCHAR(50)` | NOT NULL | |
| `step_id` | `VARCHAR(100)` | NOT NULL | Identifies the step within the agent |
| `fragment_type` | `VARCHAR(50)` | NOT NULL | e.g. `sanctions_clear`, `ubo_identified` |
| `decision` | `TEXT` | NOT NULL | Human-readable decision text |
| `confidence` | `INTEGER` | NOT NULL, CHECK 0–100 | |
| `evidence` | `JSONB` | NOT NULL | Array of `{source, data, fetched_at}` |
| `status` | `VARCHAR(30)` | NOT NULL, DEFAULT `'pending_review'`, CHECK IN `('auto_approved','pending_review','human_approved','human_rejected','human_modified','dismissed')` | |
| `reviewed_by` | `UUID` | FK → `users(id)`, nullable | |
| `review_comment` | `TEXT` | nullable | |
| `reviewed_at` | `TIMESTAMPTZ` | nullable | |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `NOW()` | |

**Indexes**:
- `idx_fragments_case` ON `(case_id)`
- `idx_fragments_case_agent` ON `(case_id, agent_type)`
- `idx_fragments_type` ON `(fragment_type)`
- `idx_fragments_status` ON `(status)`

---

## Table 5: `decision_events` *(APPEND-ONLY)*

Immutable audit event stream. Every agent action, state transition, and human review
action is recorded here. UPDATE and DELETE are blocked by PostgreSQL rules.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `case_id` | `UUID` | NOT NULL, FK → `cases(id)` | |
| `agent_type` | `VARCHAR(50)` | NOT NULL | Agent name or `'human'`/`'system'` |
| `step_id` | `VARCHAR(100)` | NOT NULL | |
| `event_type` | `VARCHAR(50)` | NOT NULL | e.g. `case_created`, `fragment_added` |
| `event_data` | `JSONB` | NOT NULL | Event payload |
| `created_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `NOW()` | |
| `sequence_number` | `BIGSERIAL` | NOT NULL | Monotonically increasing per-row |

**Append-only rules** (PostgreSQL level):
```sql
CREATE RULE no_update_events AS ON UPDATE TO decision_events DO INSTEAD NOTHING;
CREATE RULE no_delete_events AS ON DELETE TO decision_events DO INSTEAD NOTHING;
```

**Indexes**:
- `idx_events_case` ON `(case_id, sequence_number)`
- `idx_events_type` ON `(event_type, created_at)`
- `idx_events_agent` ON `(case_id, agent_type, step_id)`

---

## Table 6: `documents`

Metadata for uploaded files. Actual file content stored in MinIO (`minio_key` is the
S3 object key in the `documents` bucket).

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `case_id` | `UUID` | NOT NULL, FK → `cases(id)` | |
| `filename` | `VARCHAR(500)` | NOT NULL | Original filename |
| `mime_type` | `VARCHAR(100)` | NOT NULL | e.g. `application/pdf` |
| `size_bytes` | `BIGINT` | NOT NULL | |
| `minio_key` | `VARCHAR(500)` | NOT NULL | MinIO object key in `documents` bucket |
| `document_type` | `VARCHAR(100)` | nullable | e.g. `certificate_of_incorporation` |
| `extracted_text` | `TEXT` | nullable | Full text from document analysis |
| `extracted_data` | `JSONB` | nullable | Structured data from document analysis |
| `analysis_status` | `VARCHAR(20)` | NOT NULL, DEFAULT `'pending'`, CHECK IN `('pending','analyzing','analyzed','failed')` | |
| `uploaded_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `NOW()` | |
| `uploaded_by` | `UUID` | FK → `users(id)`, nullable | |

**Indexes**: `idx_documents_case` ON `(case_id)`

---

## Table 7: `screening_lists`

Metadata for each sanctions/PEP/adverse media list loaded into the system.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `list_name` | `VARCHAR(100)` | NOT NULL, UNIQUE | e.g. `OFAC_SDN`, `UK_HMT` |
| `list_type` | `VARCHAR(20)` | NOT NULL, CHECK IN `('sanctions','pep','adverse_media')` | |
| `source_url` | `VARCHAR(500)` | nullable | |
| `last_updated` | `TIMESTAMPTZ` | nullable | |
| `entry_count` | `INTEGER` | nullable | |
| `metadata` | `JSONB` | nullable | List-specific metadata |

---

## Table 8: `screening_entries`

Individual entities from sanctions/PEP lists. Supports trigram fuzzy search for name matching.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `list_id` | `UUID` | NOT NULL, FK → `screening_lists(id)` | |
| `entry_id` | `VARCHAR(200)` | NOT NULL | Source-system identifier |
| `entity_type` | `VARCHAR(20)` | NOT NULL, CHECK IN `('individual','entity')` | |
| `primary_name` | `VARCHAR(500)` | NOT NULL | |
| `aliases` | `TEXT[]` | nullable | Alternative names |
| `date_of_birth` | `VARCHAR(20)` | nullable | Stored as string (partial dates) |
| `nationalities` | `TEXT[]` | nullable | |
| `programs` | `TEXT[]` | nullable | Sanctions programs |
| `remarks` | `TEXT` | nullable | |
| `raw_data` | `JSONB` | NOT NULL | Original source record |
| UNIQUE | | `(list_id, entry_id)` | |

**Extension required**: `pg_trgm` (for `primary_name` trigram index)

**Indexes**:
- `idx_screening_entries_list` ON `(list_id)`
- `idx_screening_entries_name` ON `(primary_name)` (basic)
- `idx_screening_entries_name_trgm` USING GIN `(primary_name gin_trgm_ops)` (fuzzy)

---

## Table 9: `data_source_cache`

Caches external API responses (company registries, news) for audit reproducibility.
Keyed by `(provider, query_hash, fetched_at)` so cases can prove what data was available
at the time of the decision.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| `id` | `UUID` | PK, DEFAULT `gen_random_uuid()` | |
| `provider` | `VARCHAR(100)` | NOT NULL | e.g. `companies_house`, `sec_edgar` |
| `query_hash` | `VARCHAR(64)` | NOT NULL | SHA-256 of canonical query params |
| `query_params` | `JSONB` | NOT NULL | Human-readable query parameters |
| `response_data` | `JSONB` | NOT NULL | API response body |
| `fetched_at` | `TIMESTAMPTZ` | NOT NULL, DEFAULT `NOW()` | |
| `expires_at` | `TIMESTAMPTZ` | nullable | TTL for cache invalidation |
| `case_id` | `UUID` | FK → `cases(id)`, nullable | Links cache entry to requesting case |
| UNIQUE | | `(provider, query_hash, fetched_at)` | |

**Indexes**:
- `idx_cache_provider_query` ON `(provider, query_hash, fetched_at DESC)`

---

## Connection Pool Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `DATABASE_URL` | (required) | Full PostgreSQL connection string |
| `PG_POOL_MAX` | `20` | Maximum pool connections |
| `PG_POOL_MIN` | `2` | Minimum pool connections |
| `PG_POOL_IDLE_TIMEOUT_MS` | `30000` | Close idle connections after 30s |
| `PG_POOL_CONN_TIMEOUT_MS` | `5000` | Fail if no connection available in 5s |

---

## Migration Tracking

node-pg-migrate creates and maintains a `pgmigrations` table automatically:

| Column | Type | Notes |
|--------|------|-------|
| `id` | `BIGSERIAL` | PK |
| `name` | `VARCHAR(255)` | Migration filename |
| `run_on` | `TIMESTAMP` | When it was applied |

This table is NOT in `init.sql` — node-pg-migrate creates it on first run.
