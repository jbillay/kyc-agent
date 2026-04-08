# Fuzzy Name Matching Engine for Screening

> GitHub Issue: [#19](https://github.com/jbillay/kyc-agent/issues/19)
> Epic: Data Integration Layer (#13)
> Size: M (1-3 days) | Priority: Critical

## Context

Sanctions screening must catch name variations — transliterations, misspellings, abbreviations, and reorderings. A single string-matching algorithm misses edge cases, so the fuzzy matcher combines multiple algorithms (Levenshtein, Jaro-Winkler, Soundex/Metaphone) with weighted scoring. Both the OFAC (#17) and UK HMT (#18) providers depend on this shared engine.

## Requirements

### Functional

1. Multi-algorithm matching: Levenshtein distance, Jaro-Winkler, phonetic (Soundex/Metaphone)
2. Combined match score (0–100) from weighted algorithm results
3. Configurable match threshold (default 85%)
4. Name normalization: transliteration, diacritics removal, common abbreviations, title removal
5. Multi-token matching: "John Smith" matches "Smith, John" and "J. Smith"
6. Returns matched fields (which parts of the name matched)

### Non-Functional

- Screen a name against the full OFAC list (12,000+ entries) in under 500ms
- Deterministic: same inputs always produce the same score
- No external API dependencies — all matching is local

## Technical Design

### File: `backend/src/data-sources/screening/fuzzy-matcher.js`

```javascript
/**
 * Multi-algorithm fuzzy name matching engine.
 *
 * Combines string distance, phonetic, and token-based matching
 * to produce a 0–100 composite score.
 *
 * Algorithm weights (default):
 *   Jaro-Winkler:  0.40  — good for short strings, rewards common prefixes
 *   Levenshtein:   0.30  — edit distance, catches insertions/deletions
 *   Phonetic:      0.15  — Soundex/Double Metaphone, catches pronunciation matches
 *   Token sort:    0.15  — handles name reordering
 */
class FuzzyMatcher {
  /**
   * @param {Object} [options]
   * @param {number} [options.threshold=85] - Minimum score to consider a match (0-100)
   * @param {Object} [options.weights] - Algorithm weights (must sum to 1.0)
   */
  constructor(options = {}) {
    this.threshold = options.threshold || 85;
    this.weights = {
      jaroWinkler: 0.40,
      levenshtein: 0.30,
      phonetic: 0.15,
      tokenSort: 0.15,
      ...options.weights,
    };
  }

  /**
   * Compare two names and return a composite score (0–100).
   *
   * @param {string} query - Name being searched
   * @param {string} candidate - Name from the screening list
   * @returns {number} Score 0–100
   */
  compare(query, candidate) {
    const normQuery = this.normalize(query);
    const normCandidate = this.normalize(candidate);

    if (!normQuery || !normCandidate) return 0;
    if (normQuery === normCandidate) return 100;

    const jw = this.jaroWinkler(normQuery, normCandidate);
    const lev = this.levenshteinScore(normQuery, normCandidate);
    const phon = this.phoneticScore(normQuery, normCandidate);
    const token = this.tokenSortScore(normQuery, normCandidate);

    const score = Math.round(
      jw * this.weights.jaroWinkler * 100 +
      lev * this.weights.levenshtein * 100 +
      phon * this.weights.phonetic * 100 +
      token * this.weights.tokenSort * 100
    );

    return Math.min(100, Math.max(0, score));
  }

  /**
   * Normalize a name for comparison.
   *
   * Steps:
   * 1. Lowercase
   * 2. Remove diacritics (NFD decompose + strip combining marks)
   * 3. Remove titles (Mr, Mrs, Dr, Prof, Sir, etc.)
   * 4. Remove common suffixes (Jr, Sr, III, etc.)
   * 5. Remove punctuation except spaces
   * 6. Collapse multiple spaces
   * 7. Trim
   *
   * @param {string} name
   * @returns {string}
   */
  normalize(name) {
    if (!name) return '';

    let n = name.toLowerCase();

    // Remove diacritics
    n = n.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Common transliterations
    n = n.replace(/ø/g, 'o')
      .replace(/æ/g, 'ae')
      .replace(/ß/g, 'ss')
      .replace(/ð/g, 'd')
      .replace(/þ/g, 'th');

    // Remove titles
    n = n.replace(/\b(mr|mrs|ms|miss|dr|prof|sir|dame|lord|lady|rev|hon)\b\.?/g, '');

    // Remove suffixes
    n = n.replace(/\b(jr|sr|ii|iii|iv|esq|phd|md)\b\.?/g, '');

    // Remove punctuation except spaces and hyphens
    n = n.replace(/[^a-z0-9\s-]/g, '');

    // Replace hyphens with spaces (for "al-" prefix matching)
    n = n.replace(/-/g, ' ');

    // Collapse spaces
    n = n.replace(/\s+/g, ' ').trim();

    return n;
  }

  /**
   * Jaro-Winkler similarity (0–1).
   *
   * Good for short strings; rewards matching characters near the start.
   *
   * @param {string} s1
   * @param {string} s2
   * @returns {number} 0–1
   */
  jaroWinkler(s1, s2) {
    if (s1 === s2) return 1.0;
    if (!s1.length || !s2.length) return 0.0;

    const matchWindow = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);

    const s1Matches = new Array(s1.length).fill(false);
    const s2Matches = new Array(s2.length).fill(false);

    let matches = 0;
    let transpositions = 0;

    // Find matching characters
    for (let i = 0; i < s1.length; i++) {
      const start = Math.max(0, i - matchWindow);
      const end = Math.min(i + matchWindow + 1, s2.length);

      for (let j = start; j < end; j++) {
        if (s2Matches[j] || s1[i] !== s2[j]) continue;
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }

    if (matches === 0) return 0.0;

    // Count transpositions
    let k = 0;
    for (let i = 0; i < s1.length; i++) {
      if (!s1Matches[i]) continue;
      while (!s2Matches[k]) k++;
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }

    const jaro = (
      matches / s1.length +
      matches / s2.length +
      (matches - transpositions / 2) / matches
    ) / 3;

    // Winkler bonus for common prefix (up to 4 chars)
    let prefix = 0;
    for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
      if (s1[i] === s2[i]) prefix++;
      else break;
    }

    return jaro + prefix * 0.1 * (1 - jaro);
  }

  /**
   * Levenshtein similarity score (0–1).
   *
   * Converts edit distance to a 0–1 similarity.
   *
   * @param {string} s1
   * @param {string} s2
   * @returns {number} 0–1
   */
  levenshteinScore(s1, s2) {
    const distance = this._levenshteinDistance(s1, s2);
    const maxLen = Math.max(s1.length, s2.length);
    if (maxLen === 0) return 1.0;
    return 1.0 - distance / maxLen;
  }

  /**
   * Levenshtein edit distance.
   * @param {string} s1
   * @param {string} s2
   * @returns {number}
   */
  _levenshteinDistance(s1, s2) {
    const m = s1.length;
    const n = s2.length;

    // Use single-row optimization for memory efficiency
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);

    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,      // deletion
          curr[j - 1] + 1,  // insertion
          prev[j - 1] + cost // substitution
        );
      }
      [prev, curr] = [curr, prev];
    }

    return prev[n];
  }

  /**
   * Phonetic similarity score (0–1).
   *
   * Compares Soundex codes of each token. Returns fraction of matching tokens.
   *
   * @param {string} s1
   * @param {string} s2
   * @returns {number} 0–1
   */
  phoneticScore(s1, s2) {
    const tokens1 = s1.split(/\s+/).filter(Boolean);
    const tokens2 = s2.split(/\s+/).filter(Boolean);

    if (tokens1.length === 0 || tokens2.length === 0) return 0;

    const codes1 = tokens1.map((t) => this._soundex(t));
    const codes2 = tokens2.map((t) => this._soundex(t));

    let matches = 0;
    const used = new Set();

    for (const code1 of codes1) {
      for (let j = 0; j < codes2.length; j++) {
        if (!used.has(j) && code1 === codes2[j]) {
          matches++;
          used.add(j);
          break;
        }
      }
    }

    return matches / Math.max(tokens1.length, tokens2.length);
  }

  /**
   * Soundex phonetic code.
   * @param {string} word
   * @returns {string} 4-character Soundex code
   */
  _soundex(word) {
    if (!word) return '0000';

    const upper = word.toUpperCase();
    const map = {
      B: '1', F: '1', P: '1', V: '1',
      C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
      D: '3', T: '3',
      L: '4',
      M: '5', N: '5',
      R: '6',
    };

    let code = upper[0];
    let lastDigit = map[upper[0]] || '';

    for (let i = 1; i < upper.length && code.length < 4; i++) {
      const digit = map[upper[i]];
      if (digit && digit !== lastDigit) {
        code += digit;
        lastDigit = digit;
      } else if (!digit) {
        lastDigit = '';
      }
    }

    return (code + '0000').slice(0, 4);
  }

  /**
   * Token-sort similarity (0–1).
   *
   * Sorts tokens alphabetically before comparing, catching reordered names.
   * "John Smith" vs "Smith John" → both become "john smith" → perfect match.
   *
   * @param {string} s1
   * @param {string} s2
   * @returns {number} 0–1
   */
  tokenSortScore(s1, s2) {
    const sorted1 = s1.split(/\s+/).sort().join(' ');
    const sorted2 = s2.split(/\s+/).sort().join(' ');
    return this.jaroWinkler(sorted1, sorted2);
  }
}

module.exports = { FuzzyMatcher };
```

### Algorithm Weights

| Algorithm | Weight | Strength |
|-----------|--------|----------|
| Jaro-Winkler | 0.40 | Short strings, common prefix matches |
| Levenshtein | 0.30 | Edit distance, typos, insertions/deletions |
| Phonetic (Soundex) | 0.15 | Pronunciation-based matches, transliterations |
| Token sort | 0.15 | Name reordering ("Smith, John" ↔ "John Smith") |

### Name Normalization Pipeline

```
Input: "Dr. José María García-López Jr."
  ↓ lowercase
"dr. josé maría garcía-lópez jr."
  ↓ NFD decompose + strip combining marks
"dr. jose maria garcia-lopez jr."
  ↓ remove titles (dr)
"jose maria garcia-lopez jr."
  ↓ remove suffixes (jr)
"jose maria garcia-lopez"
  ↓ replace hyphens with spaces
"jose maria garcia lopez"
  ↓ strip punctuation, collapse spaces
"jose maria garcia lopez"
```

### Score Examples

| Query | Candidate | Score | Why |
|-------|-----------|-------|-----|
| "John Smith" | "John Smith" | 100 | Exact match |
| "John Smith" | "Smith, John" | ~95 | Token sort catches reordering |
| "John Smith" | "Jon Smith" | ~90 | Jaro-Winkler + Levenshtein high |
| "John Smith" | "J. Smith" | ~75 | Abbreviation, partial token match |
| "Mohammed" | "Muhammad" | ~88 | Soundex match + high Jaro-Winkler |
| "John Smith" | "Jane Doe" | ~15 | Low across all algorithms |

### Performance Strategy

- Names are normalized once during list ingestion (stored normalized in DB)
- Query names normalized once per search
- Soundex codes can be pre-computed and indexed for fast phonetic lookups
- Single-row Levenshtein optimization reduces memory from O(n²) to O(n)

## Acceptance Criteria

- [ ] Multi-algorithm matching: Levenshtein, Jaro-Winkler, Soundex, token-sort
- [ ] Combined score 0–100 from weighted results
- [ ] Configurable threshold (default 85%)
- [ ] Name normalization handles: diacritics, titles, suffixes, hyphens, transliterations
- [ ] "John Smith" matches "Smith, John" (token reorder)
- [ ] "Mohammed" matches "Muhammad" (phonetic match)
- [ ] "José" matches "Jose" (diacritics)
- [ ] "Dr. John Smith Jr." matches "John Smith" (title/suffix removal)
- [ ] Exact match returns score 100
- [ ] Completely different names return score < 30
- [ ] Performance: < 500ms to screen one name against 12,000 entries
- [ ] Deterministic: same inputs always produce the same score

## Dependencies

- **Depends on**: None (standalone utility)
- **Blocks**: #17 (OFAC SDN), #18 (UK HMT)

## Testing Strategy

1. **Exact match**: "John Smith" vs "John Smith" → 100
2. **Case insensitive**: "JOHN SMITH" vs "john smith" → 100
3. **Diacritics**: "José García" vs "Jose Garcia" → 100 (after normalization)
4. **Title removal**: "Dr. John Smith" vs "John Smith" → 100
5. **Suffix removal**: "John Smith Jr." vs "John Smith" → 100
6. **Token reorder**: "Smith John" vs "John Smith" → ≥ 90
7. **Phonetic**: "Mohammed" vs "Muhammad" → ≥ 80
8. **Typo**: "Jonh Smith" vs "John Smith" → ≥ 85
9. **Abbreviation**: "J. Smith" vs "John Smith" → ≥ 60 (below threshold, needs human review)
10. **Completely different**: "John Smith" vs "Alice Jones" → < 30
11. **Empty input**: "" vs "John Smith" → 0
12. **Hyphenated names**: "al-Rahman" vs "al Rahman" → 100
13. **Transliteration**: "Müller" vs "Mueller" → ≥ 85
14. **Jaro-Winkler unit**: Known inputs with expected Jaro-Winkler scores
15. **Levenshtein unit**: Known edit distances
16. **Soundex unit**: Known Soundex codes (e.g., "Robert" → "R163")
17. **Performance**: Time 12,000 comparisons, assert < 500ms
