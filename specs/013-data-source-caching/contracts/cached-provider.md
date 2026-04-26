# Contract: withCache / withCacheScreening

**Module**: `backend/src/data-sources/cached-provider.js`  
**Exported**: `{ withCache, withCacheScreening }`  
**Layer**: 2 (Data Integration)  
**Date**: 2026-04-26

---

## Function: `withCache(provider, cache)`

Wraps a `RegistryProvider` with a transparent caching layer. The returned object satisfies the `RegistryProvider` interface — callers cannot tell whether the underlying data came from cache or a live fetch.

```
withCache(provider, cache) → RegistryProvider (cached)
```

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | `RegistryProvider` | Yes | The provider to wrap |
| `cache` | `DataSourceCache` | Yes | Cache instance to use for lookups and storage |

**Returns**: A new object that satisfies the `RegistryProvider` interface. The original `provider` is not modified.

**Wrapped methods**: The following six `RegistryProvider` methods are intercepted and routed through the cache:

| Method | Query param normalisation |
|--------|--------------------------|
| `searchEntity` | `queryParams` passed as-is (Object) |
| `getEntityDetails` | String `id` argument normalised to `{ id }` |
| `getOfficers` | String `id` argument normalised to `{ id }` |
| `getShareholders` | String `id` argument normalised to `{ id }` |
| `getFilingHistory` | String `id` argument normalised to `{ id }` |
| `getEntityStatus` | String `id` argument normalised to `{ id }` |

Methods not in this list (if any exist on the provider, e.g., custom extensions) are **not** wrapped — they delegate directly to the original provider.

**Calling convention**: Each wrapped method accepts a second optional `options` argument:

```
wrappedMethod(queryParams, options?)
```

| Field | Type | Description |
|-------|------|-------------|
| `options.caseId` | string (UUID) | KYC case ID to associate with the fetch |
| `options.bypassCache` | boolean | Default `false`. Forces a fresh fetch when `true` |

**Return value**: The wrapped method returns `Promise<data>` — identical to the original provider method. The `fromCache` / `cachedAt` envelope from `DataSourceCache.getOrFetch` is unwrapped; callers receive only the data.

---

## Function: `withCacheScreening(provider, cache)`

Wraps a `ScreeningProvider` with a transparent caching layer for the `search` method only.

```
withCacheScreening(provider, cache) → ScreeningProvider (partially cached)
```

**Parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `provider` | `ScreeningProvider` | Yes | The provider to wrap |
| `cache` | `DataSourceCache` | Yes | Cache instance to use for lookups and storage |

**Returns**: A new object that satisfies the `ScreeningProvider` interface. The original `provider` is not modified.

**Wrapped methods**:

| Method | Cached | Reason |
|--------|--------|--------|
| `search` | Yes | KYC decision method — benefits from caching for performance and audit |
| `getListMetadata` | No | Reads from local DB; caching adds no value |
| `updateList` | No | Write operation; must always contact external source |

**Calling convention for `search`**: Same `options` argument as `withCache`:

```
wrappedSearch(query, options?)
```

| Field | Type | Description |
|-------|------|-------------|
| `options.caseId` | string (UUID) | KYC case ID to associate with the fetch |
| `options.bypassCache` | boolean | Default `false`. Forces a fresh fetch when `true` |

---

## Transparency guarantee

Both wrappers preserve the original provider's `name` and all non-wrapped properties via prototype delegation (`Object.create(provider)`). Any code that reads `provider.name` or `provider.jurisdictions` (for `RegistryProvider`) will see the original values on the wrapped object.
