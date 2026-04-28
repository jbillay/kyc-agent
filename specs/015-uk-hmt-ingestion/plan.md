# Implementation Plan: UK HMT Sanctions List Ingestion and Search

**Branch**: `015-uk-hmt-ingestion` | **Date**: 2026-04-27 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/015-uk-hmt-ingestion/spec.md`

## Summary

Implement `UKHMTProvider`, a `ScreeningProvider`-compliant class that downloads the UK HMT consolidated CSV sanctions list from GOV.UK, parses its Name1–Name6 field structure, groups rows by Group ID into deduplicated entries, and stores them in PostgreSQL. The provider exposes fuzzy-matched search with DOB/nationality score boosting, idempotent upsert with daily scheduled refresh, and append-only sync audit events. The implementation follows the patterns established by `OFACProvider` and slots into the existing `screening-sync.js` worker by uncommenting a pre-existing stub.

## Technical Context

**Language/Version**: Node.js 20 (JavaScript ES2022, `'use strict'`)  
**Primary Dependencies**: `pg` (PostgreSQL client pool), native `fetch` (HTTP download), `jest` (testing)  
**Storage**: PostgreSQL 16 — `screening_lists`, `screening_entries`, `screening_sync_events` (all pre-existing; no schema changes required)  
**Testing**: Jest — unit tests with mocked `pool` + `fetch`; integration tests with real DB  
**Target Platform**: Linux server (Docker, `screening-sync` service)  
**Project Type**: Backend service module (Layer 2: Data Integration)  
**Performance Goals**: Full list ingestion <30 seconds; search <500 ms  
**Constraints**: No new npm dependencies; existing DB schema unchanged; audit events append-only  
**Scale/Scope**: ~2,000–5,000 HMT entries; single-writer sync process running daily

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Auditability First | ✅ Pass | `_writeSyncEvent` writes to `screening_sync_events` on every sync attempt (success and failure). Table enforced append-only by PostgreSQL rules. |
| II. LLM-Agnostic | ✅ N/A | No LLM calls in this provider. |
| III. Strict Layered Architecture | ✅ Pass | Layer 2 only. Dependencies: `pool` (DB), `fetch` (HTTP), `FuzzyMatcher` (same layer). No imports from L3–L6. |
| IV. Data Sovereignty | ✅ Pass | Downloads to local PostgreSQL; no data leaves deployment boundary. |
| V. Configuration-Driven | ✅ Pass | Source URL and daily sync schedule declared in `config/screening-sources.yaml` (`uk_hmt` key already present). Provider reads `config.sourceUrl` and `config.matchThreshold`. |

All gates pass. No violations. Re-check after Phase 1 design: ✅ no changes to findings.

## Project Structure

### Documentation (this feature)

```text
specs/015-uk-hmt-ingestion/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── provider-interface.md   # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code

```text
backend/src/data-sources/screening/
├── uk-hmt.js            # UKHMTProvider — full implementation (replaces 4-line stub)
└── types.js             # ScreeningProvider interface (read-only reference; unchanged)

backend/src/workers/
└── screening-sync.js    # Uncomment UKHMTProvider lines (3-line change)

tests/backend/data-sources/screening/
└── uk-hmt.test.js       # Unit test suite (~300 lines, new file)
```

No new files outside these locations. No schema migrations required.

**Structure Decision**: Single backend module following the established OFAC provider pattern. The stub `uk-hmt.js` already exists at the correct path; this plan replaces it in-place. The sync worker already contains a commented-out registration stub for `UKHMTProvider` at line 28.

## Complexity Tracking

> No constitution violations. Section left blank.
