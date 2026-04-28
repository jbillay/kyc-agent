# Data Model: Fuzzy Name Matching Engine

**Branch**: `016-fuzzy-matching-engine` | **Date**: 2026-04-28

## Overview

This module is a stateless utility. It has no persistent data model. The entities below describe the in-memory inputs and outputs of the matching engine.

---

## MatchResult

The object returned by `FuzzyMatcher.compare(query, candidate)`.

| Field | Type | Description | Constraints |
|-------|------|-------------|-------------|
| `score` | `number` | Composite similarity score | Integer, 0–100 inclusive |
| `isMatch` | `boolean` | Whether score meets the threshold | `score >= threshold` (inclusive boundary) |
| `matchedFields` | `string[]` | Literal token strings from query and candidate that drove the score | Flat array, alternating query/candidate token pairs; empty array when score is 0 |

**Example — phonetic match**:
```json
{
  "score": 88,
  "isMatch": true,
  "matchedFields": ["mohammed", "muhammad", "rahman", "rahman"]
}
```

**Example — no match**:
```json
{
  "score": 12,
  "isMatch": false,
  "matchedFields": []
}
```

**Example — exact match**:
```json
{
  "score": 100,
  "isMatch": true,
  "matchedFields": ["john", "john", "smith", "smith"]
}
```

---

## FuzzyMatcherOptions

Constructor parameter object for `new FuzzyMatcher(options)`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `threshold` | `number` | `85` | Minimum score (0–100) for `isMatch: true`. Inclusive. |
| `weights.jaroWinkler` | `number` | `0.40` | Jaro-Winkler algorithm weight |
| `weights.levenshtein` | `number` | `0.30` | Levenshtein algorithm weight |
| `weights.phonetic` | `number` | `0.15` | Soundex phonetic algorithm weight |
| `weights.tokenSort` | `number` | `0.15` | Token-sort algorithm weight |

**Constraint**: `weights.jaroWinkler + weights.levenshtein + weights.phonetic + weights.tokenSort` must equal `1.0` (enforced in constructor).

---

## Normalized Name

Intermediate internal value — not returned to callers, but documented for test predictability.

| Input | Normalized Output |
|-------|------------------|
| `"Dr. José García-López Jr."` | `"jose garcia lopez"` |
| `"Mohammed Al-Rahman"` | `"mohammed al rahman"` |
| `"JOHN SMITH"` | `"john smith"` |
| `"Müller"` | `"muller"` (ü → u via NFD + diacritic strip; note: does NOT become "mueller" — ü diacritic strip gives "u") |
| `"Mueller"` | `"mueller"` |
| `"al-Rahman"` | `"al rahman"` |
| `""` | `""` |
| `"Mr."` | `""` (title-only name normalizes to empty) |

**Note on Müller/Mueller**: NFD diacritic stripping yields "Muller" (u + combining umlaut stripped → u). "Mueller" normalizes to "mueller". These are therefore NOT identical after normalization — the Jaro-Winkler + Levenshtein scores will still produce a high composite (≥ 85) due to strong string similarity, satisfying SC-003 via algorithm scoring rather than normalization alone.

---

## Integration with ScreeningHit (types.js)

The `MatchResult.matchedFields` array maps directly to `ScreeningHit.matchedFields` (`string[]`). No schema change is required to `types.js` for the `ScreeningHit` typedef. A new `MatchResult` typedef will be added.

```javascript
/**
 * @typedef {Object} MatchResult
 * @property {number} score - Composite similarity score 0–100
 * @property {boolean} isMatch - True when score >= configured threshold (inclusive)
 * @property {string[]} matchedFields - Literal token pairs from query and candidate
 *   that contributed to the score, in [queryToken, candidateToken, ...] order
 */
```
