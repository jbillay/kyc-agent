# Data Model: OFAC SDN Ingestion and Search

**Branch**: `014-ofac-sdn-ingestion`  
**Date**: 2026-04-27  
**Spec**: [spec.md](spec.md)

## Existing Tables (no schema changes)

### `screening_lists`

Tracks metadata for each sanctions/PEP list. One row per list name.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID PK` | `gen_random_uuid()` |
| `list_name` | `VARCHAR(100) UNIQUE NOT NULL` | e.g. `'OFAC-SDN'` |
| `list_type` | `VARCHAR(20)` | `'sanctions'` \| `'pep'` \| `'adverse_media'` |
| `source_url` | `VARCHAR(500)` | Treasury endpoint URL |
| `last_updated` | `TIMESTAMPTZ` | Set after each successful sync |
| `entry_count` | `INTEGER` | Updated after each sync |
| `metadata` | `JSONB` | Reserved for future use |

**Uniqueness key**: `list_name`  
**Stale detection**: `NOW() - last_updated > INTERVAL '24 hours'`

---

### `screening_entries`

Individual SDN list entries. One row per `(list_id, entry_id)`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID PK` | `gen_random_uuid()` |
| `list_id` | `UUID NOT NULL` | FK → `screening_lists.id` |
| `entry_id` | `VARCHAR(200) NOT NULL` | Source UID from `<uid>` element |
| `entity_type` | `VARCHAR(20) NOT NULL` | `'individual'` \| `'entity'` |
| `primary_name` | `VARCHAR(500) NOT NULL` | `firstName + ' ' + lastName` combined |
| `aliases` | `TEXT[]` | From `<akaList>` |
| `date_of_birth` | `VARCHAR(20)` | First DOB entry; `NULL` if absent |
| `nationalities` | `TEXT[]` | From `<nationalityList>` |
| `programs` | `TEXT[]` | From `<programList>` (e.g. `'SDGT'`, `'IRAN'`) |
| `remarks` | `TEXT` | Free-text from `<remarks>` |
| `raw_data` | `JSONB NOT NULL` | Complete parsed XML entry for audit |

**Uniqueness key**: `(list_id, entry_id)`  
**Indexes**: `primary_name` B-tree; `primary_name` GIN trigram (`gin_trgm_ops`)

---

## New Table: `screening_sync_events`

Append-only audit log for every sync run outcome. Cannot use `decision_events` because sync runs are not associated with a KYC case (`case_id` is `NOT NULL` on `decision_events`).

```sql
CREATE TABLE IF NOT EXISTS screening_sync_events (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  list_name        VARCHAR(100) NOT NULL,
  status           VARCHAR(30)  NOT NULL
                     CHECK (status IN ('success','failure','stale_detected')),
  entries_added    INTEGER      NOT NULL DEFAULT 0,
  entries_removed  INTEGER      NOT NULL DEFAULT 0,
  entries_modified INTEGER      NOT NULL DEFAULT 0,
  error_message    TEXT,
  attempt_number   INTEGER      NOT NULL DEFAULT 1,
  started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  sequence_number  BIGSERIAL    NOT NULL
);

-- Append-only enforcement (mirrors decision_events pattern)
CREATE OR REPLACE RULE no_update_sync_events AS
  ON UPDATE TO screening_sync_events DO INSTEAD NOTHING;

CREATE OR REPLACE RULE no_delete_sync_events AS
  ON DELETE TO screening_sync_events DO INSTEAD NOTHING;

CREATE INDEX IF NOT EXISTS idx_sync_events_list_name
  ON screening_sync_events (list_name, started_at DESC);
```

| Column | Type | Notes |
|--------|------|-------|
| `id` | `UUID PK` | `gen_random_uuid()` |
| `list_name` | `VARCHAR(100) NOT NULL` | `'OFAC-SDN'` |
| `status` | `VARCHAR(30) NOT NULL` | `'success'` \| `'failure'` \| `'stale_detected'` |
| `entries_added` | `INTEGER NOT NULL DEFAULT 0` | Count of new entries |
| `entries_removed` | `INTEGER NOT NULL DEFAULT 0` | Count of removed entries |
| `entries_modified` | `INTEGER NOT NULL DEFAULT 0` | Count of changed entries |
| `error_message` | `TEXT` | Null on success; populated on failure or stale detection |
| `attempt_number` | `INTEGER NOT NULL DEFAULT 1` | Which retry attempt produced this outcome (1–4) |
| `started_at` | `TIMESTAMPTZ NOT NULL DEFAULT NOW()` | When this attempt started |
| `completed_at` | `TIMESTAMPTZ` | Null until attempt concludes |
| `sequence_number` | `BIGSERIAL NOT NULL` | Total ordering across all sync events |

**Append-only enforcement**: PostgreSQL rules block UPDATE and DELETE (identical to `decision_events` pattern).

---

## Configuration Change: `config/screening-sources.yaml`

Add `match_threshold` to each source block. The field is optional with a default of `70` applied in code.

```yaml
screening_sources:
  ofac_sdn:
    type: "sanctions"
    source_url: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML"
    format: "xml"
    sync_schedule: "0 2 * * *"
    match_threshold: 70        # ← new: minimum fuzzy match score (0–100)

  uk_hmt:
    type: "sanctions"
    source_url: "https://assets.publishing.service.gov.uk/media/ConList.csv"
    format: "csv"
    sync_schedule: "0 3 * * *"
    match_threshold: 70        # ← new
```

---

## Runtime Objects (not persisted)

### `ScreeningQuery`

Input to `OFACProvider.search()`. Defined in `types.js`.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | `string` | Yes | Name to screen |
| `entityType` | `'individual' \| 'entity'` | Yes | Filters by `entity_type` column |
| `dateOfBirth` | `string` | No | ISO 8601 or `'YYYY-MM'`; triggers DOB boost |
| `nationality` | `string` | No | ISO 3166-1 alpha-2; triggers nationality boost |
| `aliases` | `string[]` | No | Currently unused by `OFACProvider.search()` |

### `ScreeningHit`

Output element from `OFACProvider.search()`. Defined in `types.js`.

| Field | Type | Notes |
|-------|------|-------|
| `source` | `string` | Always `'OFAC-SDN'` |
| `matchedName` | `string` | The alias or primary name that produced the best score |
| `matchScore` | `number` | 0–100; boosted by DOB (+10) and nationality (+5) matches |
| `matchedFields` | `string[]` | Subset of `['name', 'dateOfBirth', 'nationality']` |
| `listEntry.id` | `string` | SDN UID |
| `listEntry.names` | `string[]` | Primary name + all aliases |
| `listEntry.dateOfBirth` | `string` | Undefined if absent |
| `listEntry.nationality` | `string[]` | Empty array if absent |
| `listEntry.programs` | `string[]` | Sanctions programs |
| `listEntry.remarks` | `string` | Undefined if absent |
| `rawData` | `Object` | Complete parsed XML entry |

### `ListMetadata` (extended)

Return type of `OFACProvider.getListMetadata()`. Extends base type from `types.js`.

| Field | Type | Notes |
|-------|------|-------|
| `listName` | `string` | `'OFAC-SDN'` |
| `listType` | `string` | `'sanctions'` |
| `sourceUrl` | `string` | Treasury endpoint |
| `lastUpdated` | `string \| null` | ISO 8601; null if never synced |
| `entryCount` | `number` | 0 if never synced |
| `isStale` | `boolean` | `true` if `lastUpdated` is null or more than 24 hours ago |

### `UpdateResult`

Return type of `OFACProvider.updateList()`. Defined in `types.js`.

| Field | Type | Notes |
|-------|------|-------|
| `updated` | `boolean` | `false` when source unchanged (zero net change) |
| `entriesAdded` | `number` | — |
| `entriesRemoved` | `number` | — |
| `entriesModified` | `number` | — |
| `timestamp` | `string` | ISO 8601 timestamp of the update check |
