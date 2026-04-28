# Quickstart: UK HMT Sanctions List

**Feature**: 015-uk-hmt-ingestion  
**Date**: 2026-04-27

## What Gets Built

Three changes across two files, plus a new test file:

| File | Change |
|------|--------|
| `backend/src/data-sources/screening/uk-hmt.js` | Replace 4-line stub with full `UKHMTProvider` class |
| `backend/src/workers/screening-sync.js` | Uncomment 3 lines to register `UKHMTProvider` |
| `tests/backend/data-sources/screening/uk-hmt.test.js` | New unit test suite |

No database migrations. No new dependencies.

---

## Running Tests

```bash
# Run just the UK HMT test suite
cd backend && npx jest tests/backend/data-sources/screening/uk-hmt.test.js

# Run all screening tests
cd backend && npx jest tests/backend/data-sources/screening/

# Run the full backend test suite
cd backend && npm test
```

---

## Running a Manual Sync

With the full stack running:

```bash
# Trigger a one-off sync (runs all registered providers including UK HMT)
docker-compose exec screening-sync node -e "
  const { syncScreeningLists } = require('./src/workers/screening-sync');
  syncScreeningLists().then(r => console.log(JSON.stringify(r, null, 2)));
"
```

Expected output (first run):

```json
[
  {
    "provider": "uk-hmt",
    "updated": true,
    "entriesAdded": 2847,
    "entriesRemoved": 0,
    "entriesModified": 0,
    "timestamp": "2026-04-27T..."
  }
]
```

Expected output (second run, no changes):

```json
[
  {
    "provider": "uk-hmt",
    "updated": false,
    "entriesAdded": 0,
    "entriesRemoved": 0,
    "entriesModified": 0,
    "timestamp": "2026-04-27T..."
  }
]
```

---

## Configuration

The source URL and sync schedule are already declared in `config/screening-sources.yaml`:

```yaml
screening_sources:
  uk_hmt:
    type: "sanctions"
    source_url: "https://assets.publishing.service.gov.uk/media/ConList.csv"
    format: "csv"
    sync_schedule: "0 3 * * *"   # Daily at 3 AM
```

To override the source URL (e.g. for testing with a local fixture):

```yaml
screening_sources:
  uk_hmt:
    source_url: "http://localhost:9999/ConList-fixture.csv"
```

---

## Searching the List (Once Populated)

The provider is consumed by the Screening Agent (spec #27–28). For direct use in tests or REPL:

```javascript
const { UKHMTProvider } = require('./backend/src/data-sources/screening/uk-hmt');
const { FuzzyMatcher } = require('./backend/src/data-sources/screening/fuzzy-matcher');

const provider = new UKHMTProvider({}, new FuzzyMatcher());

const hits = await provider.search({
  name: 'John Smith',
  entityType: 'individual',
  dateOfBirth: '1970-01-01',
});
// Returns ScreeningHit[] sorted by matchScore descending
```

---

## Test Fixture Format

Unit tests use inline CSV strings to avoid network calls. The minimum valid HMT CSV for testing (two rows sharing a Group ID — one Primary Name, one AKA):

```
Last Updated,Group Type,Group ID,Name1,Name2,Name3,Name4,Name5,Name6,Name Type,Alias Quality,Title,DOB,Town of Birth,Country of Birth,Nationality,Passport Number,NI Number,Position,Address1,Address2,Address3,Address4,Address5,Address6,Country,Regime,Listed On
01/04/2026,Individual,12345,DOE,John,,,,,Primary Name,,Mr,01/01/1970,,,,,,,,,,,,,,Iran Sanctions,15/03/2020
01/04/2026,Individual,12345,SMITH,John,,,,,AKA,,,,,,,,,,,,,,,,Iran Sanctions,
```

This produces one entry:
- `entry_id`: `'12345'`
- `entity_type`: `'individual'`
- `primary_name`: `'DOE John'`
- `aliases`: `['SMITH John']`
- `date_of_birth`: `'1970-01-01'`
- `nationalities`: `[]`
- `programs`: `['Iran Sanctions']`
