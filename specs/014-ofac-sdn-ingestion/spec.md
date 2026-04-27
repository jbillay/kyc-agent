# Feature Specification: OFAC SDN Sanctions List Ingestion and Search

**Feature Branch**: `014-ofac-sdn-ingestion`  
**Created**: 2026-04-27  
**Status**: Draft  
**Input**: User description: "OFAC SDN Sanctions List Ingestion and Search"

## Clarifications

### Session 2026-04-27

- Q: Is the minimum match confidence threshold fixed or configurable, and what is the default value? → A: Configurable with a default of 70%.
- Q: When a sync download fails, should the system retry automatically or wait for the next scheduled run? → A: Retry up to 3 times with exponential backoff, then fail and wait for the next scheduled run.
- Q: Should sync run outcomes (counts, errors, timestamps) be recorded persistently for compliance audit purposes? → A: Yes — record each sync run outcome in the persistent audit event store.
- Q: Should the system alert when the SDN list has not been successfully updated within an acceptable window? → A: Yes — alert when the list has not been successfully updated for more than 24 hours.
- Q: Do consuming screening agents call the search via a programmatic in-process function or through a REST endpoint? → A: Programmatic function only — no REST endpoint is in scope for this feature.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Screen a Name Against the SDN List (Priority: P1)

A compliance officer needs to screen a customer or counterparty name against the OFAC Specially Designated Nationals (SDN) list to determine whether they are subject to US sanctions. The system searches the locally stored list and returns any matches with confidence scores, allowing the officer to evaluate whether the match is a true hit or a false positive.

**Why this priority**: Sanctions screening is a legal obligation before onboarding any customer. Without this capability the entire screening workflow is blocked, and no KYC cases can be completed.

**Independent Test**: Can be fully tested by submitting a known sanctioned name and verifying a high-confidence match is returned, and by submitting an unrelated name and verifying no match is returned.

**Acceptance Scenarios**:

1. **Given** the SDN list has been loaded locally, **When** a compliance officer screens the exact name of a sanctioned individual, **Then** the system returns a match with a score of 100 and includes the entry's aliases, date of birth, nationalities, sanctions programs, and remarks.
2. **Given** the SDN list has been loaded locally, **When** a compliance officer screens a name that is slightly misspelled relative to a sanctioned individual, **Then** the system returns a partial-score match above the minimum threshold.
3. **Given** the SDN list has been loaded locally, **When** the query also provides a date of birth matching the SDN entry, **Then** the returned match score is higher than a name-only match.
4. **Given** the SDN list has been loaded locally, **When** the query also provides a nationality matching the SDN entry, **Then** the returned match score is higher than a name-only match.
5. **Given** the SDN list has been loaded locally, **When** a compliance officer screens a name with no resemblance to any SDN entry, **Then** the system returns no matches.

---

### User Story 2 - Keep the Local SDN List Current (Priority: P2)

An operations administrator (or automated scheduler) triggers a sync to update the local SDN list from the official US Treasury source. The system downloads the latest list, identifies which entries are new, changed, or removed, and applies those changes so that subsequent screening reflects the most current designations.

**Why this priority**: An outdated list exposes the institution to regulatory and legal risk. The update mechanism must be reliable and auditable, but the screening search (P1) can function independently once the list is loaded for the first time.

**Independent Test**: Can be fully tested by running the sync twice with unchanged source data and verifying that the second run reports zero additions, removals, or modifications.

**Acceptance Scenarios**:

1. **Given** no local SDN data exists, **When** the sync is triggered, **Then** the system downloads the full list and stores all entries, reporting the count of entries added.
2. **Given** the local SDN list is already loaded, **When** the sync is triggered and the source list is unchanged, **Then** the system reports zero additions, zero removals, and zero modifications.
3. **Given** the local SDN list is loaded, **When** the sync is triggered and new entries have been added to the source, **Then** those entries are added locally and the count is reported.
4. **Given** the local SDN list is loaded, **When** the sync is triggered and entries have been removed from the source, **Then** those entries are removed from the local store and the count is reported.
5. **Given** the sync is triggered, **When** the download fails due to a network error, **Then** the system retries up to 3 times with exponential backoff before giving up; the existing local data is preserved throughout and an error is reported once retries are exhausted.
6. **Given** a sync run completes (successfully or with a final failure), **When** the outcome is recorded, **Then** the audit event store contains an immutable entry with the timestamp, counts of entries added/removed/modified, and any error details.

---

### User Story 3 - Detect and Surface a Stale SDN List (Priority: P2)

A compliance officer or monitoring system detects that the local SDN list has not been successfully updated for more than 24 hours and raises an alert, enabling the team to investigate and remediate before a second sync cycle is missed.

**Why this priority**: A silently stale sanctions list is a regulatory risk. This story ensures operational failures do not go unnoticed; elevated to P2 alongside list sync because it is a direct safety net for that flow.

**Independent Test**: Can be fully tested by simulating an elapsed time of over 24 hours since last successful sync and verifying an alert is raised.

**Acceptance Scenarios**:

1. **Given** the last successful sync completed more than 24 hours ago, **When** the system evaluates list freshness, **Then** an alert is raised indicating the list is stale.
2. **Given** a successful sync completes, **When** the system evaluates list freshness, **Then** no stale alert is raised.

---

### User Story 4 - Inspect Sanctions List Metadata (Priority: P3)

A compliance officer or administrator checks the status of the local SDN list — when it was last updated, how many entries it contains, and where it was sourced from — to confirm the list is current before relying on screening results.

**Why this priority**: Metadata visibility supports audit and governance. It is useful but does not block screening or sync operations.

**Independent Test**: Can be fully tested by triggering a sync and then retrieving metadata, verifying the last-updated timestamp and entry count reflect the sync result.

**Acceptance Scenarios**:

1. **Given** the SDN list has been synced at least once, **When** metadata is requested, **Then** the system returns the last update timestamp, total entry count, and source URL.
2. **Given** the SDN list has never been synced, **When** metadata is requested, **Then** the system returns a response indicating no data is available (zero entries, null last-updated date).

---

### Edge Cases

- What happens when the SDN source is temporarily unavailable during a scheduled sync?
- How are entries with no first name (corporate entities) stored and matched?
- How are partial or ambiguous date of birth formats (e.g., year only, "circa" dates) handled during DOB matching?
- What happens if an entry is removed from the source list between two consecutive syncs?
- How does the system handle very large alias lists on a single entry?
- What if the source list contains duplicate UIDs?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST obtain the current OFAC SDN list from the official US Treasury sanctions list source.
- **FR-002**: System MUST store all SDN entries locally, capturing: primary name, all known aliases, date of birth (when available), nationalities, sanctions programs, and remarks.
- **FR-003**: System MUST handle both individual persons and corporate/organizational entities as distinct entry types.
- **FR-004**: System MUST support searching the local SDN list by name using fuzzy matching to account for spelling variations and transliteration differences.
- **FR-005**: System MUST score each match on a 0–100 scale and apply a bonus when the query's date of birth matches the entry.
- **FR-006**: System MUST apply a further score bonus when the query's nationality matches the entry's recorded nationalities.
- **FR-007**: System MUST return only matches that meet or exceed a minimum confidence threshold; that threshold MUST be configurable with a default value of 70%.
- **FR-008**: System MUST return results ordered from highest to lowest match score.
- **FR-009**: System MUST update the local list in an idempotent manner — running the sync multiple times with the same source data produces the same stored state.
- **FR-010**: System MUST remove entries from local storage that are no longer present in the official source list.
- **FR-011**: System MUST track list metadata: source URL, date of last successful update, and total entry count.
- **FR-012**: System MUST expose list metadata so it can be retrieved on demand.
- **FR-013**: System MUST be designed to run the sync on a scheduled daily basis without manual intervention.
- **FR-014**: System MUST retry a failed sync download up to 3 times with exponential backoff before recording the failure and waiting for the next scheduled run.
- **FR-015**: System MUST record every sync run outcome — timestamp, entries added, entries removed, entries modified, and any error — as an immutable entry in the platform audit event store.
- **FR-016**: System MUST raise an alert when the SDN list has not been successfully updated for more than 24 hours.

### Key Entities

- **SDN Entry**: A designated individual or organisation on the OFAC SDN list. Key attributes: unique identifier, entity type (individual or entity), primary name, aliases, date of birth, nationalities, sanctions programs, free-text remarks.
- **Screening Match**: A candidate result produced when searching the list. Includes: the matched name, a numeric confidence score, which fields contributed to the match (name, DOB, nationality), and the full SDN entry details.
- **List Record**: Metadata about the local copy of the SDN list. Includes: source URL, date of last update, total entry count.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Full ingestion of the complete OFAC SDN list completes in under 60 seconds.
- **SC-002**: A name search against the full locally stored list returns results in under 500 milliseconds.
- **SC-003**: Running the list sync twice consecutively with no changes to the source data produces zero added, removed, or modified entries on the second run.
- **SC-004**: All SDN entry fields — names, aliases, date of birth, nationalities, sanctions programs, remarks — are accurately stored and retrievable after ingestion.
- **SC-005**: Entries removed from the official source list are absent from local storage after the next sync completes.
- **SC-006**: An alert is raised within one evaluation cycle when the SDN list has not been successfully updated for more than 24 hours.

## Assumptions

- The official OFAC SDN list is publicly available at the US Treasury sanctions list service without authentication.
- Fuzzy name matching and confidence scoring are provided by a separate matching component; this feature consumes that component's interface.
- The underlying database schema (tables for list metadata and list entries) is already provisioned as part of the platform foundation.
- A daily sync cadence is sufficient for regulatory compliance; real-time or event-driven update mechanisms are out of scope.
- Only the primary OFAC SDN list is in scope; other OFAC consolidated lists (e.g., non-SDN lists) are separate features.
- Screening results are consumed by other agents through a programmatic in-process function call; no REST endpoint for sanctions search is in scope for this feature.
- The first name + last name fields in the source data are combined into a single primary name for storage and matching purposes.
- When an entry has multiple dates of birth listed, only the first is used for matching.
