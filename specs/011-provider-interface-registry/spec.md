# Feature Specification: Data Source Provider Interface and Registry Abstraction

**Feature Branch**: `011-provider-interface-registry`  
**Created**: 2026-04-23  
**Status**: Draft  
**Input**: User description: "@specifications/epic-03-data-integration/014-provider-interface/SPEC.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Route Data Requests by Jurisdiction (Priority: P1)

A KYC agent needs to look up company information for an entity in a specific country. Rather than hard-coding which data source to call, the agent asks a central registry for the appropriate provider based on the country code. The system returns the correct provider, and the agent calls it using a consistent interface regardless of which underlying source is used.

**Why this priority**: This is the core routing capability that all downstream agents depend on. Without it, no agent can query registry data in a provider-agnostic way. Everything else — Companies House, SEC EDGAR, future providers — plugs into this contract.

**Independent Test**: Can be fully tested by registering a mock provider for jurisdiction "GB", then calling `getProvider("GB")` and verifying the returned object is the mock provider. Delivers a working routing system end-to-end without any real external provider.

**Acceptance Scenarios**:

1. **Given** a provider registered for jurisdiction "GB", **When** a caller requests the provider for "GB", **Then** the registered provider is returned
2. **Given** a provider registered for jurisdiction "GB", **When** a caller requests the provider for "gb" (lowercase), **Then** the same provider is returned (case-insensitive)
3. **Given** no provider registered for jurisdiction "XX", **When** a caller requests the provider for "XX", **Then** a clear error is raised identifying the unsupported jurisdiction
4. **Given** a provider covering multiple jurisdictions ["GB", "IE"], **When** a caller requests either "GB" or "IE", **Then** the same provider is returned for both

---

### User Story 2 - Query Corporate Registry Data with Consistent Structure (Priority: P2)

A KYC agent performing entity resolution queries a corporate registry to search for a company by name, retrieve its full profile, and check current officers, shareholders, filing history, and status. All of these operations follow a consistent contract regardless of which registry is the underlying source, and every response includes the raw data from the source for audit purposes.

**Why this priority**: The consistent interface is what allows the agent framework to be written once and work against any registry. Without a defined contract, each agent would need provider-specific code, breaking the abstraction layer.

**Independent Test**: Can be fully tested by implementing a mock `RegistryProvider` that satisfies all six methods, calling each method, and verifying that responses conform to the expected data shapes including `rawData` fields.

**Acceptance Scenarios**:

1. **Given** a valid entity search query with a company name, **When** `searchEntity` is called, **Then** results include entity identifiers, names, jurisdictions, statuses, and raw source data
2. **Given** a known entity identifier, **When** `getEntityDetails` is called, **Then** the response includes registration details, address, incorporation date, entity type, status, and raw source data
3. **Given** a known entity identifier, **When** `getOfficers` is called, **Then** each officer record includes name, role, appointment date, and raw source data
4. **Given** a known entity identifier, **When** `getShareholders` is called, **Then** each shareholder record identifies whether the holder is an individual or corporate entity, ownership stake, and raw source data
5. **Given** a known entity identifier, **When** `getEntityStatus` is called, **Then** the response includes current status, overdue indicators, active notices, and raw source data

---

### User Story 3 - Screen Against Sanctions and Watch Lists (Priority: P2)

A KYC agent performing sanctions screening queries a watch-list provider (such as OFAC SDN or UK HMT) using a consistent interface. The agent can search by name, check when the list was last updated, and trigger a refresh from the source. All matches return a score and the raw list entry for audit.

**Why this priority**: Screening is a parallel concern to registry lookup and uses an equally important contract. Defining it here ensures that OFAC, HMT, and future list providers can all be swapped without changing agent code.

**Independent Test**: Can be fully tested by implementing a mock `ScreeningProvider`, calling `search`, `getListMetadata`, and `updateList`, and verifying responses conform to expected shapes including match scores and raw list entries.

**Acceptance Scenarios**:

1. **Given** a screening query with a name and entity type, **When** `search` is called, **Then** results include match scores (0-100), the matched name, which fields contributed to the match, and raw list entry data
2. **Given** a configured screening provider, **When** `getListMetadata` is called, **Then** the response includes list name, type, source URL, last-updated timestamp, and entry count
3. **Given** a configured screening provider, **When** `updateList` is called, **Then** the response reports whether new data was found and counts of entries added, removed, and modified

---

### Edge Cases

- What happens when a provider is registered for a jurisdiction that already has a provider? (The factory overwrites the existing entry AND emits a structured warning event so the conflict is visible in logs — silent overwrite would hide startup misconfiguration)
- What happens when `searchEntity` returns zero results? (Empty array is a valid response, not an error)
- What happens when a shareholder's ownership percentage is a range rather than a precise figure? (The `ownershipPercentage` field accepts range strings such as "25-50")
- What happens when an officer has no resignation date? (The `resignedDate` field is optional and absent for active officers)
- What happens when `updateList` is called and the source is unchanged? (Response indicates `updated: false` with zero counts)
- What happens when a provider call fails (network timeout, rate-limit, malformed response)? Provider implementations MUST throw a typed error object with a `code` property (e.g., `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `ENTITY_NOT_FOUND`), consistent with the factory's `NO_REGISTRY_PROVIDER` error shape, so agents can programmatically distinguish failure modes

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a corporate registry interface that defines six operations: search by name/criteria, retrieve full entity profile, retrieve officers, retrieve shareholders, retrieve filing history, and retrieve current entity status
- **FR-002**: The system MUST provide a sanctions/watch-list screening interface that defines three operations: search for matches, retrieve list metadata, and trigger a list update from source
- **FR-003**: The system MUST provide a registry factory that accepts registration of provider implementations and routes requests to the correct provider based on a two-letter country code
- **FR-004**: The registry factory MUST match jurisdiction codes case-insensitively (both "GB" and "gb" resolve to the same provider)
- **FR-005**: The registry factory MUST raise a clear, identifiable error when a caller requests a provider for a jurisdiction that has no registered implementation
- **FR-006**: The registry factory MUST support querying which jurisdictions have a registered provider
- **FR-007**: A single provider MUST be registerable for multiple jurisdictions simultaneously
- **FR-008**: Every response from a registry provider operation MUST include the original raw data returned by the underlying source, preserving the complete audit record
- **FR-009**: Every screening match result MUST include the original raw list entry, preserving the complete audit record
- **FR-010**: Shareholder records MUST distinguish between individual persons and corporate entities as owner types
- **FR-011**: All provider implementations MUST be stateless — they hold no mutable state between calls and can be safely shared across concurrent agent executions
- **FR-012**: When a provider operation fails (network error, rate limit, unexpected response from external source), the provider MUST throw a typed error object with a `code` property identifying the failure class (e.g., `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `ENTITY_NOT_FOUND`), following the same error shape convention as the factory's `NO_REGISTRY_PROVIDER` error
- **FR-013**: When a provider is registered for a jurisdiction that already has a registered provider, the factory MUST overwrite the existing entry AND emit a structured warning (observable in logs) identifying the jurisdiction and both the old and new provider names, so startup misconfiguration is detectable without halting the boot sequence
- **FR-014**: The `register()` method MUST validate that the supplied provider satisfies the interface contract (all required fields and methods present) at the point of registration and throw a typed error if the contract is not met, ensuring misconfigured providers are caught at startup before any agent call is attempted

### Key Entities

- **RegistryProvider**: Represents a corporate data source for one or more jurisdictions. Exposes a name, the list of jurisdiction codes it covers, and the six lookup operations.
- **ScreeningProvider**: Represents a sanctions or watch-list source. Exposes a name, the list type (sanctions, PEP, adverse media), and the three operations.
- **EntitySearchQuery**: The input criteria for searching a corporate registry — at minimum a company name, optionally with jurisdiction, registration number, and incorporation date.
- **EntitySearchResult**: A single ranked result from a registry search, including entity identifier, name, jurisdiction, status, entity type, relevance score, and raw source data.
- **EntityDetails**: The full company profile returned for a known entity — registration details, address, entity type, incorporation date, status, SIC codes, previous names, and raw source data.
- **Officer**: A named individual or entity holding a formal role (director, secretary, etc.) at a company, with appointment and optional resignation dates.
- **Shareholder**: A person or corporate entity with an ownership stake or nature of control in a company, including type classification (individual or corporate).
- **Filing**: A single document or event in a company's filing history, identified by filing type code, description, and date.
- **EntityStatus**: The current operational state of a company including status category, dissolved date if applicable, overdue flags, and active regulatory notices.
- **ScreeningQuery**: The input for a sanctions search — a name, entity type (individual or entity), and optionally date of birth, nationality, and known aliases.
- **ScreeningHit**: A single match result from a sanctions list, including the source list, matched name, numeric match score, contributing fields, the full list entry, and raw source data.
- **ListMetadata**: Descriptive information about a screening list — name, type, source URL, last-updated timestamp, and total entry count.
- **UpdateResult**: The outcome of a list refresh operation — whether new data was found and counts of entries added, removed, and modified.
- **RegistryFactory**: The routing component that maps jurisdiction codes to registered `RegistryProvider` instances and enforces the contract for unsupported jurisdictions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Any new corporate registry source can be integrated by implementing the defined provider contract without modifying any existing agent or factory code
- **SC-002**: Any new sanctions list source can be integrated by implementing the defined screening contract without modifying any existing screening agent code
- **SC-003**: All six registry operations and all three screening operations are exercisable via independently testable contracts using mock implementations, with no real external calls required
- **SC-004**: 100% of response objects across both interfaces carry a `rawData` field, ensuring every agent decision can be traced back to its exact source data
- **SC-005**: Jurisdiction routing resolves correctly for all registered codes regardless of case, with zero ambiguity errors for supported jurisdictions
- **SC-006**: An unsupported jurisdiction raises an error that unambiguously identifies which code was requested, enabling agents to log actionable diagnostic information

## Clarifications

### Session 2026-04-23

- Q: When a provider call fails (network error, rate limit, malformed response), how should the error be surfaced to callers? → A: Standardized typed errors — providers throw objects with a `code` property (e.g., `PROVIDER_UNAVAILABLE`, `RATE_LIMITED`, `ENTITY_NOT_FOUND`) consistent with the factory's existing `NO_REGISTRY_PROVIDER` error shape
- Q: When a provider is registered for a jurisdiction that already has a provider, should the factory overwrite silently, warn and overwrite, or throw? → A: Emit a structured warning identifying the jurisdiction and both provider names, then overwrite — visible in logs without halting startup
- Q: Should `register()` validate the provider satisfies the interface contract at registration time, or defer to call time? → A: Validate at registration — throw a typed error immediately if required fields or methods are missing, so misconfiguration surfaces at startup

## Assumptions

- The registry factory is populated at application startup by registering known providers; there is no dynamic discovery or hot-reload of providers at runtime
- Providers do not manage their own HTTP connections or credentials within the interface contract — those concerns belong to each concrete implementation
- The `rawData` field is the complete, unmodified response payload from the underlying external source, stored as a structured object (not serialised string)
- Ownership percentage ranges (e.g., "25-50") are a known characteristic of certain registries (such as Companies House PSC data) and are intentionally modelled as strings rather than numbers
- Date of birth for officers is stored at month/year granularity only, reflecting the privacy-preserving format provided by registries such as Companies House
- The provider interface does not prescribe pagination behaviour — individual implementations may handle pagination internally and return a complete flat list
- This feature defines contracts and the factory routing mechanism only; no real external API integrations are included in scope
- The backend scaffold (issue #4) is already in place as a prerequisite
