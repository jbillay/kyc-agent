# Quickstart: OFAC SDN Ingestion and Search

**Branch**: `014-ofac-sdn-ingestion`

## Prerequisites

- Docker Compose stack running: `docker-compose up postgres redis`
- Node.js 22+: `cd backend && npm install`
- `fast-xml-parser` added to dependencies: `cd backend && npm install fast-xml-parser`

## Environment

```bash
DATABASE_URL=postgres://kyc:kyc@localhost:5432/kyc_agent
CONFIG_DIR=./config
```

## Running Tests

```bash
# All backend tests
cd backend && npm test

# This feature's unit tests only
cd backend && npx jest tests/backend/data-sources/screening/ofac.test.js

# Integration tests (requires running PostgreSQL)
cd backend && npx jest tests/backend/data-sources/screening/screening-sync.integration.test.js
```

> **Note**: Integration tests are blocked until `fuzzy-matcher.js` (spec #19) is implemented. Unit tests use a mock `FuzzyMatcher` and run independently.

## Triggering a Manual Sync

```bash
# Run the sync worker once (exits after sync)
cd backend && node -e "
  require('./src/services/config-service').getConfigService().load();
  require('./src/workers/screening-sync').syncScreeningLists()
    .then(results => console.log(JSON.stringify(results, null, 2)));
"
```

## Checking List Status

```javascript
const { OFACProvider } = require('./src/data-sources/screening/ofac');
const { FuzzyMatcher } = require('./src/data-sources/screening/fuzzy-matcher');

const provider = new OFACProvider({}, new FuzzyMatcher());
provider.getListMetadata().then(console.log);
// { listName: 'OFAC-SDN', entryCount: 12435, isStale: false, lastUpdated: '2026-04-27T02:00:00.000Z', ... }
```

## Searching the List

```javascript
const hits = await provider.search({
  name: 'John Doe',
  entityType: 'individual',
  dateOfBirth: '1970-01-01',
  nationality: 'IR',
});
// Returns ScreeningHit[] sorted by matchScore descending
```

## Database Schema

The feature introduces one new table. Apply to an existing deployment:

```bash
cd backend && npm run migrate:up
```

For a fresh deployment, the table is created automatically via `backend/db/init.sql`.

## Key Files

| File | Purpose |
|------|---------|
| `backend/src/data-sources/screening/ofac.js` | `OFACProvider` implementation |
| `backend/src/data-sources/screening/fuzzy-matcher.js` | Dependency — spec #19 |
| `backend/src/data-sources/screening/types.js` | Shared JSDoc types |
| `backend/src/workers/screening-sync.js` | Daily sync worker |
| `backend/db/init.sql` | Schema bootstrap (includes `screening_sync_events`) |
| `config/screening-sources.yaml` | Source URL, schedule, threshold |
| `tests/backend/data-sources/screening/ofac.test.js` | Unit tests |
| `tests/backend/data-sources/screening/screening-sync.integration.test.js` | Integration tests |

## Configuration

Edit `config/screening-sources.yaml` to adjust the match threshold:

```yaml
screening_sources:
  ofac_sdn:
    match_threshold: 70   # increase for fewer false positives; decrease for higher recall
```
