# Contract: ScreeningProvider

**Layer**: 2 — Data Integration (`backend/src/data-sources/screening/`)  
**Consumers**: Layer 3 agents (screening agent)  
**Source file**: `backend/src/data-sources/screening/types.js`

---

## Interface Contract

A `ScreeningProvider` is any JavaScript object that satisfies all of the following:

```
name      : string                              (non-empty)
listType  : 'sanctions' | 'pep' | 'adverse_media'
search         (query)  → Promise<ScreeningHit[]>
getListMetadata ()      → Promise<ListMetadata>
updateList      ()      → Promise<UpdateResult>
```

All three methods are **async** (return Promises). Implementations MUST be **stateless**.

---

## Method Details

### `search(query: ScreeningQuery) → Promise<ScreeningHit[]>`

Returns an array of fuzzy-match hits against the list. Returns an **empty array** when no matches are found (not an error).

Each hit includes:
- `matchScore` — 0–100 numeric fuzzy score
- `matchedFields` — which input fields contributed to the match
- `listEntry` — the full list entry object
- `rawData` — complete unmodified list entry payload

### `getListMetadata() → Promise<ListMetadata>`

Returns current metadata about the list: name, type, source URL, last-updated timestamp, and entry count. Does not trigger a sync.

### `updateList() → Promise<UpdateResult>`

Fetches the latest version from the source and updates the local cache. Returns counts of entries added, removed, and modified. When the source is unchanged, returns `{ updated: false, entriesAdded: 0, entriesRemoved: 0, entriesModified: 0, timestamp: <ISO> }`.

---

## Error Contract

All three methods MUST throw typed errors on failure:

```javascript
throw Object.assign(
  new Error('Human-readable description'),
  { code: 'PROVIDER_UNAVAILABLE', provider: 'ofac-sdn' }
);
```

| `code` | Meaning |
|--------|---------|
| `PROVIDER_UNAVAILABLE` | Cannot reach the list source |
| `RATE_LIMITED` | Source is rate-limiting |
| `INVALID_RESPONSE` | Source returned unexpected / malformed data |

---

## rawData Requirement

Each `ScreeningHit` MUST include a `rawData` field containing the complete, unmodified list entry from the source. Required for audit reproducibility under Constitution Principle I.

---

## Implementing a New Provider

1. Create `backend/src/data-sources/screening/<provider-name>.js`
2. Export an object (or instance) with all 5 required members
3. Set `listType` to the appropriate category
4. Implement `search`, `getListMetadata`, `updateList`; throw typed errors on failure; include `rawData` in every `ScreeningHit`
5. Register in application startup as appropriate for the screening pipeline
