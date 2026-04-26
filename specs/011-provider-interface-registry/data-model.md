# Data Model: Data Source Provider Interface and Registry Abstraction

**Branch**: `011-provider-interface-registry` | **Date**: 2026-04-23

## Overview

All entities in this feature are JSDoc `@typedef` definitions — they describe shapes of objects flowing through provider interfaces, not database tables or ORM models. No persistence layer is introduced by this feature.

---

## Registry Domain

### RegistryProvider (interface)

The contract every corporate registry implementation must satisfy.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | `string` | Yes | Provider identifier, e.g. `'companies-house'` |
| `jurisdictions` | `string[]` | Yes | ISO 3166-1 alpha-2 codes; non-empty |
| `searchEntity` | `function` | Yes | `(EntitySearchQuery) → Promise<EntitySearchResult[]>` |
| `getEntityDetails` | `function` | Yes | `(entityId: string) → Promise<EntityDetails>` |
| `getOfficers` | `function` | Yes | `(entityId: string) → Promise<Officer[]>` |
| `getShareholders` | `function` | Yes | `(entityId: string) → Promise<Shareholder[]>` |
| `getFilingHistory` | `function` | Yes | `(entityId: string) → Promise<Filing[]>` |
| `getEntityStatus` | `function` | Yes | `(entityId: string) → Promise<EntityStatus>` |

**Validation rule**: `RegistryFactory.register()` asserts all 8 members are present and that `jurisdictions` is a non-empty array.

---

### EntitySearchQuery

Input to `searchEntity`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | `string` | Yes | Company name to search |
| `jurisdiction` | `string` | No | ISO 3166-1 alpha-2 |
| `registrationNumber` | `string` | No | Known registration/company number |
| `incorporationDate` | `string` | No | ISO 8601 date |

---

### EntitySearchResult

One ranked item in a `searchEntity` response. Array is empty when no results found (not an error).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `entityId` | `string` | Yes | Provider-specific identifier |
| `name` | `string` | Yes | Company name |
| `registrationNumber` | `string` | Yes | |
| `jurisdiction` | `string` | Yes | ISO 3166-1 alpha-2 |
| `incorporationDate` | `string` | No | ISO 8601 date |
| `status` | `string` | Yes | `'active'`, `'dissolved'`, etc. |
| `entityType` | `string` | No | `'limited-company'`, `'llp'`, `'plc'`, etc. |
| `relevanceScore` | `number` | No | Provider-specific ranking |
| `rawData` | `Object` | Yes | Complete unmodified API response |

---

### EntityDetails

Full company profile returned by `getEntityDetails`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `registrationNumber` | `string` | Yes | |
| `name` | `string` | Yes | |
| `jurisdiction` | `string` | Yes | ISO 3166-1 alpha-2 |
| `incorporationDate` | `string` | Yes | ISO 8601 date |
| `entityType` | `string` | Yes | |
| `registeredAddress` | `Object` | Yes | See sub-fields below |
| `registeredAddress.addressLine1` | `string` | Yes | |
| `registeredAddress.addressLine2` | `string` | No | |
| `registeredAddress.locality` | `string` | Yes | |
| `registeredAddress.region` | `string` | No | |
| `registeredAddress.postalCode` | `string` | Yes | |
| `registeredAddress.country` | `string` | Yes | |
| `status` | `'active'\|'dissolved'\|'liquidation'\|'administration'\|'other'` | Yes | Controlled vocabulary |
| `sicCodes` | `string[]` | No | |
| `previousNames` | `Array<{name, effectiveFrom, effectiveTo}>` | No | `effectiveTo` is `null` if still active |
| `rawData` | `Object` | Yes | Complete unmodified API response |

---

### Officer

One entry from `getOfficers`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | `string` | Yes | |
| `role` | `string` | Yes | `'director'`, `'secretary'`, `'llp-member'`, etc. |
| `appointedDate` | `string` | Yes | ISO 8601 date |
| `resignedDate` | `string` | No | Absent for active officers |
| `nationality` | `string` | No | |
| `dateOfBirth` | `string` | No | `'YYYY-MM'` format only (privacy-preserving) |
| `address` | `Object` | No | |
| `rawData` | `Object` | Yes | Complete unmodified API response |

---

### Shareholder

One entry from `getShareholders`. Distinguishes individual from corporate owner (FR-010).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | `string` | Yes | |
| `type` | `'individual'\|'corporate'\|'other'` | Yes | Owner classification — critical for UBO tracing |
| `ownershipPercentage` | `string` | No | May be a range string: `'25-50'`, `'75-100'` |
| `naturesOfControl` | `string[]` | No | e.g. `'ownership-of-shares-25-to-50-percent'` |
| `notifiedDate` | `string` | No | ISO 8601 date |
| `ceasedDate` | `string` | No | ISO 8601 date |
| `nationality` | `string` | No | |
| `countryOfResidence` | `string` | No | |
| `registrationNumber` | `string` | No | Corporate shareholders only |
| `jurisdiction` | `string` | No | Corporate shareholders only |
| `rawData` | `Object` | Yes | Complete unmodified API response |

**Design note**: `ownershipPercentage` is a `string` not a `number` to accommodate range values from Companies House PSC data (e.g., `'25-50'`). Callers that need numeric comparisons must parse this field themselves.

---

### Filing

One entry from `getFilingHistory`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `filingType` | `string` | Yes | e.g. `'AA'`, `'CS01'`, `'AD01'` |
| `description` | `string` | Yes | |
| `date` | `string` | Yes | ISO 8601 date |
| `category` | `string` | No | |
| `rawData` | `Object` | Yes | Complete unmodified API response |

---

### EntityStatus

Response from `getEntityStatus`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `status` | `'active'\|'dissolved'\|'liquidation'\|'administration'\|'other'` | Yes | |
| `dissolvedDate` | `string` | No | ISO 8601 date |
| `accountsOverdue` | `boolean` | Yes | |
| `annualReturnOverdue` | `boolean` | Yes | |
| `activeNotices` | `string[]` | Yes | e.g. `'compulsory-strike-off'`, `'first-gazette'` |
| `rawData` | `Object` | Yes | Complete unmodified API response |

---

## Screening Domain

### ScreeningProvider (interface)

The contract every sanctions/watch-list implementation must satisfy.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | `string` | Yes | Provider identifier, e.g. `'ofac-sdn'` |
| `listType` | `'sanctions'\|'pep'\|'adverse_media'` | Yes | |
| `search` | `function` | Yes | `(ScreeningQuery) → Promise<ScreeningHit[]>` |
| `getListMetadata` | `function` | Yes | `() → Promise<ListMetadata>` |
| `updateList` | `function` | Yes | `() → Promise<UpdateResult>` |

---

### ScreeningQuery

Input to `search`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | `string` | Yes | Name to screen |
| `entityType` | `'individual'\|'entity'` | Yes | |
| `dateOfBirth` | `string` | No | ISO 8601 or `'YYYY-MM'` |
| `nationality` | `string` | No | ISO 3166-1 alpha-2 |
| `aliases` | `string[]` | No | Known alternative names |

---

### ScreeningHit

One fuzzy match from `search`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `source` | `string` | Yes | List identifier: `'OFAC-SDN'`, `'UK-HMT'`, etc. |
| `matchedName` | `string` | Yes | Name on the list that matched |
| `matchScore` | `number` | Yes | 0–100 |
| `matchedFields` | `string[]` | Yes | Which query fields contributed to the match |
| `listEntry` | `Object` | Yes | See sub-fields below |
| `listEntry.id` | `string` | Yes | Entry identifier on the list |
| `listEntry.names` | `string[]` | Yes | All known names/aliases |
| `listEntry.dateOfBirth` | `string` | No | |
| `listEntry.nationality` | `string[]` | No | |
| `listEntry.programs` | `string[]` | No | Sanctions programs: `'SDGT'`, `'IRAN'`, etc. |
| `listEntry.remarks` | `string` | No | |
| `listEntry.listedDate` | `string` | No | |
| `rawData` | `Object` | Yes | Complete unmodified list entry |

---

### ListMetadata

Response from `getListMetadata`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `listName` | `string` | Yes | |
| `listType` | `string` | Yes | |
| `sourceUrl` | `string` | Yes | |
| `lastUpdated` | `string` | Yes | ISO 8601 timestamp |
| `entryCount` | `number` | Yes | |

---

### UpdateResult

Response from `updateList`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `updated` | `boolean` | Yes | `false` when source was unchanged |
| `entriesAdded` | `number` | Yes | 0 when `updated` is false |
| `entriesRemoved` | `number` | Yes | 0 when `updated` is false |
| `entriesModified` | `number` | Yes | 0 when `updated` is false |
| `timestamp` | `string` | Yes | ISO 8601 timestamp of the update check |

---

## Factory

### RegistryFactory

Runtime routing component — not a type definition.

| Method | Signature | Behaviour |
|--------|-----------|-----------|
| `register(provider)` | `(RegistryProvider) → void` | Validates contract (FR-014), warns on overwrite (FR-013), stores by uppercased jurisdiction codes |
| `getProvider(jurisdiction)` | `(string) → RegistryProvider` | Case-insensitive lookup; throws `NO_REGISTRY_PROVIDER` if not found |
| `getSupportedJurisdictions()` | `() → string[]` | Returns all registered uppercased codes |

**Error codes thrown by factory**:
- `NO_REGISTRY_PROVIDER` — `getProvider()` called with unregistered jurisdiction
- `INVALID_PROVIDER` — `register()` called with an object missing required fields or methods

**Warning emitted by factory**:
- `REGISTRY_PROVIDER_OVERWRITTEN` — structured JSON to `console.warn` on duplicate jurisdiction registration
