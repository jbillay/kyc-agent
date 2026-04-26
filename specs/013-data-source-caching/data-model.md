# Data Model: Data Source Response Caching and Versioning

**Branch**: `013-data-source-caching` | **Date**: 2026-04-26

## Existing Table: `data_source_cache`

Already defined in `backend/db/init.sql`. **No migration required.**

```sql
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
```

### Field semantics

| Field | Type | Notes |
|-------|------|-------|
| `id` | UUID | Auto-generated primary key |
| `provider` | VARCHAR(100) | Provider identity string (e.g., `'companies-house'`, `'ofac-sdn'`) |
| `query_hash` | VARCHAR(64) | SHA-256 hex digest of `{ provider, method, params }` — 64 chars |
| `query_params` | JSONB | Original query inputs (includes `method` key) — for audit reproducibility |
| `response_data` | JSONB | Complete provider response payload |
| `fetched_at` | TIMESTAMPTZ | When the external source was contacted (transaction start time) |
| `expires_at` | TIMESTAMPTZ | `fetched_at + provider TTL` — NULL means never expires; entry is fresh if `expires_at > NOW()` |
| `case_id` | UUID (FK → `cases.id`) | Optional: the KYC case that triggered this fetch; may be set after insertion |

### Constraints and invariants

- **UNIQUE(provider, query_hash, fetched_at)**: Prevents exact duplicates while allowing multiple entries for the same query over time (versioning model). Concurrent inserts use `ON CONFLICT DO NOTHING`.
- **Index on (provider, query_hash, fetched_at DESC)**: Enables the freshness lookup (`WHERE provider = $1 AND query_hash = $2 AND expires_at > NOW() ORDER BY fetched_at DESC LIMIT 1`) to run within the 50ms budget.
- **No DELETE, no UPDATE on response columns**: Entries are append-only. The only permitted UPDATE is setting `case_id` on an unlinked entry (FR-006).
- **`expires_at` may be NULL**: Not currently used (TTL is always set), but the schema allows it for potential future use (e.g., permanent reference data that never expires).

### Freshness lookup pattern

```sql
SELECT id, response_data, fetched_at, case_id
FROM data_source_cache
WHERE provider = $1
  AND query_hash = $2
  AND expires_at > NOW()
ORDER BY fetched_at DESC
LIMIT 1
```

Returns the most recent valid (non-expired) entry, or no rows on cache miss.

### Insert pattern (append-always, concurrent-safe)

```sql
INSERT INTO data_source_cache
  (provider, query_hash, query_params, response_data, fetched_at, expires_at, case_id)
VALUES
  ($1, $2, $3, $4, NOW(), NOW() + INTERVAL '1 hour' * $5, $6)
ON CONFLICT DO NOTHING
```

`ON CONFLICT DO NOTHING` handles the (extremely rare) case where two concurrent transactions begin at exactly the same microsecond for the same provider + query_hash.

### Case-linking pattern (retroactive)

Links the most recent valid entry for a query key to a case, only if currently unlinked:

```sql
UPDATE data_source_cache
SET case_id = $1
WHERE id = (
  SELECT id
  FROM data_source_cache
  WHERE provider = $2
    AND query_hash = $3
    AND expires_at > NOW()
    AND case_id IS NULL
  ORDER BY fetched_at DESC
  LIMIT 1
)
```

---

## Runtime Entities (in-process only, not persisted)

### `DataSourceCache` instance state

| Property | Type | Description |
|----------|------|-------------|
| `defaultTTLHours` | number | Fallback TTL (24h) for providers not in `ttlHours` map |
| `ttlHours` | `{ [providerName]: number }` | Per-provider TTL overrides |
| `_hits` | number | Running count of cache hits since last reset |
| `_misses` | number | Running count of cache misses since last reset |

### `getMetrics()` return shape

```json
{
  "hits": 42,
  "misses": 8,
  "hitRate": 0.84
}
```

`hitRate` = `hits / (hits + misses)` when total > 0; `0` when no lookups performed.

---

## Config Integration

`config/data-sources.yaml` already has `cache_ttl_hours: 24` for `companies_house`. The following entries should be added for screening providers to make TTLs explicit (matching the `DataSourceCache` defaults):

```yaml
data_sources:
  registries:
    companies_house:
      cache_ttl_hours: 24   # already present

  screening:
    ofac_sdn:
      cache_ttl_hours: 1
    uk_hmt:
      cache_ttl_hours: 1
```

The `DataSourceCache` constructor maps YAML keys to provider name strings used at runtime:

| YAML key | Provider name string | TTL |
|----------|---------------------|-----|
| `companies_house` | `'companies-house'` | 24h |
| `ofac_sdn` | `'ofac-sdn'` | 1h |
| `uk_hmt` | `'uk-hmt'` | 1h |
