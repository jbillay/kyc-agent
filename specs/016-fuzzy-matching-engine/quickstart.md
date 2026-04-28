# Quickstart: Fuzzy Name Matching Engine

**Branch**: `016-fuzzy-matching-engine`

## What this is

`FuzzyMatcher` is a stateless, pure-JS utility for comparing two name strings. It combines Jaro-Winkler, Levenshtein edit distance, Soundex phonetic encoding, and token-sort to produce a composite 0–100 score. Used by the OFAC and UK HMT screening providers to find probable name matches across transliterations, typos, and formatting variations.

## Running the tests

```bash
cd backend && npx jest tests/backend/data-sources/screening/fuzzy-matcher.test.js
```

Or run the full test suite:

```bash
cd backend && npm test
```

## Basic usage

```javascript
const { FuzzyMatcher } = require('./backend/src/data-sources/screening/fuzzy-matcher');

const matcher = new FuzzyMatcher(); // default threshold: 85

// Single comparison
const result = matcher.compare('John Smith', 'Smith, John');
// { score: 95, isMatch: true, matchedFields: ['john', 'john', 'smith', 'smith'] }

// Token reordering handled automatically
const result2 = matcher.compare('Mohammed Al-Rahman', 'Muhammad Rahman');
// { score: 88, isMatch: true, matchedFields: ['mohammed', 'muhammad', 'rahman', 'rahman'] }

// Below threshold — needs human review, not auto-clear
const result3 = matcher.compare('J. Smith', 'John Smith');
// { score: 62, isMatch: false, matchedFields: ['smith', 'smith'] }
```

## Custom threshold

```javascript
const strictMatcher = new FuzzyMatcher({ threshold: 92 });
const looseMatcher  = new FuzzyMatcher({ threshold: 70 });
```

## Screening a full list

```javascript
const matcher = new FuzzyMatcher({ threshold: 85 });

function screenAgainstList(queryName, entries) {
  return entries
    .map(entry => ({
      entry,
      result: matcher.compare(queryName, entry.name),
    }))
    .filter(({ result }) => result.isMatch)
    .map(({ entry, result }) => ({
      matchedName: entry.name,
      matchScore: result.score,
      matchedFields: result.matchedFields,
    }));
}
```

## Pre-normalizing list entries (performance optimization)

The OFAC and HMT ingestors call `normalize()` during ingestion and store the result. At screening time only the query name needs normalization:

```javascript
// During ingestion (ofac.js / uk-hmt.js):
const matcher = new FuzzyMatcher();
entry.normalizedName = matcher.normalize(entry.rawName);

// During screening — skip double normalization:
const result = matcher.compare(queryName, entry.normalizedName);
```

## Score interpretation

| Score range | Meaning | Action |
|-------------|---------|--------|
| 100 | Exact match (post-normalization) | Auto-flag for review |
| 85–99 | High-confidence probable match | Auto-flag for review |
| 50–84 | Partial match (e.g., abbreviated token) | Flag for human review |
| 30–49 | Weak similarity | Typically discarded at threshold 85 |
| 0–29 | No meaningful match | Discard |

## File locations

| File | Purpose |
|------|---------|
| `backend/src/data-sources/screening/fuzzy-matcher.js` | Implementation |
| `backend/src/data-sources/screening/types.js` | `MatchResult` typedef (added) |
| `tests/backend/data-sources/screening/fuzzy-matcher.test.js` | Test suite |
