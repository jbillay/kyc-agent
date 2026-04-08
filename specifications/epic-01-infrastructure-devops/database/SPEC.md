# PostgreSQL Database Schema and Migration System

> GitHub Issue: [#3](https://github.com/jbillay/kyc-agent/issues/3)
> Epic: Infrastructure & DevOps Setup (#1)
> Size: M (1-3 days) | Priority: Critical

## Context

The KYC Agent platform uses PostgreSQL as its primary data store for cases, agent results, decision fragments, audit events, documents metadata, screening lists, and users. A key architectural requirement is the **append-only decision event store** — the `decision_events` table must be immutable to satisfy regulatory audit requirements. The database schema is the contract between all backend services and agents.

## Requirements

### Functional

1. `init.sql` creates all tables with correct types, constraints, and indexes
2. Append-only rules on `decision_events` prevent UPDATE and DELETE at the SQL level
3. A migration system tracks schema changes going forward
4. Seed data creates a default admin user for initial access
5. Database connection module provides pooled connections to the application

### Non-Functional

- All primary keys are UUIDs generated via `gen_random_uuid()`
- Connection pooling with configurable min/max connections
- Schema supports 100k+ cases and 1M+ events without performance degradation (indexes)

## Technical Design

### File: `backend/db/init.sql`

```sql
-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- USERS (must be created first — referenced by other tables)
-- ============================================================
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(30) NOT NULL CHECK (role IN ('analyst', 'senior_analyst', 'compliance_officer', 'admin')),
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

-- ============================================================
-- CASES
-- ============================================================
CREATE TABLE cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_name VARCHAR(500) NOT NULL,
    client_type VARCHAR(20) NOT NULL CHECK (client_type IN ('corporate', 'individual')),
    jurisdiction VARCHAR(10) NOT NULL,
    registration_number VARCHAR(100),
    additional_identifiers JSONB DEFAULT '{}',
    state VARCHAR(50) NOT NULL DEFAULT 'CREATED',
    dd_level VARCHAR(20) NOT NULL DEFAULT 'standard' CHECK (dd_level IN ('simplified', 'standard', 'enhanced')),
    risk_score INTEGER CHECK (risk_score >= 0 AND risk_score <= 100),
    risk_rating VARCHAR(20) CHECK (risk_rating IN ('low', 'medium', 'high', 'very_high')),
    assigned_reviewer UUID REFERENCES users(id),
    review_decision VARCHAR(30) CHECK (review_decision IN ('approved', 'rejected', 'escalated', 'additional_info')),
    review_comment TEXT,
    reviewed_at TIMESTAMPTZ,
    source VARCHAR(20) DEFAULT 'manual' CHECK (source IN ('api', 'manual', 'batch')),
    tags TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_cases_state ON cases(state);
CREATE INDEX idx_cases_risk_rating ON cases(risk_rating);
CREATE INDEX idx_cases_assigned_reviewer ON cases(assigned_reviewer);
CREATE INDEX idx_cases_created_at ON cases(created_at DESC);
CREATE INDEX idx_cases_client_name ON cases(client_name);

-- ============================================================
-- AGENT RESULTS
-- ============================================================
CREATE TABLE agent_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    agent_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL CHECK (status IN ('completed', 'failed', 'partial')),
    output JSONB NOT NULL,
    confidence INTEGER CHECK (confidence >= 0 AND confidence <= 100),
    steps JSONB NOT NULL,
    total_llm_calls INTEGER,
    total_latency_ms INTEGER,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    UNIQUE(case_id, agent_type)
);

CREATE INDEX idx_agent_results_case ON agent_results(case_id);

-- ============================================================
-- DECISION FRAGMENTS
-- ============================================================
CREATE TABLE decision_fragments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    agent_type VARCHAR(50) NOT NULL,
    step_id VARCHAR(100) NOT NULL,
    fragment_type VARCHAR(50) NOT NULL,
    decision TEXT NOT NULL,
    confidence INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    evidence JSONB NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending_review'
        CHECK (status IN ('auto_approved', 'pending_review', 'human_approved', 'human_rejected', 'human_modified', 'dismissed')),
    reviewed_by UUID REFERENCES users(id),
    review_comment TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_fragments_case ON decision_fragments(case_id);
CREATE INDEX idx_fragments_case_agent ON decision_fragments(case_id, agent_type);
CREATE INDEX idx_fragments_type ON decision_fragments(fragment_type);
CREATE INDEX idx_fragments_status ON decision_fragments(status);

-- ============================================================
-- DECISION EVENTS (APPEND-ONLY AUDIT LOG)
-- ============================================================
CREATE TABLE decision_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    agent_type VARCHAR(50) NOT NULL,
    step_id VARCHAR(100) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_data JSONB NOT NULL,
    sequence_number BIGSERIAL
);

CREATE INDEX idx_events_case ON decision_events(case_id, sequence_number);
CREATE INDEX idx_events_type ON decision_events(event_type, created_at);
CREATE INDEX idx_events_agent ON decision_events(case_id, agent_type, step_id);

-- Prevent updates and deletes (append-only)
CREATE RULE no_update_events AS ON UPDATE TO decision_events DO INSTEAD NOTHING;
CREATE RULE no_delete_events AS ON DELETE TO decision_events DO INSTEAD NOTHING;

-- ============================================================
-- DOCUMENTS
-- ============================================================
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    filename VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    minio_key VARCHAR(500) NOT NULL,
    document_type VARCHAR(100),
    extracted_text TEXT,
    extracted_data JSONB,
    analysis_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (analysis_status IN ('pending', 'analyzing', 'analyzed', 'failed')),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uploaded_by UUID REFERENCES users(id)
);

CREATE INDEX idx_documents_case ON documents(case_id);

-- ============================================================
-- SCREENING LISTS
-- ============================================================
CREATE TABLE screening_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_name VARCHAR(100) NOT NULL UNIQUE,
    list_type VARCHAR(20) NOT NULL CHECK (list_type IN ('sanctions', 'pep', 'adverse_media')),
    source_url VARCHAR(500),
    last_updated TIMESTAMPTZ,
    entry_count INTEGER,
    metadata JSONB
);

-- ============================================================
-- SCREENING ENTRIES
-- ============================================================
CREATE TABLE screening_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id UUID NOT NULL REFERENCES screening_lists(id),
    entry_id VARCHAR(200) NOT NULL,
    entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('individual', 'entity')),
    primary_name VARCHAR(500) NOT NULL,
    aliases TEXT[],
    date_of_birth VARCHAR(20),
    nationalities TEXT[],
    programs TEXT[],
    remarks TEXT,
    raw_data JSONB NOT NULL,
    UNIQUE(list_id, entry_id)
);

CREATE INDEX idx_screening_entries_list ON screening_entries(list_id);
CREATE INDEX idx_screening_entries_name ON screening_entries(primary_name);

-- ============================================================
-- DATA SOURCE CACHE
-- ============================================================
CREATE TABLE data_source_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(100) NOT NULL,
    query_hash VARCHAR(64) NOT NULL,
    query_params JSONB NOT NULL,
    response_data JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    case_id UUID REFERENCES cases(id),
    UNIQUE(provider, query_hash, fetched_at)
);

CREATE INDEX idx_cache_provider_query ON data_source_cache(provider, query_hash, fetched_at DESC);

-- ============================================================
-- SEED DATA
-- ============================================================
-- Default admin user (password: "admin" — MUST be changed in production)
-- bcrypt hash of "admin" with 10 rounds
INSERT INTO users (email, name, role, password_hash) VALUES
    ('admin@kycagent.local', 'System Administrator', 'admin', '$2b$10$placeholder_hash_replace_on_first_run');
```

### File: `backend/db/connection.js`

```javascript
// Database connection module with pooling
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.PG_POOL_MAX || '20'),
  min: parseInt(process.env.PG_POOL_MIN || '2'),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

/**
 * Execute a query with parameterized values.
 * @param {string} text - SQL query
 * @param {any[]} [params] - Query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    console.warn(`Slow query (${duration}ms):`, text.substring(0, 100));
  }
  return result;
}

/**
 * Get a client from the pool for transactions.
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  return pool.connect();
}

module.exports = { pool, query, getClient };
```

### Migration System

Use `node-pg-migrate` for forward migrations after the initial schema:

```
backend/db/
├── init.sql              # Initial schema (run by Docker on first start)
├── connection.js         # Pool-based connection module
├── migrations/           # Incremental migrations
│   └── .gitkeep
└── seed.js               # Seed data script (admin user with proper bcrypt hash)
```

Each epic that introduces new database columns or tables must include a numbered migration file in `backend/db/migrations/` (e.g., `001-auth-refresh-tokens.js`). The `init.sql` contains the base schema; all subsequent changes are incremental migrations.

**Migration configuration** in `backend/package.json`:
```json
{
  "scripts": {
    "migrate:up": "node-pg-migrate up",
    "migrate:down": "node-pg-migrate down",
    "migrate:create": "node-pg-migrate create",
    "db:seed": "node src/db/seed.js"
  }
}
```

### Seed Script: `backend/db/seed.js`

```javascript
const bcrypt = require('bcrypt');
const { query } = require('./connection');

async function seed() {
  const passwordHash = await bcrypt.hash('admin', 10);

  await query(
    `INSERT INTO users (email, name, role, password_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE SET password_hash = $4`,
    ['admin@kycagent.local', 'System Administrator', 'admin', passwordHash]
  );

  console.log('Seed complete: admin user created (admin@kycagent.local / admin)');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
```

## Interfaces

### Tables Summary

| Table | Purpose | Key Constraints |
|-------|---------|-----------------|
| `users` | Platform users with RBAC roles | Unique email, role enum |
| `cases` | KYC case lifecycle | State machine, risk bounds 0-100 |
| `agent_results` | Output from each agent run | Unique per (case, agent_type) |
| `decision_fragments` | Atomic agent decisions with evidence | Confidence 0-100, review status enum |
| `decision_events` | Immutable audit event stream | **Append-only** (SQL rules block UPDATE/DELETE) |
| `documents` | File metadata (files in MinIO) | Analysis status enum |
| `screening_lists` | Sanctions/PEP list metadata | Unique list name |
| `screening_entries` | Individual entries in screening lists | Unique per (list, entry_id) |
| `data_source_cache` | Cached external API responses | TTL-based, unique per (provider, hash, time) |

### Connection Module API

| Function | Signature | Purpose |
|----------|-----------|---------|
| `query` | `(text: string, params?: any[]) => Promise<QueryResult>` | Execute parameterized SQL |
| `getClient` | `() => Promise<PoolClient>` | Get client for transactions |

## Acceptance Criteria

- [ ] `init.sql` creates all 9 tables: `users`, `cases`, `agent_results`, `decision_fragments`, `decision_events`, `documents`, `screening_lists`, `screening_entries`, `data_source_cache`
- [ ] All indexes are created as specified
- [ ] `decision_events` table rejects UPDATE and DELETE operations (verify with test queries)
- [ ] `node-pg-migrate` is configured and can create/run migrations
- [ ] Seed script creates a default admin user with bcrypt-hashed password
- [ ] `connection.js` provides pooled connections with configurable pool size
- [ ] All CHECK constraints enforce valid enum values
- [ ] UUID primary keys work via `gen_random_uuid()`

## Dependencies

- **Depends on**: #2 (Docker Compose — PostgreSQL must be running)
- **Blocks**: #4 (Backend scaffold needs DB connection), #6 (MinIO storage needs `documents` table)

## Testing Strategy

1. **Schema creation test**: Run `init.sql` against a fresh database, verify all tables exist
2. **Append-only test**: Attempt UPDATE and DELETE on `decision_events` — both should silently do nothing
3. **Constraint tests**: Insert invalid enum values, out-of-range integers — verify rejection
4. **Foreign key tests**: Insert fragment for non-existent case — verify rejection
5. **Seed test**: Run seed script, verify admin user exists and password hash is valid
6. **Connection pool test**: Open multiple concurrent queries, verify pool behavior
7. **Migration test**: Create a test migration, run up/down, verify schema changes
