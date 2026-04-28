# Contract: FuzzyMatcher

**Module**: `backend/src/data-sources/screening/fuzzy-matcher.js`  
**Layer**: 2 — Data Integration  
**Exported**: `{ FuzzyMatcher }`

---

## Constructor

```javascript
new FuzzyMatcher(options?)
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `options` | `Object` | No | Configuration object |
| `options.threshold` | `number` | No | Match threshold 0–100, inclusive. Default: `85` |
| `options.weights` | `Object` | No | Algorithm weight overrides (must sum to 1.0) |
| `options.weights.jaroWinkler` | `number` | No | Default: `0.40` |
| `options.weights.levenshtein` | `number` | No | Default: `0.30` |
| `options.weights.phonetic` | `number` | No | Default: `0.15` |
| `options.weights.tokenSort` | `number` | No | Default: `0.15` |

---

## Methods

### `compare(query, candidate)`

Compare two name strings and return a structured match result.

**Signature**:
```javascript
compare(query: string, candidate: string): MatchResult
```

**Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `query` | `string` | Name being screened (from KYC case) |
| `candidate` | `string` | Name from a sanctions list entry |

**Returns**: `MatchResult`

| Field | Type | Description |
|-------|------|-------------|
| `score` | `number` | Composite similarity 0–100 |
| `isMatch` | `boolean` | `score >= threshold` (inclusive) |
| `matchedFields` | `string[]` | Literal token pairs `[queryTok, candidateTok, ...]` that drove the score; empty when score is 0 |

**Guarantees**:
- Always returns a valid `MatchResult` — never throws for any string input
- Empty or null input → `{ score: 0, isMatch: false, matchedFields: [] }`
- Identical inputs → `{ score: 100, isMatch: true, matchedFields: [...all tokens...] }`
- Deterministic: same inputs always produce same output
- Synchronous: no I/O, no Promises

---

### `normalize(name)`

Normalize a name string through the standard preprocessing pipeline.

**Signature**:
```javascript
normalize(name: string): string
```

**Pipeline** (applied in order):
1. Lowercase
2. NFD Unicode decomposition + strip combining diacritics (U+0300–U+036F)
3. Explicit transliterations: `ø→o`, `æ→ae`, `ß→ss`, `ð→d`, `þ→th`
4. Remove titles: `mr`, `mrs`, `ms`, `miss`, `dr`, `prof`, `sir`, `dame`, `lord`, `lady`, `rev`, `hon` (with optional trailing `.`)
5. Remove suffixes: `jr`, `sr`, `ii`, `iii`, `iv`, `esq`, `phd`, `md` (with optional trailing `.`)
6. Strip punctuation except spaces
7. Replace hyphens with spaces
8. Collapse multiple spaces; trim

**Returns**: Normalized string. Returns `""` for null, undefined, or input that normalizes to empty.

**Note**: This method is public to allow callers (e.g., ingestion services) to pre-normalize stored list entries for performance.

---

## Usage Patterns

### Single-pair comparison

```javascript
const { FuzzyMatcher } = require('./fuzzy-matcher');

const matcher = new FuzzyMatcher({ threshold: 85 });
const result = matcher.compare('Mohammed Al-Rahman', 'Muhammad Rahman');
// { score: 88, isMatch: true, matchedFields: ['mohammed', 'muhammad', 'al rahman', 'rahman'] }
```

### Full-list screening

```javascript
const matcher = new FuzzyMatcher({ threshold: 85 });
const hits = candidates
  .map(candidate => ({ candidate, ...matcher.compare(queryName, candidate.name) }))
  .filter(result => result.isMatch);
```

### Pre-normalization at ingestion time (performance optimization)

```javascript
const matcher = new FuzzyMatcher();
// During list ingestion, normalize and store:
const normalizedName = matcher.normalize(rawEntry.name);
// During screening, compare against pre-normalized:
const result = matcher.compare(queryName, normalizedName);
```

---

## Boundaries / Non-Responsibilities

- Does **not** fetch, store, or update sanctions lists
- Does **not** write to `decision_events` or any database
- Does **not** combine multiple list results — each list screened independently by its provider
- Does **not** handle non-Latin scripts without prior transliteration
- Does **not** validate that algorithm weights sum to 1.0 at runtime (constructor validates; caller must not mutate `this.weights` post-construction)
