# Feature Specification: Data Source Response Caching and Versioning

**Feature Branch**: `013-data-source-caching`  
**Created**: 2026-04-26  
**Status**: Draft  
**Input**: User description: "@specifications/epic-03-data-integration/016-data-caching/SPEC.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Transparent Cached Data Access (Priority: P1)

A KYC agent performs a data lookup (e.g., company registry details, sanctions check) and receives a response. The agent does not need to know whether the data came from an external provider or a local cache — the result is identical either way. If a valid cached response exists within its freshness window, it is returned instantly without contacting the external source.

**Why this priority**: This is the core caching behaviour that delivers performance and cost savings on every data fetch. Without it, the feature has no value.

**Independent Test**: Can be fully tested by triggering the same data lookup twice and verifying the second call returns without contacting the external source, delivering the same data.

**Acceptance Scenarios**:

1. **Given** a data lookup has been performed and a valid cached response exists, **When** the same lookup is requested within the freshness window, **Then** the cached response is returned without contacting the external source.
2. **Given** no cached response exists, **When** a data lookup is requested, **Then** the external source is contacted, the response is stored for future use, and the data is returned to the caller.
3. **Given** a cached response exists but its freshness window has expired, **When** a data lookup is requested, **Then** the external source is contacted, a new response is stored, and the fresh data is returned.

---

### User Story 2 - Audit-Proof Evidence Trail (Priority: P2)

A compliance officer reviewing a past KYC case needs to prove exactly what external data was available at the time a decision was made. They can retrieve the precise cached response that was in use at decision time, including when it was fetched and which case triggered it. Old cache entries are never deleted.

**Why this priority**: Regulatory audit reproducibility is a primary design goal of the KYC platform. Without this, the system cannot satisfy audit or compliance obligations.

**Independent Test**: Can be fully tested by inserting a cache entry, advancing time past its freshness window, performing a new fetch (which creates a new entry), and verifying the original entry still exists and is retrievable.

**Acceptance Scenarios**:

1. **Given** a cached entry has expired, **When** a fresh fetch is performed, **Then** the original entry is still present and queryable — it is not deleted or overwritten.
2. **Given** a KYC case triggered a data fetch, **When** the cache is inspected, **Then** the entry is linked to that case and includes the original query parameters and fetch timestamp.
3. **Given** multiple fetches for the same query over time, **When** audit history is reviewed, **Then** all historical responses are available in chronological order.

---

### User Story 3 - Per-Provider Freshness Configuration (Priority: P3)

An operations team member needs different data sources to remain fresh for different durations — sanctions lists must be near-real-time while company registry data can be reused for longer. Each data source has a configurable freshness window that controls how long a cached response is considered valid.

**Why this priority**: Different data sources have different volatility profiles. A single global TTL would either over-fetch stable data or under-fetch volatile data, degrading both performance and accuracy.

**Independent Test**: Can be fully tested by configuring two providers with different freshness windows and verifying that a cached response is still served for the longer-window provider after an interval that has expired the shorter-window provider.

**Acceptance Scenarios**:

1. **Given** a provider is configured with a 1-hour freshness window, **When** a cached response is 90 minutes old, **Then** the external source is contacted for a fresh response.
2. **Given** a provider is configured with a 24-hour freshness window, **When** a cached response is 12 hours old, **Then** the cached response is returned without contacting the external source.
3. **Given** no freshness window is configured for a provider, **When** a lookup is performed, **Then** a default freshness window is applied.

---

### User Story 4 - Forced Refresh (Priority: P4)

An analyst investigating a case suspects that cached data may be stale or incorrect. They can trigger a forced refresh that bypasses the cache entirely, fetches fresh data from the external source, and stores it as a new cache entry — without deleting the previous entry.

**Why this priority**: Operational trust requires the ability to override the cache when circumstances demand it, while preserving the audit trail.

**Independent Test**: Can be fully tested by storing a cached response, invoking a forced refresh, and verifying that the external source was contacted, a new entry was stored, and the old entry still exists.

**Acceptance Scenarios**:

1. **Given** a valid cached response exists, **When** a forced refresh is requested, **Then** the external source is contacted regardless of cache freshness.
2. **Given** a forced refresh is performed, **When** the cache is inspected, **Then** a new entry exists alongside the previous entry — the previous entry is not deleted or modified.

---

### User Story 5 - Cache Performance Monitoring (Priority: P5)

An operations team member needs visibility into cache effectiveness. They can retrieve metrics showing how many lookups were served from cache versus the external source, and the overall cache hit rate.

**Why this priority**: Without metrics, the team cannot assess whether the cache is functioning correctly or whether freshness window configuration needs tuning.

**Independent Test**: Can be fully tested by performing a series of cache hits and misses and verifying that the metrics counters reflect the correct counts and derived hit rate.

**Acceptance Scenarios**:

1. **Given** a series of cache lookups have been performed, **When** metrics are requested, **Then** the response includes the total number of cache hits, the total number of cache misses, and a hit rate expressed as a proportion.
2. **Given** metrics counters have accumulated, **When** a reset is requested, **Then** the counters return to zero.

---

### Edge Cases

- When two requests for the same query arrive simultaneously with no cached entry, both may contact the external source and both writes succeed — two entries are retained as valid audit records. The lookup always returns the most recent valid entry.
- When the external source is unavailable and no cached entry exists, the caching layer propagates the error directly to the caller — no stale fallback, no silent swallow.
- When a lookup is made with a case identifier and the same query was previously cached without one, the most recent valid (non-expired) entry for that query key is linked to the case — no new entry is created, and older or expired entries are not retroactively linked.
- What happens when a provider name is unrecognised and has no configured freshness window — is the default applied gracefully?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST store every external data source response in persistent storage at the time it is fetched.
- **FR-002**: The cache lookup key MUST be deterministically derived from the provider identity, the operation name, and the query parameters — the same inputs must always produce the same key.
- **FR-003**: Each data source MUST have a configurable freshness window; responses within that window MUST be served from the local store without contacting the external source.
- **FR-004**: When no valid cached response exists, the system MUST fetch from the external source and store the response before returning it to the caller.
- **FR-005**: Each cache entry MUST support association with the KYC case that triggered the fetch.
- **FR-006**: When a cached entry has no associated case and a subsequent request supplies one, the system MUST link the most recent valid (non-expired) entry for that query key to that case — older or expired entries are not retroactively linked.
- **FR-007**: The system MUST support a bypass option that forces a fresh fetch from the external source regardless of cache state.
- **FR-008**: Expired or superseded cache entries MUST be retained permanently and MUST NOT be deleted under any normal operating condition.
- **FR-009**: The system MUST expose metrics reporting the number of cache hits, the number of cache misses, and the derived hit rate.
- **FR-010**: Metrics counters MUST support a reset operation that returns all counts to zero.
- **FR-011**: Concurrent writes to the store for the same query MUST both succeed and be retained — the system uses an insert-always strategy; both entries are valid audit records. The lookup MUST return the most recent valid entry.
- **FR-012**: The caching layer MUST be transparent to callers — returned data MUST be identical whether served from the local store or the external source.
- **FR-013**: The caching layer MUST work with both registry data sources (e.g., company lookups) and screening data sources (e.g., sanctions lists).
- **FR-014**: When a fetch is attempted, no valid cached entry exists, and the external source is unreachable, the caching layer MUST propagate the failure to the caller without providing a fallback response.

### Key Entities

- **Cache Entry**: Represents a stored external data response. Key attributes: unique identifier, provider identity, deterministic lookup key, original query parameters, response payload, fetch timestamp, expiry timestamp, linked case identifier (nullable).
- **Provider**: An external data source with an identity and an associated freshness window. The freshness window determines how long a cache entry for that provider is considered valid.
- **Cache Metrics**: A runtime snapshot of cache usage. Attributes: hit count (lookups served from local store), miss count (lookups that contacted the external source), hit rate (hits as a proportion of total lookups).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Cache lookups complete in under 50 milliseconds — significantly faster than any external API call.
- **SC-002**: 100% of external data fetches result in a stored cache entry before the response is returned to the caller.
- **SC-003**: Zero cache entries are deleted under any normal operating condition; the total entry count is monotonically non-decreasing.
- **SC-004**: A forced refresh never results in loss of the previous cached entry for the same query.
- **SC-005**: Concurrent writes for the same query produce no data loss and no entry corruption.
- **SC-006**: Metrics accurately reflect the hit and miss counts for any sequence of lookups, with zero drift between actual operations and reported counts.
- **SC-007**: Changing a provider's freshness window takes effect for all subsequent lookups without requiring a restart.

## Clarifications

### Session 2026-04-26

- Q: When the external source is unavailable and no cached entry exists, what should the caching layer do? → A: Propagate the error — surface the failure directly to the caller with no fallback.
- Q: Does the caching layer need its own access control or data protection posture? → A: Inherit the existing platform security model — no additional controls at the cache layer itself.
- Q: When two concurrent misses for the same query both attempt to write simultaneously, what is the correct outcome? → A: Both writes succeed — two entries are retained, both valid audit records; the lookup returns the most recent valid entry.
- Q: When retroactively linking a case to an existing unlinked entry and multiple unlinked entries exist for the same query key, which should be linked? → A: Link only the most recent valid (non-expired) entry for that query key.

## Assumptions

- The persistent storage layer is already available and operational; this feature does not create the underlying store, only uses it.
- The storage structure for cache entries already exists with fields for provider identity, lookup key, query parameters, response payload, fetch timestamp, expiry timestamp, and case identifier.
- A KYC case identifier is available as optional context at the time of a data fetch; the caching layer accepts but does not require it.
- Both registry providers (company lookups) and screening providers (sanctions lists) are in scope; adverse media providers are out of scope for this feature.
- The default freshness window for providers without explicit configuration is 24 hours.
- Metrics counters are in-process and non-persistent; they reset on service restart. Persistent metrics storage is out of scope.
- The forced-refresh option is an operational capability invoked by the calling agent or service; it does not need to be a user-facing UI control in this iteration.
- The caching layer does not implement its own access control or encryption. Security for cached data is provided by the existing platform model (database-level access controls and API-layer RBAC).
