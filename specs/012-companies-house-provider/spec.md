# Feature Specification: UK Corporate Registry Data Source

**Feature Branch**: `012-companies-house-provider`  
**Created**: 2026-04-26  
**Status**: Draft  
**Input**: User description: "@specifications/epic-03-data-integration/015-companies-house/SPEC.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Search UK Companies by Name (Priority: P1)

A KYC analyst or agent submits a company name to find matching UK-registered companies. The system returns a ranked list of candidates with key identifying information so the correct entity can be selected for further investigation.

**Why this priority**: Company search is the entry point for all UK entity resolution cases. Without it, no subsequent data retrieval is possible, making it the foundational capability of this feature.

**Independent Test**: Can be fully tested by submitting a company name (e.g., "Barclays") and verifying that matching UK-registered companies are returned with company numbers, statuses, and incorporation dates — delivering value as a standalone company lookup tool.

**Acceptance Scenarios**:

1. **Given** a valid company name is submitted, **When** the system queries the UK corporate registry, **Then** up to 10 matching companies are returned ranked by relevance, each with company number, name, registration status, entity type, and incorporation date
2. **Given** a company name that matches no registered entities is submitted, **When** the system queries the registry, **Then** an empty result set is returned without error
3. **Given** the registry service returns a rate-limit response, **When** the system attempts to search, **Then** a clearly identified "rate limited" error is returned to the caller

---

### User Story 2 - Retrieve Full Company Profile (Priority: P1)

A KYC analyst or agent retrieves the complete profile of a specific UK company by its company number. The profile provides all registered details needed for entity verification and due diligence documentation.

**Why this priority**: Full company profiles are required for entity verification — a mandatory step in every KYC case. This directly enables the Entity Resolution Agent to confirm and document a company's legal identity.

**Independent Test**: Can be fully tested by providing company number 01026167 (Barclays Bank PLC) and verifying the returned profile contains a registered address, SIC codes, previous names with date ranges, entity type, and current status.

**Acceptance Scenarios**:

1. **Given** a valid company number, **When** the system retrieves the company profile, **Then** the registered address, SIC industry codes, previous names (with effective-from and effective-to dates), entity type, and operational status are all returned
2. **Given** a company number that does not exist in the registry, **When** the system attempts retrieval, **Then** a clearly identified "not found" error is returned
3. **Given** a company that has changed its name one or more times, **When** the profile is retrieved, **Then** all historical names with their full effective date ranges are included

---

### User Story 3 - Retrieve Officers and Directors (Priority: P2)

A KYC analyst or agent retrieves the list of current and former officers (directors, secretaries) for a UK company to identify who manages or controlled the entity, supporting connected-person due diligence and PEP screening.

**Why this priority**: Officer data is essential for identifying individuals in control of a company, which feeds directly into PEP screening and ownership chain analysis.

**Independent Test**: Can be fully tested by retrieving officers for a known company and verifying at least one director is returned with appointment date, role, nationality, and partial date of birth.

**Acceptance Scenarios**:

1. **Given** a valid company number, **When** the system retrieves officers, **Then** all current and resigned officers are returned with their roles, appointment dates, nationality, and date of birth expressed as month and year
2. **Given** an officer has resigned, **When** that officer's record is retrieved, **Then** their resignation date is included alongside the appointment date
3. **Given** a company number that does not exist, **When** the system attempts to retrieve officers, **Then** a clearly identified "not found" error is returned

---

### User Story 4 - Retrieve Persons with Significant Control (Priority: P2)

A KYC analyst or agent retrieves the Persons with Significant Control (PSC) register for a UK company to identify beneficial owners — individuals or entities with significant influence or ownership — for UBO identification and KYC due diligence.

**Why this priority**: PSC data directly supports Ultimate Beneficial Owner (UBO) identification, a core regulatory requirement. It is the primary mechanism by which UK law requires companies to disclose their beneficial owners.

**Independent Test**: Can be fully tested by retrieving PSC entries for a known company and verifying at least one entry includes name, type (individual or corporate), ownership percentage range, and nature of control.

**Acceptance Scenarios**:

1. **Given** a valid company number with PSC entries, **When** the system retrieves PSC data, **Then** each entry includes name, type (individual/corporate/other), ownership percentage range, nature of control descriptors, notification date, and cessation date where applicable
2. **Given** a PSC entry is for a corporate entity, **When** retrieved, **Then** the corporate entity's registration number and jurisdiction are included where available in the registry
3. **Given** a company with no PSC entries (e.g., a listed company exempt from filing), **When** the system retrieves PSC data, **Then** an empty list is returned without error
4. **Given** a PSC has ceased to have significant control, **When** their record is retrieved, **Then** the cessation date is included

---

### User Story 5 - Retrieve Entity Status and Compliance Flags (Priority: P2)

A KYC analyst or agent retrieves the current compliance status of a UK company, including overdue filing flags and active notices, to determine whether enhanced due diligence is warranted before proceeding with a KYC case.

**Why this priority**: Entity status determines the risk posture of a case. Overdue accounts, insolvency history, or gazette notices are red flags that may trigger mandatory enhanced scrutiny under compliance policy.

**Independent Test**: Can be fully tested by retrieving status for a company with known overdue accounts and verifying the overdue flag is correctly set, and by retrieving status for a company with insolvency history and verifying the notice appears.

**Acceptance Scenarios**:

1. **Given** a valid company number, **When** entity status is retrieved, **Then** the response includes operational status, dissolved date (if applicable), accounts overdue flag, annual return/confirmation statement overdue flag, and a list of active compliance notices
2. **Given** a company has insolvency history, **When** its status is retrieved, **Then** an insolvency-history notice is included in active notices
3. **Given** a company has previously been through liquidation, **When** its status is retrieved, **Then** a previously-liquidated notice is included in active notices

---

### User Story 6 - Retrieve Filing History (Priority: P3)

A KYC analyst or agent reviews a company's recent filings to identify significant corporate events (director changes, accounts submissions, winding-up petitions) as part of due diligence documentation.

**Why this priority**: Filing history provides documentary evidence of corporate activity over time and can surface procedural red flags, but it is supplementary to the higher-priority data points above.

**Independent Test**: Can be fully tested by retrieving filings for a known company and verifying that up to 25 recent filings are returned with type, description, and date.

**Acceptance Scenarios**:

1. **Given** a valid company number, **When** the system retrieves filing history, **Then** up to 25 recent filings are returned, each with filing type, human-readable description, date, and category

---

### Edge Cases

- When the registry service returns a transient error (5xx) or connection fails, the system retries up to 3 times with exponential backoff before surfacing the error to the caller.
- When the registry returns a rate-limit response (429) despite the local rate limiter permitting the request, the error is passed immediately to the caller as a "rate limited" error (no retry).
- When the rate limiter queue wait exceeds 30 seconds, the request fails immediately with a "rate limited" error without attempting the registry call.
- How does the system handle companies with no PSC entries (e.g., listed companies exempt from PSC registration)?
- For companies with very large officer lists, the system paginates through all registry pages to ensure every officer is returned; each page counts against the rate limit.
- What is returned when a company has been dissolved and historical data is sparse or unavailable?
- How are company names containing special characters or non-Latin script handled in search queries?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST support searching for UK-registered companies by name, returning up to 10 results ranked by relevance with company number, name, status, entity type, and incorporation date
- **FR-002**: The system MUST retrieve full company profiles by company number, including registered address, SIC codes, all historical names with effective date ranges, entity type, and operational status
- **FR-003**: The system MUST retrieve all current and resigned officers for a company by paginating through all registry pages, including role, appointment date, resignation date, nationality, and date of birth (month and year only); the complete officer list MUST be returned regardless of how many pages are required
- **FR-004**: The system MUST retrieve PSC entries for a company, including name, type (individual/corporate/other), ownership percentage range, nature of control descriptors, notification date, cessation date, and corporate registration details where available
- **FR-005**: The system MUST retrieve up to 25 recent filings for a company, including filing type, description, date, and category
- **FR-006**: The system MUST retrieve entity status including operational status, dissolved date, accounts overdue flag, annual return/confirmation statement overdue flag, and a list of active compliance notices
- **FR-007**: The system MUST preserve and return the original raw registry response data alongside all normalised fields in every response, for audit traceability
- **FR-008**: The system MUST enforce the registry's rate limit of 600 requests per 5-minute window, queuing requests as needed; if a request waits more than 30 seconds in the queue for an available token, it MUST fail immediately with a "rate limited" error rather than continuing to wait
- **FR-009**: The system MUST authenticate all registry requests using a configured API key
- **FR-010**: When a company number does not exist in the registry, the system MUST return a clearly identified "not found" error distinguishable from other error types
- **FR-011**: When the registry signals that the rate limit has been exceeded, the system MUST return a clearly identified "rate limited" error
- **FR-012**: Each registry request MUST be subject to a configurable timeout (default 10 seconds); requests that exceed this timeout MUST fail with a clear error rather than blocking indefinitely
- **FR-013**: On transient registry failures (5xx errors or connection failures), the system MUST automatically retry up to 3 times with exponential backoff before surfacing the error to the caller; rate-limit (429) and not-found (404) errors MUST NOT be retried

### Key Entities

- **Company Search Result**: A registry match for a name query — identified by company number, name, registration status, entity type, incorporation date, and relevance score
- **Company Profile**: The full registered details of a UK company — registered address, SIC industry codes, previous names with effective date ranges, entity type, and operational status
- **Officer**: A person in an official capacity at a company — with role, appointment date, resignation date (where applicable), nationality, and date of birth at month/year precision
- **Person with Significant Control (PSC)**: An individual or entity with significant influence over a company — with name, type, ownership percentage range, nature of control, notification date, cessation date, and corporate identification details where applicable
- **Filing**: A regulatory submission made by a company to the registry — with filing type, human-readable description, date, and category
- **Entity Status**: A current compliance snapshot of a company — including operational status, dissolution date, overdue filing flags, and a list of active compliance notices

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All six data retrieval operations (search, profile, officers, PSC, filings, status) return correct data for known UK companies (e.g., Barclays Bank PLC, company number 01026167) in 100% of test runs
- **SC-002**: Under normal operating conditions, company data queries complete within 10 seconds; under sustained load, the combined rate limiter queue wait and request timeout never exceeds 40 seconds before returning a result or a clear error
- **SC-003**: The system sustains the full allowed request volume (600 requests per 5-minute window) without triggering registry-side rate limit rejections
- **SC-004**: Error conditions — entity not found and rate limit exceeded — are correctly classified and distinguishable in 100% of cases, enabling downstream agents to respond appropriately
- **SC-005**: Raw registry response data is present alongside normalised fields in 100% of returned records, ensuring complete audit traceability for every data point used in a KYC decision
- **SC-006**: All requests time out and return a failure response within 10 seconds when the registry is unresponsive, preventing indefinite blocking of KYC processing

## Clarifications

### Session 2026-04-26

- Q: What should happen when the registry returns a transient error (5xx) or connection fails — no retry, single retry, or retry with backoff? → A: Retry up to 3 times with exponential backoff on transient errors (5xx, connection failure); surface as error after all retries exhausted. Rate-limit (429) and not-found (404) errors are not retried.
- Q: For companies with very large officer lists, should the system return only the first registry page or paginate to retrieve all officers? → A: Automatically paginate through all registry pages to return every officer, regardless of count.
- Q: When the rate limiter token bucket is empty, should requests wait indefinitely or be subject to a maximum queue wait time? → A: Cap queue wait at 30 seconds; return a "rate limited" error if the wait exceeds this threshold.

## Assumptions

- A valid Companies House API key is provisioned and available in the system configuration before this feature is deployed; key provisioning is out of scope
- Rate limiting is enforced as a shared constraint across all concurrent operations within a single deployment instance (not per-user or per-request)
- Date of birth for officers is available at month/year precision only, as the UK registry withholds the day component for privacy; full birthdates will not be returned
- Ownership percentages for PSC entries are reported as ranges (e.g., 25–50%), not exact figures; this is an inherent limitation of the registry data, not a system deficiency
- Companies without PSC entries (e.g., listed companies exempt from PSC filing requirements) return empty lists, not errors; the consuming agent is responsible for interpreting an empty PSC list
- Pagination beyond the first page of search results (10 results) and filing history (25 filings) is out of scope for Phase 1; officer retrieval is an exception and MUST paginate fully to support complete PEP and connected-person screening
- Response caching for audit reproducibility is a dependency managed by a separate data caching layer; this feature delivers the registry data source only and does not implement caching directly
- The system operates within a network environment that permits outbound HTTPS connections to the UK corporate registry service
