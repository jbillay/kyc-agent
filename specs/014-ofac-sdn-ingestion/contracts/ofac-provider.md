# Contract: OFACProvider

**Branch**: `014-ofac-sdn-ingestion`  
**Interface type**: Programmatic (in-process function calls — no REST endpoint)  
**Layer**: Layer 2 — Data Integration (`backend/src/data-sources/screening/`)  
**Consumers**: Screening Agent (spec #27), sync worker (`backend/src/workers/screening-sync.js`)

---

## Construction

```javascript
const { OFACProvider } = require('./data-sources/screening/ofac');
const { FuzzyMatcher } = require('./data-sources/screening/fuzzy-matcher');

const fuzzyMatcher = new FuzzyMatcher();
const provider = new OFACProvider(
  {
    sourceUrl: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML',
    matchThreshold: 70,   // optional; defaults to 70
  },
  fuzzyMatcher
);
```

**Constructor parameters**

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `config.sourceUrl` | `string` | No | Defaults to Treasury SDN endpoint |
| `config.matchThreshold` | `number` | No | 0–100; defaults to 70 |
| `fuzzyMatcher` | `FuzzyMatcher` | Yes | Must implement `.compare(a, b): number` and expose `.threshold` |

---

## Methods

### `search(query) → Promise<ScreeningHit[]>`

Searches the locally stored SDN list for name matches. Filters by `entityType` when provided. Applies DOB and nationality boosts. Returns results ordered by `matchScore` descending. Returns an empty array when no entries meet the threshold.

**Input** (`ScreeningQuery` from `types.js`)

```typescript
{
  name: string;              // required — name to screen
  entityType: 'individual' | 'entity';  // required
  dateOfBirth?: string;      // optional — ISO 8601 or 'YYYY-MM'; triggers DOB boost
  nationality?: string;      // optional — ISO 3166-1 alpha-2; triggers nationality boost
  aliases?: string[];        // optional — not currently used by OFACProvider
}
```

**Output** (`ScreeningHit[]` from `types.js`)

```typescript
Array<{
  source: 'OFAC-SDN';
  matchedName: string;       // the name/alias with the best fuzzy score
  matchScore: number;        // 0–100; includes DOB (+10) and nationality (+5) boosts
  matchedFields: string[];   // subset of ['name', 'dateOfBirth', 'nationality']
  listEntry: {
    id: string;              // OFAC UID
    names: string[];         // primary name + all aliases
    dateOfBirth?: string;
    nationality: string[];
    programs: string[];
    remarks?: string;
  };
  rawData: object;           // complete parsed XML entry for audit
}>
```

**Behaviour guarantees**
- Only entries with `matchScore >= matchThreshold` are returned.
- Results are sorted descending by `matchScore`.
- Returns `[]` when the list is empty or no matches meet the threshold.
- Does **not** download or modify list data; reads from the local database only.

---

### `getListMetadata() → Promise<ListMetadata & { isStale: boolean }>`

Returns metadata about the locally stored SDN list. Safe to call before the list has been synced (returns a zero-entry default).

**Output**

```typescript
{
  listName: 'OFAC-SDN';
  listType: 'sanctions';
  sourceUrl: string;
  lastUpdated: string | null;   // ISO 8601; null if never synced
  entryCount: number;           // 0 if never synced
  isStale: boolean;             // true if lastUpdated is null or > 24 hours ago
}
```

---

### `updateList() → Promise<UpdateResult>`

Downloads the SDN XML from `sourceUrl`, parses it, and upserts entries into the local database. Idempotent — running twice with the same source data produces zero net change on the second run. Removes entries absent from the current source list. Retries the download up to 3 times with exponential backoff on failure. Records every run outcome to `screening_sync_events`.

**Output** (`UpdateResult` from `types.js`)

```typescript
{
  updated: boolean;          // false when source unchanged (zero added/removed/modified)
  entriesAdded: number;
  entriesRemoved: number;
  entriesModified: number;
  timestamp: string;         // ISO 8601 completion time
}
```

**Error behaviour**: Throws if all 3 retry attempts fail. Caller (`syncScreeningLists`) catches and records the failure event.

---

## Sync Worker Contract

### `syncScreeningLists() → Promise<SyncSummary[]>`

Exported from `backend/src/workers/screening-sync.js`. Calls `updateList()` for all configured screening providers. Safe to call multiple times (idempotent per provider).

```typescript
type SyncSummary =
  | { provider: string; updated: boolean; entriesAdded: number; entriesRemoved: number; entriesModified: number; timestamp: string }
  | { provider: string; error: string };
```

---

## Interface Boundaries

| Consumer | How it calls | What it must NOT do |
|----------|-------------|---------------------|
| Screening Agent (#27) | `provider.search(query)` | Call `updateList()` during screening |
| Sync worker | `provider.updateList()` | Call `search()` |
| Any consumer | `provider.getListMetadata()` | Modify returned object |

---

## Dependency: `FuzzyMatcher`

`OFACProvider` depends on `FuzzyMatcher` (spec #19) via constructor injection. The required interface:

```typescript
interface FuzzyMatcher {
  threshold: number;                              // minimum score (read-only)
  compare(a: string, b: string): number;          // returns 0–100
}
```

`FuzzyMatcher` is currently a stub. Unit tests for `OFACProvider` mock this interface. Integration tests are blocked until spec #19 is implemented.
