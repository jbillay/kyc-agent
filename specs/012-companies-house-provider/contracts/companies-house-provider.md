# Contract: CompaniesHouseProvider

**Layer**: 2 — Data Integration  
**Interface implemented**: `RegistryProvider` (`backend/src/data-sources/registry/types.js`)  
**File**: `backend/src/data-sources/registry/companies-house.js`

---

## Constructor

```javascript
new CompaniesHouseProvider(config)
```

| Parameter | Type | Required | Default |
|---|---|---|---|
| config.apiKey | string | Yes | — |
| config.baseUrl | string | No | `'https://api.company-information.service.gov.uk'` |
| config.timeoutMs | number | No | `10000` |
| config.maxQueueWaitMs | number | No | `30000` |

**Throws**: nothing at construction time. Invalid config manifests as errors on first call.

---

## Public Methods (RegistryProvider interface)

All methods are `async` and return a `Promise`.

### `searchEntity(query) → Promise<EntitySearchResult[]>`

| Param | Type | Required |
|---|---|---|
| query.name | string | Yes |
| query.jurisdiction | string | No |
| query.registrationNumber | string | No |

- Returns up to 10 results ranked by registry relevance
- Returns `[]` when no matches found
- Throws on HTTP error (see Error Codes)

### `getEntityDetails(companyNumber) → Promise<EntityDetails>`

| Param | Type |
|---|---|
| companyNumber | string |

- Throws `{ code: 'NOT_FOUND' }` if company number does not exist

### `getOfficers(companyNumber) → Promise<Officer[]>`

- Paginates all registry pages (50 per page); returns complete list
- Returns `[]` if no officers are registered
- Throws `{ code: 'NOT_FOUND' }` if company does not exist

### `getShareholders(companyNumber) → Promise<Shareholder[]>`

- Returns all PSC entries in a single registry call (no pagination needed)
- Returns `[]` for companies with no PSC obligation (e.g., listed companies)
- Throws `{ code: 'NOT_FOUND' }` if company does not exist

### `getFilingHistory(companyNumber) → Promise<Filing[]>`

- Returns up to 25 most recent filings (single page, no pagination)
- Returns `[]` if no filings exist

### `getEntityStatus(companyNumber) → Promise<EntityStatus>`

- Throws `{ code: 'NOT_FOUND' }` if company does not exist

---

## Error Codes

All errors are plain `Error` objects augmented with a `code` property.

| code | statusCode | Meaning |
|---|---|---|
| `'NOT_FOUND'` | 404 | Company number does not exist in the registry |
| `'RATE_LIMITED'` | 429 | Registry returned 429, or queue wait exceeded `maxQueueWaitMs` |
| (none) | 5xx | Transient error surfaced after 3 retries with exponential backoff |

---

## Rate-Limiter Behaviour

- Token bucket: 600 tokens max, refills at 2/second
- If insufficient tokens: waits proportionally
- If wait would exceed `maxQueueWaitMs` (default 30s): throws `{ code: 'RATE_LIMITED' }` immediately
- If registry returns 429 anyway: throws `{ code: 'RATE_LIMITED' }` immediately (no retry)

---

## Retry Behaviour

- Transient errors (5xx, connection failure, timeout): retry up to 3 times
- Backoff delays: 200 ms, 400 ms, 800 ms
- 404 and 429 errors: never retried

---

## Registration

```javascript
const { CompaniesHouseProvider } = require('./registry/companies-house');
const { RegistryFactory } = require('./registry-factory');

const provider = new CompaniesHouseProvider({
  apiKey: config.data_sources.registries.companies_house.api_key,
  timeoutMs: config.data_sources.registries.companies_house.timeout_ms,
  maxQueueWaitMs: config.data_sources.registries.companies_house.max_queue_wait_ms,
});

const factory = new RegistryFactory();
factory.register(provider); // registers for 'GB'
```
