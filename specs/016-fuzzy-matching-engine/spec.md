# Feature Specification: Fuzzy Name Matching Engine

**Feature Branch**: `016-fuzzy-matching-engine`  
**Created**: 2026-04-28  
**Status**: Draft  
**Input**: User description: "@specifications/epic-03-data-integration/019-fuzzy-matching/SPEC.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Core Name Comparison with Composite Score (Priority: P1)

The sanctions screening subsystem submits two name strings — a query name (the subject being screened) and a candidate name (from a sanctions list) — and receives a single composite similarity score between 0 and 100. A score at or above the configured threshold indicates a potential match requiring review; below the threshold, the candidate is discarded.

**Why this priority**: This is the atomic operation that all other functionality builds on. Every downstream screening decision depends on a reliable, deterministic composite score. Without it, no sanctions screening is possible.

**Independent Test**: Can be fully tested by submitting known name pairs and asserting the returned score falls within expected ranges (e.g., "John Smith" vs "John Smith" → 100, "John Smith" vs "Jane Doe" → below 30).

**Acceptance Scenarios**:

1. **Given** two identical names, **When** a comparison is requested, **Then** the result contains score 100, isMatch true, and a non-empty matchedFields list.
2. **Given** two completely unrelated names, **When** a comparison is requested, **Then** the result contains a score below 30 and isMatch false.
3. **Given** two phonetically similar names with different spellings (e.g., "Mohammed" vs "Muhammad"), **When** a comparison is requested, **Then** the result contains a score at or above 80 and a non-empty matchedFields list.
4. **Given** the same inputs submitted multiple times, **When** comparisons are requested, **Then** the result is identical every time (deterministic score, isMatch, and matchedFields).

---

### User Story 2 - Name Normalization Before Comparison (Priority: P1)

Before any name pair is compared, both names are passed through a normalization pipeline that removes diacritics, titles, honorifics, name suffixes, punctuation, and hyphens, and resolves common transliterations. This ensures that formatting differences do not prevent valid matches from being identified.

**Why this priority**: Without normalization, a name like "Dr. José García-López Jr." would never match "Jose Garcia Lopez" even though they represent the same person. Normalization is a prerequisite for accurate matching.

**Independent Test**: Can be fully tested by submitting name pairs that differ only in formatting and asserting they produce a score of 100 after normalization (e.g., "José" vs "Jose", "Dr. John Smith Jr." vs "John Smith", "al-Rahman" vs "al Rahman").

**Acceptance Scenarios**:

1. **Given** two names that differ only in diacritics (e.g., "José García" vs "Jose Garcia"), **When** a comparison is requested, **Then** the score is 100.
2. **Given** one name containing a title (e.g., "Dr.", "Prof.", "Sir") and one without, **When** a comparison is requested for otherwise identical names, **Then** the score is 100.
3. **Given** one name containing a suffix (e.g., "Jr.", "III", "Esq.") and one without, **When** a comparison is requested for otherwise identical names, **Then** the score is 100.
4. **Given** names using hyphens versus spaces (e.g., "al-Rahman" vs "al Rahman"), **When** a comparison is requested, **Then** the score is 100.
5. **Given** names using common transliterations (e.g., "Müller" vs "Mueller"), **When** a comparison is requested, **Then** the score is at or above 85.

---

### User Story 3 - Token-Reorder Matching (Priority: P2)

The matching engine handles names where the same tokens appear in a different order — for example, "Smith, John" versus "John Smith". The engine produces a high score regardless of token ordering.

**Why this priority**: Sanctions list entries frequently use surname-first format (e.g., "Smith, John"), while KYC submissions typically use given-name-first format. Failing to reconcile these would generate false negatives on real sanctions matches.

**Independent Test**: Can be fully tested by submitting reordered name pairs and asserting a score at or above 90 (e.g., "Smith John" vs "John Smith").

**Acceptance Scenarios**:

1. **Given** the names "Smith John" and "John Smith", **When** a comparison is requested, **Then** the score is at or above 90.
2. **Given** a name in "Surname, Firstname" format and the same name in "Firstname Surname" format, **When** a comparison is requested, **Then** the score is at or above 90.

---

### User Story 4 - Full Sanctions List Screening Within Performance Budget (Priority: P2)

The KYC platform submits a single query name and requires it to be compared against a full sanctions list (12,000+ entries), with all comparisons completing within 500 milliseconds. The engine screens every entry and returns only those candidates that meet or exceed the configured threshold.

**Why this priority**: Sanctions screening is a blocking step in KYC case processing. If screening takes seconds per case, the platform cannot process cases at scale. The 500ms budget preserves acceptable end-to-end KYC processing time.

**Independent Test**: Can be fully tested by timing 12,000 comparisons and asserting total elapsed time is under 500ms.

**Acceptance Scenarios**:

1. **Given** a query name and a list of 12,000 candidate entries, **When** a full-list comparison is requested, **Then** all comparisons complete in under 500 milliseconds.
2. **Given** a query name that matches a subset of entries above the threshold, **When** a full-list comparison is requested, **Then** only entries meeting or exceeding the threshold are returned.

---

### User Story 5 - Configurable Match Threshold (Priority: P3)

Compliance administrators can set a custom match threshold (0–100) at engine configuration time. The default threshold is 85. All comparisons use the configured threshold to determine whether a candidate is a potential match.

**Why this priority**: Different regulatory contexts or risk appetites may require tighter or looser matching. Configurability allows the engine to be tuned without code changes.

**Independent Test**: Can be fully tested by instantiating the engine with a custom threshold and asserting that the same pair returns a "match" at a low threshold but "no match" at a high threshold.

**Acceptance Scenarios**:

1. **Given** an engine configured with threshold 85 (default), **When** a comparison returns a score of 84, **Then** isMatch is false.
2. **Given** an engine configured with threshold 85 (default), **When** a comparison returns a score of exactly 85, **Then** isMatch is true (inclusive boundary).
3. **Given** an engine configured with a custom threshold of 70, **When** a comparison returns a score of 72, **Then** isMatch is true.
4. **Given** an engine with no threshold configured, **When** comparisons are made, **Then** the default threshold of 85 is applied.

---

### Edge Cases

- What score is returned when either input name is empty or null?
- What score is returned when both names normalize to empty strings (e.g., all punctuation/symbols)?
- How does the engine handle names that consist of a single character (e.g., "J")?
- When a name abbreviates a token to its initial (e.g., "J. Smith" vs "John Smith"), the composite score falls between 50 and 74 — below the default threshold, triggering human review rather than auto-clearance.
- How does the engine handle extremely long names (e.g., 200+ characters)?
- What happens when a name consists entirely of numbers?

## Clarifications

### Session 2026-04-28

- Q: What should the engine return from a single name comparison? → A: A structured result containing score (0–100), isMatch boolean (derived from threshold), and matchedFields (list of which name tokens contributed to the match).
- Q: When a composite score equals the configured threshold exactly, should isMatch be true or false? → A: Inclusive — score ≥ threshold → isMatch true (a score of 85 against a threshold of 85 is a match).
- Q: What score floor should apply when a name token is abbreviated to its initial (e.g., "J" matching "John")? → A: Score between 50 and 74 — below the default threshold (forces human review) but above the unrelated-name floor of 30.
- Q: Should the engine support screening against multiple lists in one call, or separate calls per list? → A: Separate independent calls — each list (OFAC, HMT, etc.) is screened independently; the 500ms budget applies per-list.
- Q: Should matchedFields contain actual token strings or positional/structural descriptors? → A: Actual token strings — matchedFields contains the literal matched tokens from both query and candidate (e.g., ["mohammed", "muhammad"]) to support readable audit trail evidence in Decision Fragments.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The engine MUST compare two name strings and return a structured result containing: (a) a composite similarity score in the range 0–100, (b) a boolean indicating whether the score meets or exceeds the configured threshold (isMatch), and (c) a list of the literal matched token strings from both the query and candidate names (matchedFields) that contributed most to the score.
- **FR-002**: The composite score MUST be derived from a weighted combination of at least four algorithms: string edit distance, prefix-weighted string similarity, phonetic encoding, and token-sorted comparison.
- **FR-003**: The engine MUST normalize both names before comparison, removing diacritics, honorific titles (Mr, Mrs, Ms, Miss, Dr, Prof, Sir, Dame, Lord, Lady, Rev, Hon), name suffixes (Jr, Sr, II, III, IV, Esq, PhD, MD), punctuation, and hyphens, and collapsing whitespace.
- **FR-004**: The engine MUST handle common transliterations during normalization (ø→o, æ→ae, ß→ss, ð→d, þ→th).
- **FR-005**: The engine MUST produce identical scores for identical inputs on every invocation (deterministic behavior).
- **FR-006**: The engine MUST operate without any external API calls or network dependencies — all computation is performed locally.
- **FR-007**: The engine MUST support a configurable match threshold (0–100), defaulting to 85 when not specified. A score is considered a match when it is greater than or equal to the threshold (inclusive boundary).
- **FR-008**: When either input normalizes to an empty string, the engine MUST return a score of 0.
- **FR-009**: When both normalized inputs are identical, the engine MUST return a score of 100.
- **FR-010**: The engine MUST handle token reordering such that "John Smith" and "Smith John" produce a score at or above 90.
- **FR-011**: The engine MUST perform phonetic matching so that names with similar pronunciation but different spellings (e.g., "Mohammed" vs "Muhammad") produce a score at or above 80.
- **FR-012**: Algorithm weights MUST be configurable at engine instantiation, defaulting to values that satisfy all acceptance criteria.
- **FR-013**: When one name token is reduced to a single initial that matches the first character of the corresponding full token (e.g., "J" vs "John"), the composite score MUST fall between 50 and 74 — below the default threshold to ensure human review, but above 30 to distinguish it from completely unrelated names.

### Key Entities

- **Query Name**: The name string submitted for screening (the subject of the KYC case or a related party).
- **Candidate Name**: A name string from a sanctions list entry being compared against the query.
- **Composite Score**: A number 0–100 representing the degree of similarity between query and candidate, derived from weighted algorithm results.
- **Match Threshold**: A configurable number (0–100) above which a composite score indicates a potential match requiring human review. Default is 85.
- **Normalized Name**: The result of processing an input name through the normalization pipeline; used as the basis for all algorithm comparisons.
- **Match Result**: The structured object returned by a single comparison, containing score (0–100), isMatch (boolean), and matchedFields (list of token-level components that drove the match).
- **Matched Fields**: The literal name token strings from both the query and candidate that produced the highest individual algorithm scores (e.g., `["mohammed", "muhammad"]`). Included in the Match Result and used as human-readable evidence in Decision Fragments for audit trail review.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A single name can be compared against a list of 12,000 candidates in under 500 milliseconds on standard server-class hardware. Each list is screened independently; the 500ms budget applies per list, not per combined multi-list operation.
- **SC-002**: Identical name pairs always produce a score of 100, regardless of how many times the comparison is repeated.
- **SC-003**: Name pairs differing only in diacritics, titles, or suffixes produce a score of 100 after normalization.
- **SC-004**: Token-reordered name pairs (e.g., "John Smith" vs "Smith, John") produce a score at or above 90.
- **SC-005**: Phonetically similar name pairs with different spellings produce a score at or above 80.
- **SC-006**: Completely unrelated name pairs produce a score below 30.
- **SC-007**: All acceptance scenarios defined in this specification produce scores that fall within the stated expected ranges without exception.
- **SC-008**: A name pair where one token is abbreviated to its initial (e.g., "J. Smith" vs "John Smith") produces a score between 50 and 74, below the default threshold, resulting in isMatch false and triggering human review.

## Assumptions

- The engine is a standalone utility with no persistent state; it does not store or cache comparison results between invocations.
- Each sanctions list (OFAC, HMT, etc.) is screened via a separate independent call; the engine does not combine multiple lists into a single operation. Aggregating results across lists is the responsibility of the calling screening provider.
- Caller systems (OFAC and UK HMT screening providers) are responsible for supplying pre-loaded candidate lists; the engine does not fetch or update sanctions data.
- Name normalization is applied at comparison time; pre-normalization of stored list entries by ingestor services is an optimization responsibility of those services, not this engine.
- The engine handles Latin-script names and common transliterations to Latin script; non-Latin scripts (Arabic, Cyrillic, Chinese, etc.) that arrive without prior transliteration are out of scope for this feature.
- "Standard server-class hardware" for the performance target refers to hardware comparable to what hosts the KYC platform Docker services.
- Algorithm weights can be overridden at instantiation; the defaults (Jaro-Winkler 0.40, Levenshtein 0.30, Phonetic 0.15, Token-sort 0.15) are used unless explicitly overridden.
- Abbreviation matching (e.g., "J. Smith" vs "John Smith") is expected to score below the default threshold and is intentionally flagged for human review rather than automatic clearance.
