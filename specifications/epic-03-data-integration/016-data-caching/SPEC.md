# Data Source Response Caching and Versioning

> GitHub Issue: [#16](https://github.com/jbillay/kyc-agent/issues/16)
> Epic: Data Integration Layer (#13)
> Size: M (1-3 days) | Priority: High

## Context

Every external data fetch must be cached in PostgreSQL so that KYC decisions can prove exactly what data was available at decision time. The cache sits transparently between agents and providers — agents never know whether a response came from cache or a live API call. Expired entries are never deleted; they remain for audit reproducibility.

## Requirements

### Functional

1. All data source responses cached in `data_source_cache` table
2. Cache key is SHA-256 hash of provider name + query parameters
3. Configurable TTL per provider (e.g., Companies House: 24h, sanctions lists: 1h)
4. Cache lookup before external API call; serve cached data if within TTL
5. Each cached entry linked to the `case_id` that triggered the fetch
6. Cache bypass option for forced refresh
7. Expired entries retained (never deleted) for audit
8. Cache hit/miss metrics available

### Non-Functional

- Cache lookups must be faster than API calls (< 50ms)
- No data loss on concurrent writes (use UPSERT pattern)
- Works with both `RegistryProvider` and `ScreeningProvider` responses

## Technical Design

### File: `backend/src/data-sources/cache.js`

```javascript
const crypto = require('crypto');
const { pool } = require('../db/connection');

/**
 * Data source cache service.
 *
 * Wraps any provider method call with a cache layer backed by PostgreSQL.
 * Expired entries are retained for audit; only TTL determines freshness.
 */
class DataSourceCache {
  /**
   * @param {Object} [options]
   * @param {Object.<string, number>} [options.ttlHours] - Per-provider TTL overrides
   */
  constructor(options = {}) {
    this.defaultTTLHours = 24;
    this.ttlHours = {
      'companies-house': 24,
      'ofac-sdn': 1,
      'uk-hmt': 1,
      ...options.ttlHours,
    };

    this._hits = 0;
    this._misses = 0;
  }

  /**
   * Get or fetch data through the cache.
   *
   * @param {Object} params
   * @param {string} params.provider - Provider name (e.g., 'companies-house')
   * @param {string} params.method - Method name (e.g., 'getEntityDetails')
   * @param {Object} params.queryParams - The query parameters to hash
   * @param {string} [params.caseId] - Case that triggered this fetch
   * @param {boolean} [params.bypassCache=false] - Force fresh fetch
   * @param {() => Promise<Object>} params.fetchFn - Function to call on cache miss
   * @returns {Promise<{ data: Object, fromCache: boolean, cachedAt: string|null }>}
   */
  async getOrFetch({ provider, method, queryParams, caseId, bypassCache = false, fetchFn }) {
    const queryHash = this._hashQuery(provider, method, queryParams);

    if (!bypassCache) {
      const cached = await this._lookup(provider, queryHash);
      if (cached) {
        this._hits++;
        // Link this cache entry to the current case (if not already linked)
        if (caseId && !cached.case_id) {
          await this._linkToCase(cached.id, caseId);
        }
        return { data: cached.response_data, fromCache: true, cachedAt: cached.fetched_at };
      }
    }

    this._misses++;
    const data = await fetchFn();

    const ttl = this.ttlHours[provider] || this.defaultTTLHours;
    await this._store({
      provider,
      queryHash,
      queryParams: { method, ...queryParams },
      responseData: data,
      ttlHours: ttl,
      caseId,
    });

    return { data, fromCache: false, cachedAt: null };
  }

  /**
   * Get cache metrics.
   * @returns {{ hits: number, misses: number, hitRate: number }}
   */
  getMetrics() {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? this._hits / total : 0,
    };
  }

  /**
   * Reset metrics counters.
   */
  resetMetrics() {
    this._hits = 0;
    this._misses = 0;
  }

  // ─── Internal ─────────────────────────────────────────

  /**
   * SHA-256 hash of provider + method + query params.
   * @param {string} provider
   * @param {string} method
   * @param {Object} queryParams
   * @returns {string}
   */
  _hashQuery(provider, method, queryParams) {
    const payload = JSON.stringify({ provider, method, params: queryParams });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Look up a non-expired cache entry.
   * @param {string} provider
   * @param {string} queryHash
   * @returns {Promise<Object|null>}
   */
  async _lookup(provider, queryHash) {
    const result = await pool.query(
      `SELECT id, response_data, fetched_at, case_id
       FROM data_source_cache
       WHERE provider = $1 AND query_hash = $2 AND expires_at > NOW()
       ORDER BY fetched_at DESC
       LIMIT 1`,
      [provider, queryHash]
    );
    return result.rows[0] || null;
  }

  /**
   * Store a new cache entry. Never overwrites — inserts a new versioned row.
   * @param {Object} entry
   */
  async _store({ provider, queryHash, queryParams, responseData, ttlHours, caseId }) {
    await pool.query(
      `INSERT INTO data_source_cache
         (provider, query_hash, query_params, response_data, fetched_at, expires_at, case_id)
       VALUES ($1, $2, $3, $4, NOW(), NOW() + INTERVAL '1 hour' * $5, $6)`,
      [provider, queryHash, queryParams, responseData, ttlHours, caseId || null]
    );
  }

  /**
   * Link an existing cache entry to a case.
   * @param {string} cacheId
   * @param {string} caseId
   */
  async _linkToCase(cacheId, caseId) {
    await pool.query(
      `UPDATE data_source_cache SET case_id = $1 WHERE id = $2 AND case_id IS NULL`,
      [caseId, cacheId]
    );
  }
}

module.exports = { DataSourceCache };
```

### File: `backend/src/data-sources/cached-provider.js`

```javascript
const { DataSourceCache } = require('./cache');

/**
 * Wraps any RegistryProvider with transparent caching.
 *
 * @param {import('./registry/types').RegistryProvider} provider
 * @param {DataSourceCache} cache
 * @returns {import('./registry/types').RegistryProvider}
 */
function withCache(provider, cache) {
  const cachedMethods = [
    'searchEntity',
    'getEntityDetails',
    'getOfficers',
    'getShareholders',
    'getFilingHistory',
    'getEntityStatus',
  ];

  const wrapped = Object.create(provider);

  for (const method of cachedMethods) {
    if (typeof provider[method] !== 'function') continue;

    wrapped[method] = function (queryParams, options = {}) {
      return cache.getOrFetch({
        provider: provider.name,
        method,
        queryParams: typeof queryParams === 'string' ? { id: queryParams } : queryParams,
        caseId: options.caseId,
        bypassCache: options.bypassCache || false,
        fetchFn: () => provider[method](queryParams),
      }).then((result) => result.data);
    };
  }

  return wrapped;
}

module.exports = { withCache };
```

### Cache Key Generation

The SHA-256 hash ensures deterministic cache keys:

```
provider + method + JSON.stringify(params)
  ↓
SHA-256 → 64-char hex string
```

Example:
```
companies-house + getEntityDetails + {"id":"01026167"}
  → "a7f3b2c1d4e5..."
```

### TTL Configuration

| Provider | Default TTL | Rationale |
|----------|-------------|-----------|
| `companies-house` | 24 hours | Company data changes infrequently |
| `ofac-sdn` | 1 hour | Sanctions lists update daily; short TTL ensures freshness |
| `uk-hmt` | 1 hour | Same as OFAC |
| Default | 24 hours | Conservative default |

TTLs can be overridden via `config/data-sources.yaml`:

```yaml
data_sources:
  registries:
    companies_house:
      cache_ttl_hours: 24
```

### Audit Trail

- Expired entries are **never deleted** — new fetches insert new rows
- `fetched_at` + `expires_at` allow reconstructing what data was available at any point in time
- `case_id` links the fetch to the case that triggered it
- `query_params` stores the original query for reproducibility

## Acceptance Criteria

- [ ] All data source responses cached in `data_source_cache` table
- [ ] Cache key is SHA-256 hash of provider name + method + query parameters
- [ ] Configurable TTL per provider
- [ ] Cache lookup returns cached data if within TTL
- [ ] Each entry linkable to a `case_id`
- [ ] `bypassCache` option forces fresh fetch
- [ ] Expired entries retained (never deleted)
- [ ] `getMetrics()` returns hit count, miss count, hit rate
- [ ] `withCache()` wraps any `RegistryProvider` transparently
- [ ] Concurrent writes don't cause data loss

## Dependencies

- **Depends on**: #14 (Provider interface), #3 (Database — `data_source_cache` table), #4 (Backend scaffold)
- **Blocks**: #15 (Companies House), #17 (OFAC), #18 (UK HMT) — all providers should be wrapped with cache

## Testing Strategy

1. **Cache miss**: Call `getOrFetch` with empty cache, verify `fetchFn` called, entry stored in DB
2. **Cache hit**: Insert valid entry, call `getOrFetch`, verify `fetchFn` NOT called, cached data returned
3. **TTL expiry**: Insert entry with expired `expires_at`, verify `fetchFn` IS called
4. **Bypass cache**: Insert valid entry, call with `bypassCache: true`, verify `fetchFn` called
5. **Hash determinism**: Same inputs always produce the same hash
6. **Hash uniqueness**: Different inputs produce different hashes
7. **Metrics**: Verify hit/miss counts after a sequence of operations
8. **Case linking**: Verify `case_id` is stored when provided
9. **Audit retention**: Verify old entries are not deleted when new ones are inserted
10. **`withCache` wrapper**: Wrap a mock provider, verify all 6 methods are cached
