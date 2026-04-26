# Implementation Plan: UK Corporate Registry Data Source

**Branch**: `012-companies-house-provider` | **Date**: 2026-04-26 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/012-companies-house-provider/spec.md`

## Summary

Implement `CompaniesHouseProvider` — the UK corporate registry integration at Layer 2 of the KYC Agent data integration layer. The provider implements the existing `RegistryProvider` interface, fetching company data (search, profiles, officers, PSC, filings, entity status) from the Companies House API. Key cross-cutting behaviours: token-bucket rate limiting with a 30-second queue wait cap, 10-second per-request timeout, and 3-retry exponential backoff on transient failures. Officer retrieval paginates all registry pages to ensure completeness for PEP and connected-person screening.

## Technical Context

**Language/Version**: Node.js 22 (JavaScript; JSDoc types; no TypeScript)  
**Primary Dependencies**: Native `fetch` + `AbortController` (Node 22 built-in); no new npm packages required  
**Storage**: N/A for this feature — response caching is deferred to `cache.js` (separate feature #16)  
**Testing**: Jest, test roots at `tests/backend/` (`cd backend && npm test`)  
**Target Platform**: Linux Docker container (`docker-compose up`); standalone deployment  
**Performance Goals**: 10s timeout per HTTP request; 30s max rate-limiter queue wait; 600 requests per 5-minute window sustained  
**Constraints**: No hardcoded API keys; all parameters via `config/data-sources.yaml`; no new npm dependencies; Layer 2 only (no upward dependencies)  
**Scale/Scope**: Single provider class covering GB jurisdiction; consumed by Entity Resolution Agent and Ownership Agent

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Auditability First | ✅ PASS | Every response shape includes `rawData` (raw CH response) for audit traceability; caching for replay deferred to cache layer |
| II. LLM-Agnostic Provider Interface | ✅ N/A | Layer 2 makes no LLM calls |
| III. Strict Layered Architecture | ✅ PASS | Layer 2 only; no dependency on Layer 3+ |
| IV. Data Sovereignty & Standalone | ✅ PASS | Provider is an in-process class; no data leaves the deployment boundary; API key configured locally |
| V. Configuration-Driven Compliance Logic | ✅ PASS | All parameters (apiKey, baseUrl, timeoutMs, maxQueueWaitMs) read from `data-sources.yaml` |

**Post-design re-check**: All gates pass. No violations. Complexity Tracking table not required.

## Project Structure

### Documentation (this feature)

```text
specs/012-companies-house-provider/
├── plan.md              ← this file
├── research.md          ← Phase 0 complete
├── data-model.md        ← Phase 1 complete
├── quickstart.md        ← Phase 1 complete
├── contracts/
│   └── companies-house-provider.md   ← Phase 1 complete
├── checklists/
│   └── requirements.md
└── tasks.md             ← Phase 2 output (/speckit.tasks — not yet created)
```

### Source Code (repository root)

```text
backend/src/data-sources/
├── registry/
│   ├── companies-house.js    ← IMPLEMENT (currently a stub)
│   └── types.js              ← complete; no changes needed
└── cache.js                  ← out of scope for this feature (stub)

config/
└── data-sources.yaml         ← UNCOMMENT + EXTEND companies_house section

tests/backend/data-sources/
├── registry-factory.test.js  ← existing; no changes
└── companies-house.test.js   ← CREATE (unit tests, HTTP mocked)
```

**Structure Decision**: Layer 2 backend only. No frontend, no API layer, no database schema changes. The provider is a plain JavaScript class registered with `RegistryFactory` for the `'GB'` jurisdiction.

## Implementation Notes

### Key private methods

| Method | Purpose |
|---|---|
| `_get(path)` | HTTP GET with auth header, rate limiting, timeout, and retry |
| `_acquireToken()` | Token-bucket rate limiter with 30s queue wait cap |
| `_retry(fn, attempts)` | Exponential backoff wrapper (200/400/800 ms); skips on 404/429 |
| `_paginateOfficers(companyNumber)` | Fetches all officer pages (50/page) and concatenates results |
| `_mapStatus(chStatus)` | Maps CH status string to `RegistryProvider` status enum |
| `_classifyPSCType(kind)` | Maps CH PSC kind to `individual` / `corporate` / `other` |
| `_extractOwnershipPercentage(naturesOfControl)` | Extracts ownership range string from CH control descriptors |
| `_countryToCode(country)` | Maps country name to ISO 3166-1 alpha-2 code |

### Config extension (data-sources.yaml)

Add to the existing commented-out `companies_house` block:
- `timeout_ms: 10000`
- `max_queue_wait_ms: 30000`
- `retry_attempts: 3`

### Test coverage targets

**Unit (mocked HTTP)**:
- `searchEntity`: name→results mapping, empty results, rate-limit error passthrough
- `getEntityDetails`: full field mapping, 404 error, previous names
- `getOfficers`: DOB formatting (YYYY-MM), resignation date, multi-page pagination
- `getShareholders`: type classification, ownership extraction, corporate PSC fields, empty list
- `getFilingHistory`: field mapping, description fallback
- `getEntityStatus`: status mapping, overdue flags, notice derivation
- Rate limiter: token exhaustion → wait → release; 30s cap fires correctly
- Retry: 3 attempts on 5xx, no retry on 404/429, success on 3rd attempt
- Timeout: AbortController fires, error propagates

**Integration (live API, skipped without API key)**:
- Search "Barclays" → results include Barclays Bank PLC
- `getEntityDetails('01026167')` → active status
- `getOfficers('01026167')` → at least one director
- `getShareholders('01026167')` → PSC data present or empty list (listed company)
