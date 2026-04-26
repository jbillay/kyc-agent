# Data Model: UK Corporate Registry Data Source (012)

All response shape types are already declared in `backend/src/data-sources/registry/types.js` and are unchanged by this feature. This document records (a) the constructor configuration shape, (b) the Companies House → `RegistryProvider` field mapping for each operation, and (c) the rate-limiter internal state.

---

## Constructor Config

```
CompaniesHouseConfig {
  apiKey          string   required   — Companies House API key
  baseUrl         string   optional   default: "https://api.company-information.service.gov.uk"
  timeoutMs       number   optional   default: 10000   (per-request HTTP timeout, ms)
  maxQueueWaitMs  number   optional   default: 30000   (max rate-limiter queue wait, ms)
}
```

Read from `config/data-sources.yaml → data_sources.registries.companies_house`.

---

## Rate-Limiter Internal State

```
_tokens         number   current token count (0–600)
_maxTokens      number   600
_refillRate     number   2 tokens/second
_lastRefill     number   Date.now() at last refill (epoch ms)
```

Not persisted. Resets on process restart.

---

## Field Mappings

### searchEntity() → EntitySearchResult[]

CH endpoint: `GET /search/companies?q={name}&items_per_page=10`

| RegistryProvider field | CH response field | Notes |
|---|---|---|
| entityId | item.company_number | Primary identifier for follow-up calls |
| name | item.title | |
| registrationNumber | item.company_number | Same as entityId for CH |
| jurisdiction | — | Always `'GB'` |
| incorporationDate | item.date_of_creation | ISO 8601 string |
| status | item.company_status | Mapped through `_mapStatus()` |
| entityType | item.company_type | CH type string (e.g., `ltd`, `plc`, `llp`) |
| relevanceScore | item.snippet | 100 if snippet present, 80 otherwise |
| rawData | item | Complete item object |

---

### getEntityDetails() → EntityDetails

CH endpoint: `GET /company/{number}`

| RegistryProvider field | CH response field | Notes |
|---|---|---|
| registrationNumber | data.company_number | |
| name | data.company_name | |
| jurisdiction | — | Always `'GB'` |
| incorporationDate | data.date_of_creation | |
| entityType | data.type | |
| registeredAddress.addressLine1 | data.registered_office_address.address_line_1 | |
| registeredAddress.addressLine2 | data.registered_office_address.address_line_2 | optional |
| registeredAddress.locality | data.registered_office_address.locality | |
| registeredAddress.region | data.registered_office_address.region | optional |
| registeredAddress.postalCode | data.registered_office_address.postal_code | |
| registeredAddress.country | data.registered_office_address.country | default: `'United Kingdom'` |
| status | data.company_status | Mapped through `_mapStatus()` |
| sicCodes | data.sic_codes | Array of strings; empty array if absent |
| previousNames[].name | pn.name | |
| previousNames[].effectiveFrom | pn.effective_from | |
| previousNames[].effectiveTo | pn.ceased_on | null if absent |
| rawData | data | Complete response object |

---

### getOfficers() → Officer[]

CH endpoint: `GET /company/{number}/officers?items_per_page=50&start_index={n}`  
Paginates until all officers are retrieved.

| RegistryProvider field | CH response field | Notes |
|---|---|---|
| name | item.name | Full name as returned |
| role | item.officer_role | CH role string (e.g., `director`, `secretary`) |
| appointedDate | item.appointed_on | ISO 8601 |
| resignedDate | item.resigned_on | Omitted if officer is active |
| nationality | item.nationality | Optional |
| dateOfBirth | item.date_of_birth | Formatted as `YYYY-MM`; day withheld by CH |
| address | item.address | Optional address object |
| rawData | item | Complete item object |

---

### getShareholders() → Shareholder[]

CH endpoint: `GET /company/{number}/persons-with-significant-control`

| RegistryProvider field | CH response field | Notes |
|---|---|---|
| name | item.name or constructed from item.name_elements | Forename + surname for individuals |
| type | item.kind | Mapped through `_classifyPSCType()`: individual / corporate / other |
| ownershipPercentage | item.natures_of_control | Extracted as range string via `_extractOwnershipPercentage()` |
| naturesOfControl | item.natures_of_control | Raw array of CH control strings |
| notifiedDate | item.notified_on | |
| ceasedDate | item.ceased_on | Optional |
| nationality | item.nationality | Optional |
| countryOfResidence | item.country_of_residence | Optional |
| registrationNumber | item.identification.registration_number | Corporate PSCs only |
| jurisdiction | item.identification.country_registered | Mapped through `_countryToCode()` |
| rawData | item | Complete item object |

**Ownership percentage ranges** (from `natures_of_control` string matching):

| CH nature-of-control string contains | Mapped range |
|---|---|
| `75-to-100` | `'75-100'` |
| `50-to-75` | `'50-75'` |
| `25-to-50` or `more-than-25` | `'25-50'` |

---

### getFilingHistory() → Filing[]

CH endpoint: `GET /company/{number}/filing-history?items_per_page=25`

| RegistryProvider field | CH response field | Notes |
|---|---|---|
| filingType | item.type | CH filing code (e.g., `AA`, `CS01`) |
| description | item.description or item.type | Falls back to type if description absent |
| date | item.date | ISO 8601 |
| category | item.category | Optional |
| rawData | item | Complete item object |

---

### getEntityStatus() → EntityStatus

CH endpoint: `GET /company/{number}` (same as getEntityDetails; different mapping)

| RegistryProvider field | CH response field | Notes |
|---|---|---|
| status | data.company_status | Mapped through `_mapStatus()` |
| dissolvedDate | data.date_of_cessation | Optional |
| accountsOverdue | data.accounts.overdue | Boolean |
| annualReturnOverdue | data.annual_return.overdue OR data.confirmation_statement.overdue | Boolean |
| activeNotices | derived | See notice derivation below |
| rawData | data | Complete response object |

**Notice derivation logic**:
- If `data.has_been_liquidated === true` → push `'previously-liquidated'`
- If `data.has_insolvency_history === true` → push `'insolvency-history'`
- If `data.company_status === 'active'` and `data.company_status_detail` is set → push the detail string

---

## Status Mapping (`_mapStatus`)

| CH company_status | Mapped status |
|---|---|
| `active` | `'active'` |
| `dissolved` | `'dissolved'` |
| `liquidation` | `'liquidation'` |
| `administration` | `'administration'` |
| `voluntary-arrangement` | `'administration'` |
| `converted-closed` | `'dissolved'` |
| `insolvency-proceedings` | `'liquidation'` |
| (any other) | `'other'` |

---

## Error Codes

| Code | HTTP trigger | Retry? |
|---|---|---|
| `NOT_FOUND` | 404 | No |
| `RATE_LIMITED` | 429, or queue wait > 30s | No |
| `TIMEOUT` | AbortController fires at 10s | Yes (counts as transient) |
| (generic) | 5xx, network error | Yes — up to 3 times with backoff |
