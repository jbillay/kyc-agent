# Tasks: Fuzzy Name Matching Engine

**Input**: Design documents from `/specs/016-fuzzy-matching-engine/`  
**Prerequisites**: plan.md ✓ spec.md ✓ research.md ✓ data-model.md ✓ contracts/ ✓ quickstart.md ✓

**Tests**: Included — spec.md acceptance criteria explicitly names 17 test cases; SC-007 requires all to pass.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: Which user story this task belongs to (US1–US5)
- All file paths are absolute from repository root

---

## Phase 1: Setup

**Purpose**: Add the `MatchResult` typedef so all subsequent phases can reference the return type.

- [x] T001 Add `MatchResult` typedef to `backend/src/data-sources/screening/types.js` — fields: `score` (number 0–100), `isMatch` (boolean, score ≥ threshold), `matchedFields` (string[]) — see data-model.md

**Checkpoint**: `types.js` exports a documented `MatchResult` typedef; downstream code and tests can reference it.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before any user story algorithm can be implemented or tested.

**⚠️ CRITICAL**: Normalization is a blocking prerequisite for all comparison algorithms and all user stories. The test file skeleton must also exist before test tasks in later phases can be written.

- [x] T002 Create test file `tests/backend/data-sources/screening/fuzzy-matcher.test.js` with top-level `describe('FuzzyMatcher', ...)` block and empty nested `describe` blocks for: `normalize`, `jaroWinkler`, `levenshteinScore`, `phoneticScore`, `tokenSortScore`, `compare`, `performance`, `threshold`
- [x] T003 [US2] Implement `normalize(name)` method in `backend/src/data-sources/screening/fuzzy-matcher.js` — pipeline: lowercase → NFD diacritics strip (U+0300–U+036F) → explicit transliterations (ø→o, æ→ae, ß→ss, ð→d, þ→th) → title removal (mr, mrs, ms, miss, dr, prof, sir, dame, lord, lady, rev, hon, with optional `.`) → suffix removal (jr, sr, ii, iii, iv, esq, phd, md, with optional `.`) → strip punctuation except spaces → replace hyphens with spaces → collapse whitespace → trim; return `""` for null/undefined/empty
- [x] T004 [US2] Write `normalize()` unit tests in `tests/backend/data-sources/screening/fuzzy-matcher.test.js` — cover: diacritics ("José García" → "jose garcia"), title removal ("Dr. John Smith" → "john smith"), suffix removal ("John Smith Jr." → "john smith"), hyphen-to-space ("al-Rahman" → "al rahman"), transliteration (ß→ss, ø→o, æ→ae), combined pipeline ("Dr. José García-López Jr." → "jose garcia lopez"), empty string → "", null → "", title-only input → ""

**Checkpoint**: `normalize()` is implemented and all T004 tests pass. Foundation ready for algorithm implementation.

---

## Phase 3: User Story 1 — Core Name Comparison with Composite Score (Priority: P1) 🎯 MVP

**Goal**: A two-name comparison returns `{ score, isMatch, matchedFields }` using a weighted four-algorithm composite. Identical names score 100; unrelated names score below 30; phonetic variants score ≥ 80.

**Independent Test**: Run `cd backend && npx jest tests/backend/data-sources/screening/fuzzy-matcher.test.js` and assert: "John Smith" vs "John Smith" → score 100, isMatch true; "John Smith" vs "Jane Doe" → score < 30, isMatch false; "Mohammed" vs "Muhammad" → score ≥ 80, isMatch false (default threshold 85, but score is ≥ 80); same inputs × 3 → identical results.

### Algorithm Implementations (T005–T008 are independent — can be done in parallel)

- [x] T005 [P] [US1] Implement `jaroWinkler(s1, s2)` in `backend/src/data-sources/screening/fuzzy-matcher.js` — match window `floor(max(|s1|,|s2|)/2)-1`, count matches and transpositions, compute jaro, apply Winkler prefix bonus (p=0.1, max prefix=4); return 0.0–1.0; handle equal strings → 1.0, either empty → 0.0
- [x] T006 [P] [US1] Implement `_levenshteinDistance(s1, s2)` and `levenshteinScore(s1, s2)` in `backend/src/data-sources/screening/fuzzy-matcher.js` — Wagner-Fischer DP with rolling single-row array (O(n) space); similarity = `1.0 - distance / max(|s1|, |s2|)`; empty both → 1.0
- [x] T007 [P] [US1] Implement `_soundex(word)` and `phoneticScore(s1, s2)` in `backend/src/data-sources/screening/fuzzy-matcher.js` — standard Soundex 4-char code (initial letter + 3 digits, map B/F/P/V→1, C/G/J/K/Q/S/X/Z→2, D/T→3, L→4, M/N→5, R→6); phoneticScore = matched token codes / max(tokens1, tokens2); return `"0000"` for empty word
- [x] T008 [P] [US1] Implement `tokenSortScore(s1, s2)` in `backend/src/data-sources/screening/fuzzy-matcher.js` — split on whitespace, sort tokens alphabetically, rejoin with space, apply `jaroWinkler()` on sorted strings; returns 0.0–1.0

### Composite + Return Value

- [x] T009 [US1] Implement `compare(query, candidate)` in `backend/src/data-sources/screening/fuzzy-matcher.js` — normalize both inputs; if either normalizes to "": return `{ score: 0, isMatch: false, matchedFields: [] }`; if normalized strings are equal: return `{ score: 100, isMatch: true, matchedFields: [...all tokens...] }`; otherwise compute weighted composite `Math.round(jw*0.40*100 + lev*0.30*100 + phon*0.15*100 + token*0.15*100)`, clamp 0–100; set `isMatch = score >= this.threshold`; compute `matchedFields` (see T010); correct default threshold from stub's 70 to 85 in constructor (depends on T005–T008)
- [x] T010 [US1] Implement `matchedFields` extraction inside `compare()` in `backend/src/data-sources/screening/fuzzy-matcher.js` — split normalized query and candidate into tokens; for each query token find best-scoring candidate token via `jaroWinkler()` (threshold > 0.5); for matched pairs include both literal strings in flat array `[queryTok, candidateTok, ...]`; deduplicate; return `[]` when score is 0

### Tests for User Story 1

- [x] T011 [P] [US1] Write `compare()` acceptance tests in `tests/backend/data-sources/screening/fuzzy-matcher.test.js` — cover all spec acceptance scenarios: exact match ("John Smith" vs "John Smith" → score 100, isMatch true, non-empty matchedFields), case-insensitive ("JOHN SMITH" vs "john smith" → 100), phonetic ("Mohammed" vs "Muhammad" → score ≥ 80), typo ("Jonh Smith" vs "John Smith" → score ≥ 85, isMatch true), abbreviation ("J. Smith" vs "John Smith" → 50–74, isMatch false), completely different ("John Smith" vs "Alice Jones" → < 30, isMatch false), empty input ("" vs "John Smith" → 0, isMatch false, matchedFields [])
- [x] T012 [P] [US1] Write algorithm unit tests in `tests/backend/data-sources/screening/fuzzy-matcher.test.js` — Jaro-Winkler: ("MARTHA", "MARHTA") → ~0.944, ("DIXON", "DICKSONX") → ~0.813; Levenshtein: distance("kitten","sitting") = 3, similarity("", "") = 1.0; Soundex: "Robert" → "R163", "John" → "J500", "Smith" → "S530", empty → "0000"; determinism: `compare("A","B")` called 3 times → identical result

**Checkpoint**: `compare()` is fully implemented. T011 and T012 all pass. `FuzzyMatcher` is MVP-functional.

---

## Phase 4: User Story 2 — Name Normalization (already implemented in Phase 2, tests complete at T004)

**Note**: US2 normalization was implemented as foundational (T003–T004) because it blocks all other user stories. The Phase 2 checkpoint verifies US2's independent test criteria in full. No additional tasks required here.

---

## Phase 5: User Story 3 — Token-Reorder Matching (Priority: P2)

**Goal**: Names with the same tokens in different order score ≥ 90. "Smith, John" ↔ "John Smith". This is exercised through `compare()` — no new implementation needed; only acceptance tests verify the behaviour.

**Independent Test**: `compare("Smith John", "John Smith")` → score ≥ 90, isMatch true.

- [x] T013 [US3] Write token-reorder acceptance tests in `tests/backend/data-sources/screening/fuzzy-matcher.test.js` — cover: ("Smith John", "John Smith") → score ≥ 90 isMatch true; ("Smith, John", "John Smith") → score ≥ 90 isMatch true (comma stripped by normalize); ("Garcia Lopez Jose Maria", "Jose Maria Garcia Lopez") → score ≥ 90

**Checkpoint**: Token-reorder tests pass. US3 verified independently.

---

## Phase 6: User Story 4 — Full Sanctions List Screening Within Performance Budget (Priority: P2)

**Goal**: 12,000 comparisons complete in < 500ms. Includes the performance test and any optimisations needed to meet the budget.

**Independent Test**: Time a loop of 12,000 `compare()` calls against varied names; assert total elapsed < 500ms.

- [x] T014 [US4] Write performance test in `tests/backend/data-sources/screening/fuzzy-matcher.test.js` — generate array of 12,000 synthetic candidate strings; time `matcher.compare(queryName, candidate)` for each; assert total elapsed < 500ms; use `Date.now()` or `process.hrtime.bigint()` for timing; run in a `test.concurrent` block so Jest doesn't impose artificial delays
- [x] T015 [US4] Apply performance optimisations in `backend/src/data-sources/screening/fuzzy-matcher.js` if T014 fails: (a) early-exit in `compare()` when post-normalization strings are equal (already in T009); (b) skip Soundex computation when `jaroWinkler` score > 0.98 (effectively identical); (c) verify Levenshtein uses the rolling single-row array (O(n) space, not O(n²))

**Checkpoint**: Performance test passes (< 500ms for 12,000 comparisons). US4 verified.

---

## Phase 7: User Story 5 — Configurable Match Threshold (Priority: P3)

**Goal**: Engine respects a constructor-supplied threshold; default is 85; boundary is inclusive (score ≥ threshold → isMatch true).

**Independent Test**: Instantiate with threshold 70; compare a name pair that scores ~72; assert isMatch true. Instantiate with default; assert threshold is 85.

- [x] T016 [US5] Write threshold acceptance tests in `tests/backend/data-sources/screening/fuzzy-matcher.test.js` — cover: default threshold = 85 (verify via `matcher.threshold`); score 84 with threshold 85 → isMatch false; score exactly 85 with threshold 85 → isMatch true (inclusive boundary); custom threshold 70 + score 72 → isMatch true; custom threshold 70 + score 69 → isMatch false

**Checkpoint**: Threshold tests pass. All five user stories verified. Full acceptance test suite green.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Regression verification, integration health check, final cleanup.

- [x] T017 [P] Verify OFAC provider tests still pass without modification — run `cd backend && npx jest tests/backend/data-sources/screening/ofac.test.js`; `OFACProvider` imports `FuzzyMatcher` via the stub interface; confirm the new implementation is backward-compatible (constructor signature `{ threshold }` still works; `compare()` now returns `MatchResult` instead of throwing — verify callers handle the return type correctly in `ofac.js`)
- [x] T018 [P] Verify UK HMT provider tests still pass — run `cd backend && npx jest tests/backend/data-sources/screening/uk-hmt.test.js`; same compatibility check as T017
- [x] T019 Run the full backend test suite — `cd backend && npm test`; confirm all tests pass with zero regressions

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — start immediately
- **Phase 2 (Foundational)**: Depends on Phase 1 — BLOCKS all user story phases
- **Phase 3 (US1 Core Comparison)**: Depends on Phase 2 completion (normalize() must exist)
- **Phase 5 (US3 Token-Reorder)**: Depends on Phase 3 (compare() must exist)
- **Phase 6 (US4 Performance)**: Depends on Phase 3 (compare() must exist)
- **Phase 7 (US5 Threshold)**: Depends on Phase 3 (compare() + constructor must exist)
- **Phase 8 (Polish)**: Depends on all prior phases being green

### User Story Dependencies

- **US2 (P1 — Normalization)**: T003–T004 in Phase 2 — no story dependencies
- **US1 (P1 — Comparison)**: T005–T012 in Phase 3 — depends on US2 (normalize must exist)
- **US3 (P2 — Token-Reorder)**: T013 in Phase 5 — depends on US1 (compare must exist)
- **US4 (P2 — Performance)**: T014–T015 in Phase 6 — depends on US1 (compare must exist)
- **US5 (P3 — Threshold)**: T016 in Phase 7 — depends on US1 (compare + constructor must exist)

### Within Phase 3: Parallel Algorithm Implementations

T005, T006, T007, T008 are all independent (different methods, no shared state) — implement in parallel:

```
T005 jaroWinkler()       ─┐
T006 levenshteinScore()  ─┤──→ T009 compare() ──→ T010 matchedFields
T007 phoneticScore()     ─┤              └──────→ T011 acceptance tests
T008 tokenSortScore()    ─┘              └──────→ T012 unit tests
```

### Cross-Phase Parallel Opportunities

Once Phase 3 is complete, Phases 5, 6, and 7 can proceed in any order or in parallel (they only add test tasks to the same test file — coordinate to avoid merge conflicts):

```
Phase 3 complete ──→ Phase 5 (T013)  ─┐
                 ──→ Phase 6 (T014)  ─┤──→ Phase 8 (T017, T018, T019)
                 ──→ Phase 7 (T016)  ─┘
```

---

## Parallel Examples

### Phase 3: Algorithm Implementations

```
# All four can be implemented simultaneously (different methods, same file — coordinate line ranges):
T005: jaroWinkler() — lines ~140–200
T006: levenshteinScore() / _levenshteinDistance() — lines ~210–250
T007: phoneticScore() / _soundex() — lines ~255–315
T008: tokenSortScore() — lines ~320–335
```

### Phase 3: Tests (after T005–T010 complete)

```
# T011 and T012 are independent test blocks in the same file:
T011: compare() acceptance tests (describe('compare', ...) block)
T012: Algorithm unit tests (describe('jaroWinkler', ...), describe('levenshtein', ...), describe('soundex', ...) blocks)
```

### Phase 8: Regression checks

```
# T017 and T018 hit different test files — run simultaneously:
T017: npx jest tests/backend/data-sources/screening/ofac.test.js
T018: npx jest tests/backend/data-sources/screening/uk-hmt.test.js
```

---

## Implementation Strategy

### MVP (User Story 1 + 2 only)

1. Phase 1: T001 (typedef) — ~5 min
2. Phase 2: T002–T004 (normalize + tests) — ~30 min
3. Phase 3: T005–T012 (algorithms + compare + tests) — ~2 hours
4. **STOP and VALIDATE**: `cd backend && npx jest tests/backend/data-sources/screening/fuzzy-matcher.test.js`
5. At this point the engine is fully functional for OFAC and HMT providers to consume

### Incremental Delivery

1. MVP above → engine operational with default settings
2. Phase 5 (T013): Token-reorder verified
3. Phase 6 (T014–T015): Performance confirmed ≤500ms
4. Phase 7 (T016): Threshold configurability locked in
5. Phase 8 (T017–T019): Regression-free, production-ready

### Notes

- All 19 tasks modify only 2 source files (`fuzzy-matcher.js`, `types.js`) and 1 test file
- T003 and T009 modify `fuzzy-matcher.js` in separate method scopes — coordinate if working in parallel
- The constructor default threshold must change from `70` (stub) to `85` (spec) in T009
- `compare()` previously threw `NotImplemented` — after T009, OFAC/HMT providers that catch this error will change behaviour; verify in T017/T018
