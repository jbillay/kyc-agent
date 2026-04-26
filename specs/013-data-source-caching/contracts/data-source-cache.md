# Contract: DataSourceCache

**Module**: `backend/src/data-sources/cache.js`  
**Exported**: `{ DataSourceCache }`  
**Layer**: 2 (Data Integration)  
**Date**: 2026-04-26

---

## Class: `DataSourceCache`

A transparent PostgreSQL-backed cache for external data source responses. Every call to `getOrFetch` either returns a cached result or fetches from the external source and stores the response. Entries are never deleted.

### Constructor

```
new DataSourceCache(options?)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `options` | Object | No | Configuration overrides |
| `options.ttlHours` | `{ [providerName: string]: number }` | No | Per-provider TTL overrides in hours. Merged with defaults. |

**Defaults** (applied when no override is provided):

| Provider name | Default TTL |
|---------------|-------------|
| `'companies-house'` | 24 hours |
| `'ofac-sdn'` | 1 hour |
| `'uk-hmt'` | 1 hour |
| Any other provider | 24 hours |

---

### Method: `getOrFetch(params)`

The primary cache interface. Looks up a valid (non-expired) entry; on miss, calls `fetchFn`, stores the result, and returns it.

```
getOrFetch(params) → Promise<GetOrFetchResult>
```

**Parameters**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `params.provider` | string | Yes | Provider identifier, e.g. `'companies-house'` |
| `params.method` | string | Yes | Method name, e.g. `'getEntityDetails'` |
| `params.queryParams` | Object | Yes | Query parameters to hash and store |
| `params.caseId` | string (UUID) | No | KYC case that triggered this fetch |
| `params.bypassCache` | boolean | No | Default `false`. If `true`, skips lookup and always calls `fetchFn` |
| `params.fetchFn` | `() => Promise<Object>` | Yes | Called on cache miss or bypass; must return the provider response |

**Returns** `Promise<GetOrFetchResult>`:

| Field | Type | Description |
|-------|------|-------------|
| `data` | Object | The provider response (identical whether from cache or live fetch) |
| `fromCache` | boolean | `true` if served from cache; `false` if `fetchFn` was called |
| `cachedAt` | string (ISO 8601) \| null | Timestamp of the cached entry; `null` on cache miss |

**Error behaviour**:
- If `fetchFn` throws (e.g., external source unreachable), the error is **propagated directly** to the caller. No fallback, no stale entry returned (FR-014).
- If the database is unreachable during lookup, the error propagates. The cache does not attempt to fail-open.

**Cache key**: SHA-256 of `JSON.stringify({ provider, method, params: queryParams })` → 64-char hex string.

**Case linking**: If a valid cached entry exists with no `case_id` and `params.caseId` is provided, the most recent valid entry for that query key is linked to the case (FR-006). Older or expired entries are not retroactively linked.

---

### Method: `getMetrics()`

Returns a snapshot of cache hit/miss counters since last reset (or since instantiation).

```
getMetrics() → CacheMetrics
```

**Returns** `CacheMetrics`:

| Field | Type | Description |
|-------|------|-------------|
| `hits` | number | Total cache hits since last reset |
| `misses` | number | Total cache misses since last reset |
| `hitRate` | number | `hits / (hits + misses)`; `0` when no lookups performed |

Counters are in-process only — they reset on service restart.

---

### Method: `resetMetrics()`

Resets hit and miss counters to zero.

```
resetMetrics() → void
```

---

## Invariants

1. Every successful `fetchFn` call results in exactly one new row in `data_source_cache` (barring exact same-microsecond concurrent insert, which is silently skipped via `ON CONFLICT DO NOTHING`).
2. No row in `data_source_cache` is ever deleted by this module.
3. The `response_data` column of an existing row is never updated.
4. The only permitted mutation of an existing row is setting `case_id` when it is currently `NULL`.
5. `getOrFetch` with the same inputs always returns semantically equivalent data (either the same cached entry or a newly fetched equivalent).
