# EPIC: Screening Agent (Phase 1 — Sanctions Only)

> GitHub Issue: [#30](https://github.com/jbillay/kyc-agent/issues/30)
> Milestone: Phase 1 — Foundation
> Labels: `epic`, `agent`, `screening`

## Overview

The Screening Agent checks every person and entity involved in a KYC case against sanctions lists. In Phase 1, this covers OFAC SDN and UK HMT only — PEP screening and adverse media are added in Phase 2. The agent compiles a screening list from the Entity Resolution Agent's output, runs fuzzy name matching against locally cached sanctions lists, then uses an LLM to evaluate each potential hit and decide whether it's a true match or false positive. This dramatically reduces the false positive rate compared to simple keyword matching.

The Screening Agent runs in parallel with the Ownership/UBO Agent after entity resolution completes. Its output — the `ScreeningReport` — feeds into the Risk Assessment Agent.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #31 | Compile screening list from case data | M | Critical | `compile-screening-list/` |
| #32 | Run sanctions screening against local lists | L | Critical | `sanctions-screening/` |
| #33 | LLM-based hit evaluation and dismissal | L | Critical | `hit-evaluation/` |

## Dependency Map

```
#31 Compile Screening List ─────────────────────────┐
    (collect directors, shareholders, entities        │
     from EntityProfile, deduplicate)                 │
    │                                                 │
    ▼                                                 │
#32 Run Sanctions Screening                           │
    (query OFAC + UK HMT for each subject,            │
     fuzzy match, collect potential hits)              │
    │                                                 │
    ▼                                                 │
#33 LLM Hit Evaluation + Report                       │
    (LLM confirms/dismisses each hit,                 │
     compile ScreeningReport)                         │

Recommended implementation order:
  1. #31 Compile Screening List (input assembly)
  2. #32 Sanctions Screening (depends on #31, #17, #18, #19)
  3. #33 Hit Evaluation (depends on #32, #8 LLM service)
```

## External Dependencies

```
Agent Framework Core (#20):
  ├── #21 BaseAgent       ← ScreeningAgent extends BaseAgent
  ├── #22 Decision Fragments ← produces sanctions_clear, sanctions_hit, sanctions_dismissed
  └── #25 Event Store     ← emits step events

Data Integration Layer (#13):
  ├── #17 OFAC SDN Provider   ← OFACProvider.search()
  ├── #18 UK HMT Provider     ← UKHMTProvider.search()
  ├── #19 Fuzzy Matcher        ← underlying matching engine
  └── #16 Data Caching         ← screening results cached

Entity Resolution Agent (#26):
  └── #27-#28 EntityProfile    ← source of officers, shareholders, entity name

LLM Abstraction Layer (#7):
  └── #8 LLM Service           ← hit evaluation (screening task type)
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 5.4.3 — Screening Agent (6-step pipeline; Phase 1 implements steps 1-3 and 6)
- Section 4.2.2 — Screening Providers (ScreeningProvider interface, ScreeningQuery, ScreeningHit)
- Section 5.5 — Orchestrator (screening runs parallel with ownership after entity resolution)

## File Layout

```
backend/src/agents/screening/
├── index.js              # ScreeningAgent class
├── prompts.js            # LLM prompt templates for hit evaluation
├── screening-list.js     # Screening subject compilation and deduplication
└── screening-report.js   # ScreeningReport type definition
```

## Agent Steps (Phase 1)

| # | Step | LLM Task | Data Sources | Decision Fragments |
|---|------|----------|-------------|-------------------|
| 1 | `compile_screening_list` | — | EntityProfile (from context) | — (informational) |
| 2 | `run_sanctions_screening` | — | OFACProvider, UKHMTProvider | `sanctions_clear` (per clean subject) |
| 3 | `evaluate_sanctions_hits` | screening | — | `sanctions_hit` or `sanctions_dismissed` (per hit) |
| 4 | `compile_screening_report` | — | — | — (assembles final output) |

Steps 4-5 from the architecture (PEP + adverse media) are deferred to Phase 2.

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| LLM for hit evaluation | screening task type | Simple name matching produces too many false positives; LLM can weigh DOB, nationality, context |
| Conservative by default | When in doubt, confirm hit | Regulatory risk of missing a true hit outweighs cost of human review |
| Local screening lists | Query PostgreSQL, not APIs | Instant screening (no network latency), offline capable, auditable |
| Deduplication before screening | Single pass per unique person | Avoids redundant screening of same person appearing as both director and shareholder |
| Per-subject fragments | One fragment per person per list | Granular audit trail — reviewer can see exactly which lists were checked for each person |

## Pipeline Position

```
Entity Resolution ──► Screening Agent ──► Risk Assessment
                  │                         ▲
                  └──► Ownership Agent ──────┘
                       (parallel)
```

## Definition of Done

- [ ] `ScreeningAgent` extends `BaseAgent` with 4 steps (compile, screen, evaluate, report)
- [ ] Screening list compiled from EntityProfile (directors, shareholders, entity itself)
- [ ] Deduplication removes duplicate entries (same person as director + shareholder)
- [ ] All subjects screened against OFAC SDN and UK HMT
- [ ] Fuzzy matching with configurable threshold (default 85%)
- [ ] LLM evaluates each potential hit with structured confirm/dismiss reasoning
- [ ] `sanctions_clear` fragment for each clean subject
- [ ] `sanctions_hit` fragment for confirmed matches (with `pending_review` status)
- [ ] `sanctions_dismissed` fragment for false positives (with reasoning)
- [ ] `ScreeningReport` output assembled for Risk Assessment Agent
- [ ] Full screening of typical case (10-15 subjects) completes in under 60 seconds
- [ ] Integration test with known SDN entries
