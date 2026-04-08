-- KYC Agent — PostgreSQL Schema Initialization
-- Runs once on first container start when pgdata volume is empty.
-- All DDL is idempotent (IF NOT EXISTS).

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm; -- fuzzy matching for screening entries

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('analyst', 'senior_analyst', 'compliance_officer', 'admin')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Cases
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cases (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_name   TEXT NOT NULL,
  client_type   TEXT NOT NULL CHECK (client_type IN ('corporate', 'individual')),
  status        TEXT NOT NULL DEFAULT 'CREATED' CHECK (status IN (
                  'CREATED', 'ENTITY_RESOLUTION', 'OWNERSHIP_UBO', 'SCREENING',
                  'RISK_ASSESSMENT', 'QA_REVIEW', 'PENDING_HUMAN_REVIEW',
                  'APPROVED', 'REJECTED', 'ESCALATED'
                )),
  risk_score    INTEGER CHECK (risk_score BETWEEN 0 AND 100),
  risk_level    TEXT CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  created_by    UUID REFERENCES users(id),
  assigned_to   UUID REFERENCES users(id),
  metadata      JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_created_by ON cases(created_by);

-- ---------------------------------------------------------------------------
-- Agent Results
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_results (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id       UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  agent_type    TEXT NOT NULL CHECK (agent_type IN (
                  'entity_resolution', 'ownership_ubo', 'screening',
                  'document_analysis', 'risk_assessment', 'qa'
                )),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                  'pending', 'running', 'completed', 'failed'
                )),
  output        JSONB,
  error         TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_results_case_id ON agent_results(case_id);

-- ---------------------------------------------------------------------------
-- Decision Fragments
-- Each agent decision: type, confidence, evidence, LLM reasoning, review status.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_fragments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id         UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  agent_result_id UUID REFERENCES agent_results(id),
  fragment_type   TEXT NOT NULL,   -- e.g. 'sanctions_clear', 'ubo_identified', 'risk_factor_identified'
  confidence      INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  evidence        JSONB NOT NULL DEFAULT '[]',  -- array of {source, data, fetched_at}
  reasoning       TEXT,            -- LLM-generated explanation
  review_status   TEXT NOT NULL DEFAULT 'pending_review' CHECK (review_status IN (
                    'auto_approved', 'pending_review', 'human_approved', 'human_rejected', 'overridden'
                  )),
  reviewed_by     UUID REFERENCES users(id),
  reviewed_at     TIMESTAMPTZ,
  override_note   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fragments_case_id ON decision_fragments(case_id);
CREATE INDEX IF NOT EXISTS idx_fragments_review_status ON decision_fragments(review_status);

-- ---------------------------------------------------------------------------
-- Decision Events  (APPEND-ONLY — rules below enforce this)
-- Immutable audit log of every agent action and state transition.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decision_events (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id     UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,   -- e.g. 'case_created', 'agent_started', 'fragment_added', 'status_changed'
  actor_type  TEXT NOT NULL CHECK (actor_type IN ('agent', 'human', 'system')),
  actor_id    TEXT,            -- agent name or user UUID
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_case_id ON decision_events(case_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON decision_events(created_at);

-- APPEND-ONLY enforcement: prevent any UPDATE or DELETE on decision_events
CREATE OR REPLACE RULE no_update_decision_events AS
  ON UPDATE TO decision_events DO INSTEAD NOTHING;

CREATE OR REPLACE RULE no_delete_decision_events AS
  ON DELETE TO decision_events DO INSTEAD NOTHING;

-- ---------------------------------------------------------------------------
-- Documents
-- Metadata only — actual files stored in MinIO (minio_object_key is the S3 key).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS documents (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  case_id          UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  filename         TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  minio_object_key TEXT NOT NULL UNIQUE,
  size_bytes       BIGINT,
  doc_type         TEXT,          -- 'certificate_of_incorporation', 'passport', etc.
  extracted_data   JSONB,         -- document analysis output
  uploaded_by      UUID REFERENCES users(id),
  uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_documents_case_id ON documents(case_id);

-- ---------------------------------------------------------------------------
-- Screening Lists
-- Metadata for each sanctions/PEP list loaded into the system.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS screening_lists (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  list_name     TEXT NOT NULL UNIQUE,  -- 'OFAC_SDN', 'UK_HMT', 'UN', 'EU'
  list_type     TEXT NOT NULL CHECK (list_type IN ('sanctions', 'pep', 'adverse_media')),
  source_url    TEXT,
  last_updated  TIMESTAMPTZ,
  entry_count   INTEGER NOT NULL DEFAULT 0,
  checksum      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Screening Entries
-- Individual entities from sanctions/PEP lists. Supports fuzzy text search.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS screening_entries (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  list_id     UUID NOT NULL REFERENCES screening_lists(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  entity_type TEXT CHECK (entity_type IN ('individual', 'entity', 'vessel', 'aircraft')),
  aliases     JSONB NOT NULL DEFAULT '[]',   -- array of alternate name strings
  identifiers JSONB NOT NULL DEFAULT '{}',   -- {dob, nationality, passport, etc.}
  programs    JSONB NOT NULL DEFAULT '[]',   -- sanctions programs
  raw_data    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_screening_entries_list_id ON screening_entries(list_id);
CREATE INDEX IF NOT EXISTS idx_screening_entries_name_trgm ON screening_entries USING GIN (name gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- Data Source Cache
-- Caches external API responses (registries, news) for audit reproducibility.
-- Keyed by (provider, query_hash) so cases can prove what data was available at
-- decision time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS data_source_cache (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider     TEXT NOT NULL,       -- 'companies_house', 'sec_edgar', 'ofac', etc.
  query_hash   TEXT NOT NULL,       -- SHA-256 of the canonical query parameters
  response     JSONB NOT NULL,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,
  UNIQUE (provider, query_hash, fetched_at)
);

CREATE INDEX IF NOT EXISTS idx_cache_provider_hash ON data_source_cache(provider, query_hash);
CREATE INDEX IF NOT EXISTS idx_cache_expires_at ON data_source_cache(expires_at);
