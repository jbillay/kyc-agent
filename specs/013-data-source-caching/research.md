# Research: Data Source Response Caching and Versioning

**Branch**: `013-data-source-caching` | **Date**: 2026-04-26

## Decision 1 — Concurrent Write Strategy (FR-011)

**Question**: The `data_source_cache` table has a UNIQUE constraint on `(provider, query_hash, fetched_at)`. Since `fetched_at` defaults to `NOW()` (PostgreSQL transaction start time, microsecond precision), two concurrent inserts could theoretically conflict if their transactions begin at exactly the same microsecond.

**Decision**: Use `INSERT ... ON CONFLICT DO NOTHING`.

**Rationale**: The clarification confirmed both concurrent writes should succeed without error. `ON CONFLICT DO NOTHING` satisfies this: if a conflict occurs (same provider + hash + timestamp, extremely rare), the second insert silently skips rather than throwing. No data is lost — the first write already stored the equivalent response. This is fully consistent with the append-only, audit-preserving model and avoids the need for any application-level locking or coordination.

**Alternatives considered**:
- Plain `INSERT` (no conflict clause) — rejected because a constraint violation would propagate as an error, violating FR-011.
- Application-level deduplication lock — rejected as unnecessary complexity for a near-impossible race condition.
- Change the UNIQUE constraint to exclude `fetched_at` — rejected because it would require a DB migration and the existing constraint is intentional (allows multiple entries for the same query key at different times, which is the versioning model).

---

## Decision 2 — DB Pool Access Pattern

**Question**: `backend/db/connection.js` exports `{ query, getClient }` (named wrapper functions), not the `Pool` object directly. The SPEC.md design calls `pool.query(...)`. Which pattern should the implementation use?

**Decision**: Use the exported `query` function: `const { query } = require('../db/connection')`.

**Rationale**: The `query` wrapper is the established pattern in this codebase — it adds slow-query logging (> 1000ms warning) and is the form used throughout existing service code. Using `pool.query` directly would bypass this instrumentation and tightly couple to the pool internals. The `getClient` function is for multi-statement transactions; the cache needs only simple single-statement queries, so `query` is sufficient.

**Alternatives considered**:
- Import `Pool` directly from `pg` and create a new pool — rejected; the shared pool already manages connection limits configured via environment variables.
- Use `getClient` for all cache operations — rejected; unnecessary overhead for single-statement queries with no transaction requirements.

---

## Decision 3 — ScreeningProvider Wrapping

**Question**: The SPEC.md `withCache` function wraps the 6 `RegistryProvider` methods. FR-013 requires the cache to work with both `RegistryProvider` and `ScreeningProvider`. `ScreeningProvider` has a different interface: `search`, `getListMetadata`, `updateList`. Which methods should be cached for screening providers?

**Decision**: Implement a separate `withCacheScreening(provider, cache)` function that caches only the `search` method. `getListMetadata` and `updateList` are NOT cached.

**Rationale**: 
- `search` is the lookup method used during KYC screening decisions — caching it delivers the audit reproducibility and performance benefits required.
- `getListMetadata` returns metadata about the local list (entry count, last update timestamp). It reads from the local `screening_lists` table, not an external API. Caching it would add no value and could serve stale metadata.
- `updateList` is a write operation that fetches and indexes a fresh list. It must always hit the external source; caching would be semantically incorrect.

**Alternatives considered**:
- Single generic `withCache(provider, cache, methods)` accepting an explicit method list — considered but rejected in favour of two named functions. Two explicit wrappers make the intent clearer and are harder to misuse (no risk of accidentally caching `updateList`).
- Cache `getListMetadata` — rejected; it queries local DB state, not an external source.

---

## Decision 4 — TTL Configuration Source

**Question**: `DataSourceCache` accepts per-provider TTL overrides in its constructor. Where does the calling code obtain TTL values — from `ConfigService` or hardcoded defaults?

**Decision**: `DataSourceCache` ships with sensible hardcoded defaults (companies-house: 24h, ofac-sdn: 1h, uk-hmt: 1h, default: 24h) that match what is already in `config/data-sources.yaml`. Callers that want to override pass `options.ttlHours` sourced from `ConfigService.dataSources`. The cache does not import `ConfigService` directly — it accepts overrides at construction time.

**Rationale**: Keeping `DataSourceCache` free of a `ConfigService` dependency simplifies testing (no config file loading required), aligns with the existing codebase pattern (dependencies injected, not self-resolved), and the defaults already match the YAML values. For the initial implementation, the defaults are sufficient; integrating with `ConfigService` is the caller's responsibility.

**Alternatives considered**:
- Import `getConfigService()` inside `cache.js` — rejected because it couples the cache to the singleton, making unit tests require a loaded config.
- No defaults at all (require explicit TTL for every provider) — rejected; would break callers that don't configure every possible provider.

---

## Decision 5 — Hash Input Serialisation

**Question**: The query hash is SHA-256 of `JSON.stringify({ provider, method, params })`. JSON object key ordering is not guaranteed in all JavaScript environments (though V8/Node.js preserves insertion order). Could two logically identical queries produce different hashes if objects have different key ordering?

**Decision**: Accept the SPEC.md design of `JSON.stringify({ provider, method, params: queryParams })` with no additional sorting. Document this as a known constraint.

**Rationale**: Node.js (V8) preserves object insertion order for non-integer keys and this is stable within a single runtime version. In practice, provider method call sites construct `queryParams` objects in deterministic order (same source code path each time). Adding a recursive key-sort would add complexity without meaningful benefit for this codebase. If key-ordering becomes an issue, it can be addressed in a future patch.

**Alternatives considered**:
- Recursive key-sort before JSON.stringify — adds ~10 lines of utility code and is safer for long-term correctness. Deferred for now.
- Use a canonical serialisation library — overkill for this use case.

---

## Decision 6 — Unrecognised Provider Fallback (Edge Case 4)

**Question**: The last edge case from the spec asks: "What happens when a provider name is unrecognised and has no configured freshness window — is the default applied gracefully?"

**Decision**: Yes — the `DataSourceCache` constructor sets a `defaultTTLHours = 24`. Any provider not present in `this.ttlHours` falls back to `this.defaultTTLHours`. This is intentional and should be tested explicitly.

**Rationale**: Strict failure on unknown providers would break the cache for any new provider added to the data sources before its TTL is explicitly configured. Silent fallback to the 24h default is safe and conservative.

**Alternatives considered**:
- Throw on unknown provider — rejected; too brittle for new provider onboarding.
- Log a warning on unknown provider — worth adding as a developer signal, but not required by the spec.
