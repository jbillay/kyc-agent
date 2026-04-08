-- KYC Agent — PostgreSQL Schema Initialization
-- Runs once on first container start when pgdata volume is empty.
-- All DDL is idempotent (IF NOT EXISTS / CREATE OR REPLACE).
-- UUID generation: gen_random_uuid() via pgcrypto (built into PostgreSQL 13+).

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy name matching on screening_entries

-- ---------------------------------------------------------------------------
-- Table 1: users
-- Platform users with RBAC roles.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) NOT NULL UNIQUE,
  name          VARCHAR(255) NOT NULL,
  role          VARCHAR(30)  NOT NULL CHECK (role IN ('analyst','senior_analyst','compliance_officer','admin')),
  password_hash VARCHAR(255) NOT NULL,
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

-- ---------------------------------------------------------------------------
-- Table 2: cases
-- Central KYC case record. Drives the agent pipeline state machine.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cases (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name            VARCHAR(500) NOT NULL,
  client_type            VARCHAR(20)  NOT NULL CHECK (client_type IN ('corporate','individual')),
  jurisdiction           VARCHAR(10)  NOT NULL,
  registration_number    VARCHAR(100),
  additional_identifiers JSONB        NOT NULL DEFAULT '{}',
  state                  VARCHAR(50)  NOT NULL DEFAULT 'CREATED'
                           CHECK (state IN (
                             'CREATED','ENTITY_RESOLUTION','OWNERSHIP_UBO','SCREENING',
                             'RISK_ASSESSMENT','QA_REVIEW','PENDING_HUMAN_REVIEW',
                             'APPROVED','REJECTED','ESCALATED'
                           )),
  dd_level               VARCHAR(20)  NOT NULL DEFAULT 'standard'
                           CHECK (dd_level IN ('simplified','standard','enhanced')),
  risk_score             INTEGER      CHECK (risk_score BETWEEN 0 AND 100),
  risk_rating            VARCHAR(20)  CHECK (risk_rating IN ('low','medium','high','very_high')),
  assigned_reviewer      UUID         REFERENCES users(id),
  review_decision        VARCHAR(30)  CHECK (review_decision IN ('approved','rejected','escalated','additional_info')),
  review_comment         TEXT,
  reviewed_at            TIMESTAMPTZ,
  source                 VARCHAR(20)  NOT NULL DEFAULT 'manual'
                           CHECK (source IN ('api','manual','batch')),
  tags                   TEXT[],
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cases_state             ON cases (state);
CREATE INDEX IF NOT EXISTS idx_cases_risk_rating       ON cases (risk_rating);
CREATE INDEX IF NOT EXISTS idx_cases_assigned_reviewer ON cases (assigned_reviewer);
CREATE INDEX IF NOT EXISTS idx_cases_created_at        ON cases (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cases_client_name       ON cases (client_name);

-- ---------------------------------------------------------------------------
-- Table 3: agent_results
-- One record per agent per case. Stores the complete output of each execution.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_results (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          UUID        NOT NULL REFERENCES cases(id),
  agent_type       VARCHAR(50) NOT NULL,
  status           VARCHAR(20) NOT NULL CHECK (status IN ('completed','failed','partial')),
  output           JSONB       NOT NULL,
  confidence       INTEGER     CHECK (confidence BETWEEN 0 AND 100),
  steps            JSONB       NOT NULL,
  total_llm_calls  INTEGER,
  total_latency_ms INTEGER,
  started_at       TIMESTAMPTZ NOT NULL,
  completed_at     TIMESTAMPTZ,
  UNIQUE (case_id, agent_type)
);

CREATE INDEX IF NOT EXISTS idx_agent_results_case ON agent_results (case_id);

-- ---------------------------------------------------------------------------
-- Table 4: decision_fragments
-- Atomic audit units — each agent decision step with evidence and review status.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_fragments (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id        UUID        NOT NULL REFERENCES cases(id),
  agent_type     VARCHAR(50) NOT NULL,
  step_id        VARCHAR(100) NOT NULL,
  fragment_type  VARCHAR(50) NOT NULL,
  decision       TEXT        NOT NULL,
  confidence     INTEGER     NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  evidence       JSONB       NOT NULL,
  status         VARCHAR(30) NOT NULL DEFAULT 'pending_review'
                   CHECK (status IN (
                     'auto_approved','pending_review','human_approved',
                     'human_rejected','human_modified','dismissed'
                   )),
  reviewed_by    UUID        REFERENCES users(id),
  review_comment TEXT,
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fragments_case       ON decision_fragments (case_id);
CREATE INDEX IF NOT EXISTS idx_fragments_case_agent ON decision_fragments (case_id, agent_type);
CREATE INDEX IF NOT EXISTS idx_fragments_type       ON decision_fragments (fragment_type);
CREATE INDEX IF NOT EXISTS idx_fragments_status     ON decision_fragments (status);

-- ---------------------------------------------------------------------------
-- Table 5: decision_events  (APPEND-ONLY)
-- Immutable audit event stream. Every agent action, state transition, and human
-- review action is recorded here. UPDATE and DELETE are blocked by rules below.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_events (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         UUID        NOT NULL REFERENCES cases(id),
  agent_type      VARCHAR(50) NOT NULL,
  step_id         VARCHAR(100) NOT NULL,
  event_type      VARCHAR(50) NOT NULL,
  event_data      JSONB       NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sequence_number BIGSERIAL   NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_case    ON decision_events (case_id, sequence_number);
CREATE INDEX IF NOT EXISTS idx_events_type    ON decision_events (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_agent   ON decision_events (case_id, agent_type, step_id);

-- Append-only enforcement: silently discard any UPDATE or DELETE attempts.
CREATE OR REPLACE RULE no_update_events AS
  ON UPDATE TO decision_events DO INSTEAD NOTHING;

CREATE OR REPLACE RULE no_delete_events AS
  ON DELETE TO decision_events DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------------
-- Table 6: documents
-- Metadata for uploaded files. Actual content stored in MinIO.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          UUID         NOT NULL REFERENCES cases(id),
  filename         VARCHAR(500) NOT NULL,
  mime_type        VARCHAR(100) NOT NULL,
  size_bytes       BIGINT       NOT NULL,
  minio_key        VARCHAR(500) NOT NULL,
  document_type    VARCHAR(100),
  extracted_text   TEXT,
  extracted_data   JSONB,
  analysis_status  VARCHAR(20)  NOT NULL DEFAULT 'pending'
                     CHECK (analysis_status IN ('pending','analyzing','analyzed','failed')),
  uploaded_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  uploaded_by      UUID         REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_documents_case ON documents (case_id);

-- ---------------------------------------------------------------------------
-- Table 7: screening_lists
-- Metadata for each sanctions/PEP/adverse media list.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS screening_lists (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  list_name    VARCHAR(100) NOT NULL UNIQUE,
  list_type    VARCHAR(20)  NOT NULL CHECK (list_type IN ('sanctions','pep','adverse_media')),
  source_url   VARCHAR(500),
  last_updated TIMESTAMPTZ,
  entry_count  INTEGER,
  metadata     JSONB
);

-- ---------------------------------------------------------------------------
-- Table 8: screening_entries
-- Individual entities from sanctions/PEP lists. Supports trigram fuzzy search.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS screening_entries (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id      UUID         NOT NULL REFERENCES screening_lists(id),
  entry_id     VARCHAR(200) NOT NULL,
  entity_type  VARCHAR(20)  NOT NULL CHECK (entity_type IN ('individual','entity')),
  primary_name VARCHAR(500) NOT NULL,
  aliases      TEXT[],
  date_of_birth VARCHAR(20),
  nationalities TEXT[],
  programs     TEXT[],
  remarks      TEXT,
  raw_data     JSONB        NOT NULL,
  UNIQUE (list_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_screening_entries_list     ON screening_entries (list_id);
CREATE INDEX IF NOT EXISTS idx_screening_entries_name     ON screening_entries (primary_name);
CREATE INDEX IF NOT EXISTS idx_screening_entries_name_trgm
  ON screening_entries USING GIN (primary_name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Table 9: data_source_cache
-- Caches external API responses for audit reproducibility.
-- Keyed by (provider, query_hash, fetched_at).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_source_cache (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      VARCHAR(100) NOT NULL,
  query_hash    VARCHAR(64)  NOT NULL,
  query_params  JSONB        NOT NULL,
  response_data JSONB        NOT NULL,
  fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  case_id       UUID         REFERENCES cases(id),
  UNIQUE (provider, query_hash, fetched_at)
);

CREATE INDEX IF NOT EXISTS idx_cache_provider_query
  ON data_source_cache (provider, query_hash, fetched_at DESC);
