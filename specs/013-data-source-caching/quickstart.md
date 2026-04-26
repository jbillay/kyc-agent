# Quickstart: Data Source Response Caching and Versioning

**Branch**: `013-data-source-caching` | **Date**: 2026-04-26

## What you're building

Two modules in `backend/src/data-sources/`:

1. **`cache.js`** — `DataSourceCache` class. Wraps any external provider call with a PostgreSQL-backed cache. Looks up by SHA-256 hash, stores on miss, never deletes. Exposes hit/miss metrics.
2. **`cached-provider.js`** — `withCache` and `withCacheScreening` factory functions. Wrap a `RegistryProvider` or `ScreeningProvider` so callers get caching transparently.

The `data_source_cache` table already exists — **no DB migration needed**.

---

## Files to create / modify

| Action | File |
|--------|------|
| IMPLEMENT (stub exists) | `backend/src/data-sources/cache.js` |
| CREATE | `backend/src/data-sources/cached-provider.js` |
| UPDATE | `config/data-sources.yaml` — add `cache_ttl_hours` for screening providers |
| CREATE | `tests/backend/data-sources/cache.test.js` |
| CREATE | `tests/backend/data-sources/cached-provider.test.js` |

---

## Key implementation notes

### DB access
Use `const { query } = require('../db/connection')` — **not** `pool.query`. The `query` wrapper adds slow-query instrumentation and is the established pattern.

### Concurrent inserts
Use `INSERT ... ON CONFLICT DO NOTHING` — the UNIQUE constraint on `(provider, query_hash, fetched_at)` could conflict on exact-same-microsecond concurrent inserts. `ON CONFLICT DO NOTHING` ensures neither fails.

### Case linking
When retroactively linking a `case_id` to an unlinked entry, target only the **most recent valid (non-expired) entry** for that query key — older or expired entries are not retroactively linked. Use a subquery to find the correct `id` rather than updating by `provider + query_hash`.

### ScreeningProvider — only `search` is cached
`withCacheScreening` wraps only `search`. `getListMetadata` and `updateList` are NOT cached — they're local reads and write operations respectively.

### TTL source
`DataSourceCache` defaults are: `companies-house` → 24h, `ofac-sdn` → 1h, `uk-hmt` → 1h, all others → 24h. Callers can override via `options.ttlHours` sourced from `ConfigService.dataSources`. The cache does not import `ConfigService` itself.

---

## Running tests

```bash
# All backend tests
cd backend && npm test

# Just cache tests
cd backend && npx jest tests/backend/data-sources/cache.test.js
cd backend && npx jest tests/backend/data-sources/cached-provider.test.js
```

Tests mock `backend/db/connection` (`jest.mock`) — no live database required for unit tests.

---

## Test scenarios to cover (`cache.test.js`)

1. Cache miss → `fetchFn` called, entry stored in DB
2. Cache hit → `fetchFn` NOT called, cached data returned
3. TTL expiry → expired entry, `fetchFn` called, new entry stored
4. `bypassCache: true` → valid entry exists, `fetchFn` still called
5. Hash determinism → same inputs, same hash
6. Hash uniqueness → different inputs, different hash
7. Metrics → hit/miss counts correct after sequence
8. `resetMetrics` → counters return to zero
9. Case linking → `case_id` stored when provided on miss; linked on subsequent hit
10. Audit retention → new insert does not delete old entry
11. Unrecognised provider → defaults to 24h TTL gracefully
12. External source error → error propagates, no stale fallback

## Test scenarios to cover (`cached-provider.test.js`)

1. `withCache` wraps all 6 `RegistryProvider` methods
2. String argument normalised to `{ id: string }` for entity-id methods
3. `options.caseId` forwarded to cache
4. `options.bypassCache` forwarded to cache
5. Non-cached methods delegate directly to original provider
6. `provider.name` and `provider.jurisdictions` accessible on wrapped object
7. `withCacheScreening` wraps `search` only
8. `withCacheScreening` — `getListMetadata` and `updateList` delegate directly
