# Research: Fuzzy Name Matching Engine

**Branch**: `016-fuzzy-matching-engine` | **Date**: 2026-04-28

## Algorithm Selection

### Decision: Four-algorithm weighted composite
**Rationale**: No single string similarity algorithm handles all sanctions screening edge cases. The four-algorithm combination covers distinct failure modes: Jaro-Winkler for short strings with prefix variants; Levenshtein for typo/transposition resilience; Soundex for pronunciation-based transliteration variants; token sort for name reordering.  
**Alternatives considered**:
- Damerau-Levenshtein (adds transposition as primitive op): Rejected — marginal improvement over standard Levenshtein for name matching; adds complexity without meaningful accuracy gain given Jaro-Winkler already rewards common prefixes.
- Double Metaphone (vs Soundex): Better for non-English names. Deferred — Soundex sufficient for the Latin-script scope of this feature; Double Metaphone can be substituted later without changing the interface.
- N-gram similarity: Rejected — higher computational cost; token-sort + Jaro-Winkler already handles the partial-token cases n-grams would catch.

---

### Jaro-Winkler (weight: 0.40)

**Decision**: Standard Jaro-Winkler with Winkler prefix bonus (p = 0.1, max 4 chars), implemented from first principles in pure JS.  
**Rationale**: Highest weight because names are short strings (2–30 chars) and typically share prefixes when they are variants of the same name. The Winkler bonus directly rewards this. No library needed — the algorithm is 30 lines of array manipulation.  
**Key invariants**:
- Match window: `floor(max(|s1|, |s2|) / 2) - 1`
- Transpositions counted as half: `(matches - transpositions/2) / matches`
- Winkler bonus: `jaro + prefix_len * 0.1 * (1 - jaro)`, capped at prefix_len = 4

---

### Levenshtein Edit Distance (weight: 0.30)

**Decision**: Classic Wagner-Fischer dynamic programming with single-row space optimization, converted to 0–1 similarity via `1 - distance / max(|s1|, |s2|)`.  
**Rationale**: Edit distance directly models the typos and character insertions/deletions common in manual data entry. The rolling-array variant uses O(n) memory instead of O(n²), critical for repeated calls in bulk screening.  
**Performance note**: For average name length of 15 chars, inner loop is 225 iterations. At 12,000 candidates this is 2.7M iterations — well within JS engine throughput at ~10⁹ simple ops/sec.

---

### Soundex Phonetic Encoding (weight: 0.15)

**Decision**: Standard American Soundex (4-char code: initial letter + 3 digits) applied per token; score = matched token count / max(tokens1, tokens2).  
**Rationale**: Catches pronunciation-based variants that confuse string algorithms: "Mohammed" / "Muhammad" / "Muhammed" all encode to M530. Simple, fast (O(n) per token), and deterministic.  
**Limitations**: Anglo-centric encoding; poor for Arabic and Slavic transliterations beyond common patterns. Acceptable given Latin-script scope constraint.  
**Alternatives considered**: Double Metaphone — more accurate for non-English names, but significantly more complex. Deferred to a future iteration when non-Latin transliteration scope is extended.

---

### Token Sort (weight: 0.15)

**Decision**: Split on whitespace, sort tokens alphabetically, rejoin, then apply Jaro-Winkler on the sorted strings.  
**Rationale**: Directly handles surname-first vs. given-name-first variants ("Smith John" ↔ "John Smith") without any name-structure heuristics. Sorting is O(k log k) on k tokens (typically 2–4) — negligible overhead.  
**Note**: Token sort shares the Jaro-Winkler implementation, keeping the code surface small.

---

## Name Normalization

**Decision**: Sequential pipeline: lowercase → NFD diacritics removal → explicit transliterations (ø, æ, ß, ð, þ) → title removal → suffix removal → punctuation strip → hyphen-to-space → whitespace collapse.

**Rationale**: Order matters — diacritics must be stripped before title/suffix patterns are matched (so "Ḍr." is handled); hyphens must become spaces before punctuation strip (so "al-Rahman" → "al rahman" not "alrahman"). The pipeline is idempotent — running it twice produces the same result.

**Title list**: mr, mrs, ms, miss, dr, prof, sir, dame, lord, lady, rev, hon (with optional trailing period)  
**Suffix list**: jr, sr, ii, iii, iv, esq, phd, md (with optional trailing period)

---

## matchedFields Design

**Decision**: Return the literal token strings from query and candidate that produced the highest per-token similarity. Format: flat array alternating `[query_token, candidate_token, ...]` for each matched pair, deduplicated.

**Example**: "Mohammed Al-Rahman" vs "Muhammad Rahman":
- Token pair ("mohammed", "muhammad") — phonetic match (both M530) + high Jaro-Winkler
- Token pair ("rahman", "rahman") — exact match
- Result: `["mohammed", "muhammad", "rahman", "rahman"]`

**Rationale**: A flat string array is the lightest representation that gives a compliance reviewer the evidence needed to evaluate a hit. Matches the `ScreeningHit.matchedFields` field type (`string[]`) already defined in `types.js`, requiring no interface change upstream.

**Implementation approach**: After normalization, run Jaro-Winkler on all token cross-pairs. For each query token, pick the best-scoring candidate token (score > 0.5). Include both strings in the output if they are not already present.

---

## Performance Budget Analysis

| Step | Ops per comparison | Time estimate |
|------|--------------------|---------------|
| Normalize (×2) | ~200 regex ops each | ~5μs |
| Jaro-Winkler | ~225–400 array ops | ~10μs |
| Levenshtein | ~225–400 array iterations | ~10μs |
| Soundex (2–4 tokens each) | ~40–80 char ops | ~2μs |
| Token sort + Jaro-Winkler | ~225–400 array ops (sorted) | ~10μs |
| matchedFields token pairs | ~16 Jaro-Winkler cross-pairs | ~5μs |
| **Total per comparison** | — | **~42μs** |
| **12,000 comparisons** | — | **~504ms** |

**Risk**: Budget is tight. Mitigations: (1) pre-normalize candidate names during list ingestion so only the query needs normalization at search time; (2) skip Soundex when Levenshtein score > 0.95 (exact-enough match); (3) early-exit if Jaro-Winkler alone exceeds 0.98 (return score 100 immediately). These optimizations are applied in the implementation.

---

## Threshold Default Correction

**Finding**: The existing stub sets `threshold = 70` as a placeholder. The specification (FR-007) and constitution-aligned default is **85**. The implementation will correct this to 85.

**Impact on existing callers**: `OFACProvider` and `UKHMTProvider` pass their own threshold from configuration. The stub's default was never production-used. No breaking change.

---

## No New Dependencies

**Decision**: Implement all algorithms from first principles. No npm packages.  
**Rationale**: Aligns with Constitution Principle IV (no unexpected data egress via transitive deps), keeps the dependency surface minimal for a security-sensitive module, and the algorithms are short enough (total ~200 lines) to maintain directly. Libraries like `natural`, `fuse.js`, or `fastest-levenshtein` would each add a transitive dep tree to a sanctions screening module.
