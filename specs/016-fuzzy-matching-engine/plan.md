# Implementation Plan: Fuzzy Name Matching Engine

**Branch**: `016-fuzzy-matching-engine` | **Date**: 2026-04-28 | **Spec**: [spec.md](spec.md)  
**Input**: Feature specification from `/specs/016-fuzzy-matching-engine/spec.md`

## Summary

Replace the `FuzzyMatcher` stub in `backend/src/data-sources/screening/fuzzy-matcher.js` with a full multi-algorithm matching engine. The engine combines Jaro-Winkler (0.40), Levenshtein (0.30), Soundex phonetic (0.15), and token-sort (0.15) into a composite 0–100 score. Each comparison returns `{ score, isMatch, matchedFields }`. The implementation is pure JavaScript with no new npm dependencies, deterministic, and capable of screening 12,000 candidates in under 500ms.

## Technical Context

**Language/Version**: Node.js 22+ (JavaScript, CommonJS — `'use strict'`)  
**Primary Dependencies**: None new — pure JS algorithms, no external libraries  
**Storage**: N/A (stateless utility, no persistence)  
**Testing**: Jest 29+ (`cd backend && npm test`; roots at `tests/backend/`)  
**Target Platform**: Linux server (Docker container, same environment as `api` and `agent-worker` services)  
**Project Type**: Internal utility module (Layer 2 Data Integration)  
**Performance Goals**: ≤ 500ms for 12,000 comparisons per list (≈ 41μs per comparison)  
**Constraints**: No external API calls; deterministic output; no new npm dependencies; CommonJS module format  
**Scale/Scope**: Called once per case during sanctions screening; at most a few concurrent calls across agent-worker replicas

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I — Auditability First | ✓ Pass | Engine output (`matchedFields`, `score`) feeds `ScreeningHit` objects which are stored as Decision Fragment evidence. Engine itself is stateless; audit trail responsibility lies with the screening agent layer above. |
| II — LLM-Agnostic Provider Interface | ✓ Pass | No LLM calls. Pure string/algorithmic computation only. |
| III — Strict Layered Architecture | ✓ Pass | Module resides in Layer 2 (`backend/src/data-sources/screening/`). Zero dependencies on L3–L6. |
| IV — Data Sovereignty & Standalone Deployment | ✓ Pass | All computation local. No network calls. |
| V — Configuration-Driven Compliance Logic | ✓ Pass | Threshold (default 85) and algorithm weights are constructor parameters; driven from caller configuration, not hardcoded. |

**Post-Phase 1 re-check**: All gates still pass — design introduces no cross-layer dependencies, no external calls, and no hardcoded thresholds.

## Project Structure

### Documentation (this feature)

```text
specs/016-fuzzy-matching-engine/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── fuzzy-matcher.md # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
backend/src/data-sources/screening/
├── fuzzy-matcher.js     # REPLACE stub with full implementation
└── types.js             # Existing — add MatchResult typedef

tests/backend/data-sources/screening/
└── fuzzy-matcher.test.js  # NEW — 17 acceptance cases + 1 performance case
```

**Structure Decision**: Single-module addition within existing Layer 2 screening directory. No new directories in source. Test file mirrors the existing `ofac.test.js` / `uk-hmt.test.js` pattern in `tests/backend/data-sources/screening/`.
