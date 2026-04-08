# Screening Agent — Run Sanctions Screening Against Local Lists

> GitHub Issue: [#32](https://github.com/jbillay/kyc-agent/issues/32)
> Epic: Screening Agent — Phase 1 (#30)
> Size: L (3-5 days) | Priority: Critical

## Context

With the screening list compiled (Story #31), this step runs each subject against OFAC SDN and UK HMT sanctions lists using the fuzzy matching engine. Subjects with no hits produce `sanctions_clear` fragments immediately. Subjects with potential hits pass their results to the LLM evaluation step (Story #33). Both individual and entity matching are handled, and aliases are screened alongside primary names.

## Requirements

### Functional

1. Step `run_sanctions_screening`: for each subject, query OFAC SDN and UK HMT providers
2. Fuzzy matching with configurable threshold (default 85%)
3. For each potential hit, collect: match score, matched name, matched fields, list entry details
4. Handle both individual and entity matching
5. Screen against both primary name and known aliases
6. `sanctions_clear` fragment for each subject with zero hits across all lists
7. Potential hits passed to evaluation step (not yet confirmed/dismissed)

### Non-Functional

- Full screening of 10-15 subjects completes in under 30 seconds
- All screening queries cached via data caching layer
- No external network calls (lists are locally cached in PostgreSQL)

## Technical Design

### File: `backend/src/agents/screening/index.js` (continued from Story #31)

```javascript
  // ─── Step 2: Run Sanctions Screening ──────────────

  /**
   * Screen each subject against OFAC SDN and UK HMT.
   *
   * For each subject:
   *   1. Build a ScreeningQuery from subject metadata
   *   2. Query each provider (OFAC, UK HMT)
   *   3. Aggregate hits across providers
   *   4. If no hits → produce sanctions_clear fragment immediately
   *   5. If hits → store for LLM evaluation in step 3
   */
  async _runSanctionsScreening(context) {
    const providers = [
      { provider: this.ofacProvider, name: 'OFAC-SDN' },
      { provider: this.ukhmtProvider, name: 'UK-HMT' },
    ];

    const clearFragments = [];
    let totalHits = 0;

    for (const subject of this._subjects) {
      const allHits = [];

      for (const { provider, name: providerName } of providers) {
        // Screen primary name
        const primaryHits = await provider.search({
          name: subject.name,
          dateOfBirth: subject.dateOfBirth,
          nationality: subject.nationality,
          entityType: subject.entityType,
        });
        allHits.push(...primaryHits);

        // Screen each alias
        for (const alias of subject.aliases) {
          const aliasHits = await provider.search({
            name: alias,
            dateOfBirth: subject.dateOfBirth,
            nationality: subject.nationality,
            entityType: subject.entityType,
          });

          // Add alias hits, avoiding duplicates (same list entry ID)
          for (const hit of aliasHits) {
            const isDuplicate = allHits.some(
              (h) => h.source === hit.source && h.listEntry.id === hit.listEntry.id
            );
            if (!isDuplicate) {
              allHits.push(hit);
            }
          }
        }
      }

      // Store hits for this subject
      const entry = this._screeningResults.get(subject.id);
      entry.hits = allHits;
      totalHits += allHits.length;

      // If no hits across all providers → sanctions_clear immediately
      if (allHits.length === 0) {
        clearFragments.push({
          type: FragmentType.SANCTIONS_CLEAR,
          decision: `No sanctions matches found for ${subject.entityType} "${subject.name}" (roles: ${subject.roles.join(', ')}) across OFAC SDN and UK HMT`,
          confidence: 95,
          evidence: {
            dataSources: ['ofac-sdn', 'uk-hmt'],
            dataPoints: [
              { source: 'ofac-sdn', field: 'search_result', value: 'no matches', fetchedAt: new Date().toISOString() },
              { source: 'uk-hmt', field: 'search_result', value: 'no matches', fetchedAt: new Date().toISOString() },
            ],
          },
          status: 'auto_approved',
        });
      }
    }

    const subjectsWithHits = this._subjects.filter(
      (s) => this._screeningResults.get(s.id).hits.length > 0
    );

    return {
      description: `Screened ${this._subjects.length} subjects — ${clearFragments.length} clear, ${subjectsWithHits.length} with potential hits (${totalHits} total hits)`,
      decisionFragments: clearFragments,
      llmCalls: [],
    };
  }
```

### Screening Query Construction

For each subject, the screening query is built from available metadata:

| Subject Field | ScreeningQuery Field | Purpose |
|--------------|---------------------|---------|
| `name` | `name` | Primary fuzzy match target |
| `dateOfBirth` | `dateOfBirth` | Score boost on DOB match |
| `nationality` | `nationality` | Score boost on nationality match |
| `entityType` | `entityType` | Filter list entries by individual/entity |

Aliases are screened as separate queries with the same metadata. Hit deduplication prevents the same list entry from appearing twice (e.g., primary name and alias both match the same SDN entry).

### Screening Flow Per Subject

```
Subject: "John Smith" (individual, director + shareholder)
  │
  ├── Query OFAC SDN with "John Smith" (individual)
  │     └── 2 hits (scores: 92, 87)
  │
  ├── Query UK HMT with "John Smith" (individual)
  │     └── 1 hit (score: 88)
  │
  ├── Query OFAC SDN with alias "J. Smith"
  │     └── 1 hit (score: 86) — same entry as 87 above → deduplicated
  │
  └── Result: 3 unique hits → passed to LLM evaluation
```

```
Subject: "Jane Doe" (individual, director)
  │
  ├── Query OFAC SDN → 0 hits
  ├── Query UK HMT → 0 hits
  │
  └── Result: 0 hits → sanctions_clear fragment produced immediately
```

### Performance

All screening happens against locally cached PostgreSQL data (no network calls to external APIs). The fuzzy matcher runs in-process. For a typical case:

| Metric | Expected |
|--------|----------|
| Subjects per case | 10-15 |
| Lists per subject | 2 (OFAC + UK HMT) |
| Queries per subject | 2-4 (primary name + aliases × 2 lists) |
| Time per query | ~50-200ms (fuzzy match against full list) |
| Total screening time | 5-15 seconds |

## Acceptance Criteria

- [ ] Step `run_sanctions_screening` queries both OFAC SDN and UK HMT for each subject
- [ ] Fuzzy matching threshold configurable (default 85%)
- [ ] Each potential hit includes: source, matchScore, matchedName, matchedFields, listEntry
- [ ] Both individual and entity subjects handled
- [ ] Aliases screened alongside primary name
- [ ] Duplicate hits (same list entry from name + alias) deduplicated
- [ ] Subjects with zero hits → `sanctions_clear` fragment with `auto_approved` status
- [ ] `sanctions_clear` evidence lists all providers checked
- [ ] Subjects with hits → results stored for LLM evaluation step
- [ ] Full screening of 15 subjects completes in under 30 seconds
- [ ] Step description includes counts: total screened, clear, with hits

## Dependencies

- **Depends on**: #31 (Compiled screening list), #17 (OFAC SDN provider), #18 (UK HMT provider), #19 (Fuzzy matcher)
- **Blocks**: #33 (Hit evaluation — needs the potential hits)

## Testing Strategy

1. **All clear**: 3 subjects, no matches in either list → verify 3 `sanctions_clear` fragments
2. **One hit**: 3 subjects, 1 has a match → verify 2 clear fragments + 1 subject with stored hit
3. **Multiple hits same subject**: Subject matches 2 OFAC entries + 1 HMT entry → verify 3 hits stored
4. **Alias screening**: Subject with alias, alias matches but primary doesn't → verify hit found via alias
5. **Hit deduplication**: Primary name and alias match same list entry → verify only 1 hit stored
6. **Individual matching**: Individual subject → verify `entityType: 'individual'` in query
7. **Entity matching**: Corporate subject → verify `entityType: 'entity'` in query
8. **DOB in query**: Subject with DOB → verify DOB passed to provider search
9. **Nationality in query**: Subject with nationality → verify nationality passed to provider search
10. **Performance**: Screen 15 subjects, assert < 30 seconds
11. **Provider failure**: One provider throws error → verify graceful handling (other provider still queried)
