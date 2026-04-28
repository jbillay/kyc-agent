# Data Model: UK HMT Sanctions List

**Feature**: 015-uk-hmt-ingestion  
**Date**: 2026-04-27

## Overview

No schema changes required. `UKHMTProvider` uses three pre-existing tables. This document maps the HMT CSV column structure to database columns and documents the grouping and normalisation rules.

---

## Tables Used

### `screening_lists` — one row per provider

Managed by `_ensureList()` via `INSERT ON CONFLICT (list_name) DO UPDATE SET source_url`.

| Column | Value for UK HMT |
|--------|-----------------|
| `list_name` | `'UK-HMT'` |
| `list_type` | `'sanctions'` |
| `source_url` | Injected from `config.sourceUrl` (fallback: GOV.UK CSV URL) |
| `last_updated` | Updated to `NOW()` after each successful ingestion |
| `entry_count` | `entries.length` after each successful ingestion |
| `metadata` | `NULL` |

---

### `screening_entries` — one row per Group ID

Multiple CSV rows sharing the same Group ID are collapsed into a single entry.

| Column | CSV Source | Transformation |
|--------|-----------|---------------|
| `list_id` | — | FK → `screening_lists.id` via `_ensureList()` |
| `entry_id` | Column 2 (Group ID) | Stored as-is (string) |
| `entity_type` | Column 1 (Group Type) | `'Individual'` → `'individual'`; any other value → `'entity'` |
| `primary_name` | Columns 3–8 (Name1–Name6), row where column 9 = `'Primary Name'` | Non-empty parts joined with single space |
| `aliases` | Columns 3–8 of all non-primary rows for this Group ID | `TEXT[]`; may be empty |
| `date_of_birth` | Column 12 — first non-empty value across all group rows | Normalised (see table below) |
| `nationalities` | Column 15 — all group rows | `TEXT[]`; deduplicated set |
| `programs` | Column 25 — all group rows | `TEXT[]`; deduplicated set |
| `remarks` | — | Always `NULL` (HMT CSV has no remarks column) |
| `raw_data` | — | `JSONB`: `{ groupType: string, listedOn: string|null, allNames: [{name, type}] }` |

---

### `screening_sync_events` — one row per sync attempt (append-only)

Written by `_writeSyncEvent()`. PostgreSQL rules prevent UPDATE and DELETE.

| Column | Value |
|--------|-------|
| `list_name` | `'UK-HMT'` |
| `status` | `'success'` or `'failure'` |
| `entries_added` | Entries inserted in this run |
| `entries_removed` | Entries deleted (present in DB but absent from new CSV) |
| `entries_modified` | Entries updated (field change detected by `_entryChanged`) |
| `error_message` | `NULL` on success; error string on failure |
| `started_at` | Timestamp captured before download begins |
| `completed_at` | Timestamp captured after DB commit or on failure |

---

## CSV Column → Entry Field Mapping

```
Column Index  Header            Mapped To
──────────────────────────────────────────────────────────────────────
0             Last Updated      (ignored — not stored)
1             Group Type        entity_type
2             Group ID          entry_id (grouping key)
3             Name1             \
4             Name2              \
5             Name3               joined → primary_name or alias
6             Name4              /
7             Name5             /
8             Name6            /
9             Name Type         determines primary vs. alias
10            Alias Quality     (ignored)
11            Title             (ignored — already embedded in Name1-6)
12            DOB               date_of_birth (first non-empty per group)
13            Town of Birth     (ignored)
14            Country of Birth  (ignored)
15            Nationality       nationalities (all rows, deduped)
16–24         Passport, NI,     (ignored — preserved in raw_data via rawRows)
              Address1-6,
              Country
25            Regime            programs (all rows, deduped)
26            Listed On         raw_data.listedOn (first non-empty per group)
```

---

## DOB Normalisation Rules

| Input format | Stored value | Input example | Stored example |
|---|---|---|---|
| `DD/MM/YYYY` | `YYYY-MM-DD` | `01/03/1985` | `1985-03-01` |
| `MM/YYYY` | `YYYY-MM` | `03/1985` | `1985-03` |
| `YYYY` | `YYYY` | `1985` | `1985` |
| Anything else | Raw value unchanged | `circa 1970` | `circa 1970` |

---

## Name Assembly Rules

1. For each CSV row, collect columns 3–8 (Name1–Name6) and drop empty/whitespace-only values.
2. Join remaining parts with a single space to form a full name.
3. If the joined name is empty, skip this row (produce no name entry).
4. Column 9 (Name Type) determines role:
   - `'Primary Name'` → becomes `primary_name` for the group
   - Anything else → appended to `aliases`
5. If no row has `Name Type = 'Primary Name'`, the first non-empty name encountered becomes `primary_name`.

---

## Grouping Logic

```
Input: N CSV rows with the same Group ID

Output: 1 screening_entry where:
  primary_name = name from first 'Primary Name' row (or first name if none)
  aliases      = names from all other rows (deduped by Set not enforced — CSV source is assumed canonical)
  date_of_birth = first non-empty DOB value across all rows, normalised
  nationalities = Set of all non-empty values from column 15
  programs      = Set of all non-empty values from column 25
  listedOn      = first non-empty value from column 26
```

---

## Idempotency Constraint

The `(list_id, entry_id)` UNIQUE constraint on `screening_entries` ensures each Group ID appears at most once per list. On re-ingestion:
- Same entry → `_entryChanged()` returns false → no DB write → `modified` count unchanged
- Changed entry → UPDATE issued → `modified++`
- New entry → INSERT → `added++`
- Absent entry → DELETE → `removed++`
