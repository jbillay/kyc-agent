# Feature Specification: UK HMT Sanctions List Ingestion and Search

**Feature Branch**: `015-uk-hmt-ingestion`  
**Created**: 2026-04-27  
**Status**: Draft  
**Input**: UK HMT Sanctions List Ingestion and Search

## Clarifications

### Session 2026-04-27

- Q: When the CSV download fails, what should the system do? → A: Retry up to 3 times with short delays before raising an error; existing entries remain unchanged on final failure.
- Q: How frequently should the automated sync check for list updates? → A: Daily (once every 24 hours).
- Q: When a query DOB and a stored DOB have different precision (e.g. "1985-03-15" vs "1985"), does the DOB score boost apply? → A: Yes — partial match qualifies; the boost applies whenever the known parts of both values agree.
- Q: How should the system handle a DOB value that does not match any known format (e.g. "circa 1970")? → A: Store the raw value unchanged; it will not match any DOB query so the score boost will never fire for that entry's DOB field.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Screen an Entity Against the UK HMT Sanctions List (Priority: P1)

A compliance analyst submits a person or organisation name (with optional date of birth and nationality) for screening against the locally cached UK HMT consolidated sanctions list. The system returns a ranked list of potential matches with confidence scores, indicating which sanctioned entries are similar to the queried subject.

**Why this priority**: Sanctions screening is a hard regulatory requirement for UK-regulated firms. Without the ability to search the list, the feature provides no business value.

**Independent Test**: Can be fully tested by inserting a known HMT entry into the local store, submitting a search query, and verifying a match is returned with a score above the threshold — without requiring a live CSV download.

**Acceptance Scenarios**:

1. **Given** a known sanctioned individual is in the local store, **When** a query is submitted with their exact name, **Then** the result includes that individual with a match score at or near maximum and the matched fields include "name".
2. **Given** a known sanctioned individual is in the local store, **When** a query is submitted with a variant spelling of their name, **Then** the result includes that individual with a partial match score above the configured threshold.
3. **Given** a match is found and the query includes a date of birth whose known parts agree with the stored DOB (exact or partial, e.g. query "1985-03-15" against stored "1985"), **When** the search runs, **Then** the returned hit has a higher score than a name-only match for the same entry.
4. **Given** a match is found and the query includes a matching nationality, **When** the search runs, **Then** the score reflects the nationality bonus.
5. **Given** no entries in the local store match the queried name above the threshold, **When** the search runs, **Then** an empty result set is returned with no error.
6. **Given** the query includes an entity type filter (e.g. "individual"), **When** the search runs, **Then** only entries of that entity type are evaluated.

---

### User Story 2 - Ingest and Refresh the UK HMT Sanctions List (Priority: P2)

A system operator (or automated daily scheduler) triggers a list update. The system downloads the latest UK HMT consolidated CSV, parses it, and stores all entries in the local database. On subsequent runs, the system updates changed entries, removes delisted entries, and leaves unchanged entries untouched.

**Why this priority**: The local store must be populated and kept current before searches can succeed. Idempotent updates allow safe scheduled execution without manual intervention.

**Independent Test**: Can be fully tested by running the update twice against a fixed CSV fixture and verifying: the first run creates entries, the second run produces zero additions, removals, or modifications.

**Acceptance Scenarios**:

1. **Given** the local store is empty and a valid HMT CSV is available, **When** the update runs, **Then** all entries from the CSV are stored and the list metadata reflects the correct entry count and a recent timestamp.
2. **Given** the local store already contains the current list, **When** the update runs again with the same CSV, **Then** no entries are added, removed, or modified.
3. **Given** a new CSV contains one additional entry, **When** the update runs, **Then** exactly one entry is added and the count increments by one.
4. **Given** a new CSV omits a previously listed entry, **When** the update runs, **Then** that entry is removed from the local store.
5. **Given** multiple CSV rows share the same Group ID (one per alias or address), **When** the CSV is parsed, **Then** a single entry is stored for that Group ID with all aliases collected.
6. **Given** a row has a "Primary Name" name-type designation, **When** parsed, **Then** that name becomes the entry's primary name; all other names for that Group ID become aliases.
7. **Given** a CSV field contains an embedded comma wrapped in double quotes, **When** parsed, **Then** the field is read correctly as a single value with no data corruption.

---

### User Story 3 - Check UK HMT List Metadata (Priority: P3)

A compliance officer or system monitor queries the status of the locally cached UK HMT list to confirm it is present, how many entries it contains, and when it was last refreshed.

**Why this priority**: Operational visibility into list currency is needed to detect stale data or ingestion failures, but it does not block screening from functioning.

**Independent Test**: Can be fully tested by reading list metadata immediately after a successful ingestion and verifying the returned values match the ingested data.

**Acceptance Scenarios**:

1. **Given** a successful list ingestion has occurred, **When** list metadata is requested, **Then** the response includes the list name, source URL, last-updated timestamp, and entry count.
2. **Given** no ingestion has ever run, **When** list metadata is requested, **Then** the response indicates zero entries and a null last-updated date without error.

---

### Edge Cases

- What happens when a Group ID has only AKA rows and no "Primary Name" row — which name becomes the primary?
- A DOB value that does not match any known format (e.g. "circa 1970") is stored as-is; it will not match any DOB query and the score boost will not fire for that field.
- If the CSV download fails or returns an error status, the system retries up to 3 times with short delays. If all retries fail, an error is raised and the existing local entries remain unchanged.
- How are rows where all six Name1–Name6 fields are blank treated during parsing?
- How does the system behave when a CSV row has fewer columns than expected?
- What happens when the same nationality or program appears on multiple rows for the same Group ID — is it deduplicated?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST download the UK HMT consolidated sanctions list from the official GOV.UK source URL. If the download fails, the system MUST retry up to 3 times with short delays before raising an error; existing entries MUST remain unchanged if all retries fail.
- **FR-002**: The system MUST assemble each entry's full name by joining all non-empty Name1–Name6 fields with a space separator.
- **FR-003**: The system MUST group all CSV rows sharing the same Group ID into a single sanctions entry.
- **FR-004**: The system MUST designate the name from a "Primary Name" row as the entry's primary name; all other names for that Group ID MUST be stored as aliases.
- **FR-005**: If no "Primary Name" row exists for a Group ID, the system MUST fall back to the first name encountered for that group as the primary name.
- **FR-006**: The system MUST normalise date-of-birth values: DD/MM/YYYY becomes YYYY-MM-DD, MM/YYYY becomes YYYY-MM, and a bare four-digit year is stored as-is. Values that do not match any of these formats MUST be stored as-is (raw); they will not match any DOB query and will not trigger the score boost.
- **FR-007**: The system MUST extract nationality values and collect all distinct nationalities across all rows sharing the same Group ID.
- **FR-008**: The system MUST extract sanctions regime/program values and collect all distinct programs per Group ID.
- **FR-009**: The system MUST classify each entry as either an individual or an organisation based on the Group Type column value ("Individual" maps to individual; all other values map to organisation).
- **FR-010**: The system MUST support filtering search queries by entity type so that only entries of the specified type are evaluated.
- **FR-011**: The system MUST perform an idempotent upsert when ingesting: existing entries are updated if changed, new entries are added, and entries absent from the new list are removed.
- **FR-012**: The system MUST record a last-updated timestamp and total entry count for the list after each successful ingestion.
- **FR-021**: The automated sync worker MUST trigger list ingestion once every 24 hours.
- **FR-013**: The system MUST support fuzzy name matching for search queries evaluated against all names (primary and aliases) of each entry.
- **FR-014**: Search results MUST be ranked in descending order of match score.
- **FR-015**: The system MUST increase a match score when the query's date of birth matches the entry's stored date of birth. A match is defined as: all known parts of both values agree — for example, a query of "1985-03-15" matches a stored value of "1985" because the year agrees; a query of "1985-03-15" does not match a stored value of "1990".
- **FR-016**: The system MUST increase a match score when the query's nationality matches any nationality stored for that entry.
- **FR-017**: The system MUST only return entries whose best name score meets or exceeds the configured match threshold.
- **FR-018**: The CSV parser MUST correctly handle quoted fields containing embedded commas and escaped double-quote characters.
- **FR-019**: The CSV parser MUST skip rows with fewer columns than required without raising an error.
- **FR-020**: The system MUST skip rows where all Name1–Name6 fields are empty, producing no name entry for that row.

### Key Entities

- **Sanctions Entry**: A sanctioned individual or organisation, identified by a unique Group ID, with a primary name, zero or more aliases, optional date of birth, zero or more nationalities, one or more sanctions programs, an entity type (individual / organisation), and a listing date.
- **Screening Query**: A search request specifying the subject's name and optionally their date of birth, nationality, and entity type.
- **Screening Hit**: A match result referencing the source entry, the best-matched name, the composite match score, and the list of fields (name, date of birth, nationality) that contributed to scoring.
- **List Metadata**: A record of the UK HMT list's source URL, last ingestion timestamp, and current entry count.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Full list ingestion of the complete UK HMT CSV completes in under 30 seconds on standard infrastructure.
- **SC-002**: A search query against the full locally cached list returns results in under 500 milliseconds.
- **SC-003**: A search with an exact name match returns the corresponding entry with the maximum possible match score.
- **SC-004**: A search with a recognisable variant spelling of a sanctioned name returns that entry with a score above the configured threshold.
- **SC-005**: Running list ingestion twice against the same source data produces zero net changes on the second run.
- **SC-006**: CSV fields containing commas or embedded quotation marks are parsed into correct single-field values with no data corruption.
- **SC-007**: Entity type classification correctly distinguishes individuals from organisations for all entries in the list.
- **SC-008**: All names appearing in the HMT CSV — both primary and AKA — are evaluated during search and contribute to match scoring.

## Assumptions

- The UK HMT consolidated sanctions list CSV is publicly accessible at the official GOV.UK URL without authentication or rate limiting under normal conditions.
- The CSV column structure (Group ID at column 2, Name1–Name6 at columns 3–8, DOB at column 12, Nationality at column 15, Regime at column 25, Listed On at column 26) is stable across routine list updates; a structural change to the CSV format would require a parser update.
- The fuzzy matching threshold and scoring algorithm are configured externally and shared with other sanctions list providers; this feature does not own or define those parameters.
- The database tables required to store list metadata and individual entries already exist with the correct schema prior to ingestion.
- A network timeout of 60 seconds is sufficient for downloading the CSV under normal network conditions.
- Address columns and other fields not listed in the column mapping (e.g. passport number, NI number) are preserved in raw form for auditability but are not individually indexed or used in matching.
- "Entity" as a Group Type value is treated as an organisation; any non-"Individual" value is also treated as an organisation.
