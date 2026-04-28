# Contract: ScreeningProvider Interface — UKHMTProvider

**Feature**: 015-uk-hmt-ingestion  
**Date**: 2026-04-27  
**Source of truth**: `backend/src/data-sources/screening/types.js`

---

## Interface: `ScreeningProvider`

`UKHMTProvider` must satisfy the `ScreeningProvider` typedef. All three public methods are required.

```
ScreeningProvider
├── name: string                           — 'uk-hmt'
├── listType: 'sanctions'|'pep'|'adverse_media'  — 'sanctions'
├── search(query) → Promise<ScreeningHit[]>
├── getListMetadata() → Promise<ListMetadata>
└── updateList() → Promise<UpdateResult>
```

---

## Constructor

```
UKHMTProvider(config, fuzzyMatcher)

config:
  sourceUrl?:       string   — GOV.UK CSV URL (defaults to hardcoded fallback)
  matchThreshold?:  number   — minimum score 0–100 (default 70)

fuzzyMatcher:
  FuzzyMatcher instance from backend/src/data-sources/screening/fuzzy-matcher.js
  Required methods: compare(a: string, b: string) → number (0–100)
  Required property: threshold: number
```

---

## Method: `search(query)`

**Input — `ScreeningQuery`**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Subject's full name to match against |
| `entityType` | `'individual'\|'entity'` | No | Filter — only evaluate entries of this type |
| `dateOfBirth` | `string` | No | Used for score boost if it matches entry DOB |
| `nationality` | `string` | No | Used for score boost if it matches entry nationality |

**Output — `ScreeningHit[]`** (sorted descending by `matchScore`):

| Field | Type | Description |
|-------|------|-------------|
| `source` | `'UK-HMT'` | Constant |
| `matchedName` | `string` | The specific name (primary or alias) that scored highest |
| `matchScore` | `number` | Composite score 0–100 (name score + optional DOB +10 / nationality +5 boosts, capped at 100) |
| `matchedFields` | `string[]` | Subset of `['name', 'dateOfBirth', 'nationality']` |
| `listEntry.id` | `string` | Group ID |
| `listEntry.names` | `string[]` | All names (primary + aliases) |
| `listEntry.dateOfBirth` | `string\|undefined` | Stored DOB or undefined |
| `listEntry.nationality` | `string[]` | Stored nationalities |
| `listEntry.programs` | `string[]` | Sanctions programs |
| `listEntry.remarks` | `string\|undefined` | Always undefined for HMT |
| `listEntry.listedDate` | `string\|undefined` | From `raw_data.listedOn` |
| `rawData` | `object` | Full `raw_data` JSONB from DB |

**Threshold behaviour**: Only entries where the best name score ≥ `matchThreshold` (default 70) are returned.

---

## Method: `getListMetadata()`

**Output — `ListMetadata`**:

| Field | Type | Description |
|-------|------|-------------|
| `listName` | `'UK-HMT'` | Constant |
| `listType` | `'sanctions'` | Constant |
| `sourceUrl` | `string` | Configured or fallback GOV.UK URL |
| `lastUpdated` | `string\|null` | ISO 8601 timestamp of last successful sync, or null |
| `entryCount` | `number` | Current count; 0 if never synced |
| `isStale` | `boolean` | `true` if `lastUpdated` is null or >24 hours ago |

---

## Method: `updateList()`

**Output — `UpdateResult`**:

| Field | Type | Description |
|-------|------|-------------|
| `updated` | `boolean` | `true` if any entries were added, removed, or modified |
| `entriesAdded` | `number` | New entries inserted |
| `entriesRemoved` | `number` | Entries deleted (delisted) |
| `entriesModified` | `number` | Entries updated (field change detected) |
| `timestamp` | `string` | ISO 8601 timestamp of completion |

**Side effects**:
1. Downloads CSV (with up to 3 retries, exponential backoff).
2. Parses and groups rows by Group ID.
3. Upserts entries within a single DB transaction (all-or-nothing).
4. Updates `screening_lists.last_updated` and `entry_count`.
5. Writes one row to `screening_sync_events` (append-only audit).

**On failure** (all retries exhausted): throws an error; existing DB entries remain unchanged; writes a `'failure'` row to `screening_sync_events`.

---

## Caller Contract (Sync Worker)

The sync worker (`backend/src/workers/screening-sync.js`) expects:
- `provider.name` — used in log messages
- `provider.getListMetadata()` — called before `updateList()` for stale warning
- `provider.updateList()` — called to trigger sync
- Both methods must not throw for a `'stale'` list; errors are caught and recorded by the worker

The sync worker calls providers in sequence; `UKHMTProvider` will be added to the `providers` array once implemented (uncomment the existing stub at line 28).
