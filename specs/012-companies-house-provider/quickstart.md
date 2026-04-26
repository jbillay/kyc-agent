# Quickstart: UK Corporate Registry Data Source (012)

## Prerequisites

- Node.js 22+
- A valid Companies House API key (obtain free from https://developer.companieshouse.gov.uk)
- Docker Compose stack running (or just `postgres` + `redis` if testing locally)

## Configuration

Uncomment and complete the `companies_house` block in `config/data-sources.yaml`:

```yaml
# config/data-sources.yaml (as implemented)
data_sources:
  registries:
    companies_house:
      api_key: "${COMPANIES_HOUSE_API_KEY}"
      base_url: "https://api.company-information.service.gov.uk"
      timeout_ms: 10000        # per-request HTTP timeout (ms)
      max_queue_wait_ms: 30000 # max time to wait in rate-limiter queue (ms)
      retry_attempts: 3        # retries on transient 5xx/connection errors
      rate_limit:
        requests: 600
        period_seconds: 300
      cache_ttl_hours: 24
```

Set the environment variable:

```bash
export COMPANIES_HOUSE_API_KEY=your_api_key_here
```

## Usage

```javascript
const { CompaniesHouseProvider } = require('./backend/src/data-sources/registry/companies-house');
const { RegistryFactory } = require('./backend/src/data-sources/registry-factory');

const provider = new CompaniesHouseProvider({
  apiKey: process.env.COMPANIES_HOUSE_API_KEY,
});

const factory = new RegistryFactory();
factory.register(provider);

// Search by name
const results = await factory.getProvider('GB').searchEntity({ name: 'Barclays' });

// Full profile
const profile = await factory.getProvider('GB').getEntityDetails('01026167');

// Officers (all pages)
const officers = await factory.getProvider('GB').getOfficers('01026167');

// PSC / UBOs
const shareholders = await factory.getProvider('GB').getShareholders('01026167');

// Filing history
const filings = await factory.getProvider('GB').getFilingHistory('01026167');

// Entity status + compliance flags
const status = await factory.getProvider('GB').getEntityStatus('01026167');
```

## Running Tests

```bash
# Unit tests (no API key required — HTTP is mocked)
cd backend && npx jest ../tests/backend/data-sources/companies-house.test.js

# Integration tests (requires COMPANIES_HOUSE_API_KEY)
cd backend && COMPANIES_HOUSE_API_KEY=your_key npx jest ../tests/backend/data-sources/companies-house.integration.test.js
```

## Error Handling

```javascript
try {
  const profile = await provider.getEntityDetails('INVALID123');
} catch (err) {
  if (err.code === 'NOT_FOUND') {
    // Company number does not exist
  } else if (err.code === 'RATE_LIMITED') {
    // Either registry returned 429, or queue wait exceeded 30s
  } else {
    // Transient error that persisted after 3 retries
  }
}
```
