# EPIC: Entity Resolution Agent

> GitHub Issue: [#26](https://github.com/jbillay/kyc-agent/issues/26)
> Milestone: Phase 1 — Foundation
> Labels: `epic`, `agent`

## Overview

The first specialized agent in the KYC pipeline. Given a client name and optional identifiers (registration number, jurisdiction), the Entity Resolution Agent resolves the client to a verified entity in a corporate registry (Companies House for UK entities). It searches for candidates, uses LLM evaluation to rank matches, extracts full entity details (officers, shareholders, filings), and validates the entity for red flags. Its output — the `EntityProfile` — feeds directly into the Ownership/UBO and Screening agents.

This is the critical first step: if entity resolution fails or matches the wrong company, every downstream agent operates on incorrect data.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #27 | Entity Resolution Agent — search and candidate evaluation | L | Critical | `search-evaluation/` |
| #28 | Entity Resolution Agent — detail extraction and validation | L | Critical | `detail-extraction/` |

## Dependency Map

```
#27 Search & Candidate Evaluation ──────────────────┐
    (search registry, LLM evaluate candidates,       │
     select best match)                               │
    │                                                 │
    ▼                                                 │
#28 Detail Extraction & Validation                    │
    (extract details, officers, shareholders,         │
     LLM validate entity)                             │
    │                                                 │
    ▼                                                 │
EntityProfile output → Ownership Agent (#45-#48)      │
                     → Screening Agent (#30-#33)      │
                     → Risk Assessment Agent (#56-#58)│

Recommended implementation order:
  1. #27 Search & Evaluation (produces the entity match)
  2. #28 Detail Extraction (depends on matched entity)
```

## External Dependencies

```
Agent Framework Core (#20):
  ├── #21 BaseAgent      ← EntityResolutionAgent extends BaseAgent
  ├── #22 Decision Fragments  ← produces entity_match, officer_identified, etc.
  └── #25 Event Store    ← emits step_started, step_completed events

Data Integration Layer (#13):
  ├── #14 Provider Interface   ← uses RegistryProvider.searchEntity, getEntityDetails, etc.
  ├── #15 Companies House      ← primary registry provider for GB jurisdiction
  └── #16 Data Caching         ← all API responses cached

LLM Abstraction Layer (#7):
  ├── #8 LLM Service     ← calls LLM for candidate evaluation and validation
  └── #10 Prompt Adaptation ← model-specific prompt formatting
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 5.4.1 — Entity Resolution Agent (7-step pipeline, output shape)
- Section 5.2 — Base Agent Interface (`AgentContext`, `AgentStep`, `AgentResult`)
- Section 5.3 — Decision Fragment Model (fragment types used by this agent)

## File Layout

```
backend/src/agents/entity-resolution/
├── index.js              # EntityResolutionAgent class
├── prompts.js            # LLM prompt templates for evaluation and validation
└── entity-profile.js     # EntityProfile output type definition
```

## Agent Steps

| # | Step | LLM Task | Data Sources | Decision Fragments |
|---|------|----------|-------------|-------------------|
| 1 | `search_registry` | — | RegistryProvider.searchEntity | — |
| 2 | `evaluate_candidates` | classification | — | `entity_match` (per candidate) |
| 3 | `select_best_match` | — | — | `entity_match` (final selection) |
| 4 | `extract_entity_details` | — | RegistryProvider.getEntityDetails | `entity_detail_extracted` |
| 5 | `extract_officers` | — | RegistryProvider.getOfficers | `officer_identified` (per officer) |
| 6 | `extract_shareholders` | — | RegistryProvider.getShareholders | `shareholder_identified` (per PSC) |
| 7 | `validate_entity` | reasoning | RegistryProvider.getEntityStatus, getFilingHistory | risk-relevant fragments |

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| LLM for candidate evaluation | classification task type | Name matching alone isn't sufficient — context matters (active vs dissolved, entity type) |
| 80% confidence threshold | Configurable default | Below 80% → flag for human input rather than risk wrong match |
| Separate search from extraction | 7 discrete steps | Granular audit trail; if extraction fails, the match is still valid |
| All data cached | data_source_cache | Audit reproducibility — prove what data was available at decision time |
| Prompt templates in separate file | prompts.js | Testable independently; swappable for different models |

## Definition of Done

- [ ] `EntityResolutionAgent` extends `BaseAgent` with all 7 steps
- [ ] Search returns ranked candidates from Companies House
- [ ] LLM evaluates candidates with confidence scores and reasoning
- [ ] Best match selected (or flagged for human review if below threshold)
- [ ] Full entity details, officers, and shareholders extracted
- [ ] LLM validation detects red flags (overdue accounts, strike-off notices, status issues)
- [ ] Complete `EntityProfile` output assembled for downstream agents
- [ ] Decision fragments produced for every step with evidence and reasoning
- [ ] All data source responses cached
- [ ] Integration test with real Companies House data (e.g., Barclays: 01026167)
