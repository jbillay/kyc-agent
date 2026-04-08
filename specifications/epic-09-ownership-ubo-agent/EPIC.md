# EPIC: Ownership & UBO Mapping Agent

> GitHub Issue: [#43](https://github.com/jbillay/kyc-agent/issues/43)
> Milestone: Phase 2 — Intelligence
> Labels: `epic`, `agent`

## Overview

The Ownership & UBO Mapping Agent traces ownership chains from the direct shareholders identified by the Entity Resolution Agent through to ultimate beneficial owners (UBOs). It recursively queries corporate registries to uncover who owns the owning entities, calculates indirect ownership percentages through the chain, and identifies individuals exceeding the UBO threshold (25% for UK/US). An LLM evaluates the overall structure for complexity indicators — layering, cross-border elements, nominees, trusts — that feed into risk scoring. The final output is a structured `OwnershipMap` with tree data for frontend visualization.

The agent runs in parallel with the Screening Agent after Entity Resolution completes (`PARALLEL_1` state). Its output feeds into the Risk Assessment Agent alongside screening results.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #44 | Direct ownership analysis | M | Critical | `direct-ownership/` |
| #45 | Recursive corporate ownership tracing | XL | Critical | `recursive-tracing/` |
| #46 | Indirect ownership calculation and UBO identification | L | Critical | `ubo-identification/` |
| #47 | Structure complexity assessment and ownership tree generation | M | High | `complexity-assessment/` |
| #48 | Ownership tree visualization (frontend) | L | Critical | `ownership-tree-viz/` |

## Dependency Map

```
#44 Direct Ownership Analysis ───────────────────────┐
    (classify shareholders, record percentages,       │
     identify corporate entities needing tracing)     │
    │                                                 │
    ▼                                                 │
#45 Recursive Corporate Ownership Tracing             │
    (query registries per corporate shareholder,      │
     depth limit, circular detection, dead ends)      │
    │                                                 │
    ▼                                                 │
#46 Indirect Ownership Calculation + UBO ID           │
    (multiply percentages through chains,             │
     flag UBOs ≥ 25%, handle no-UBO case)             │
    │                                                 │
    ▼                                                 │
#47 Complexity Assessment + Tree Generation           │
    (LLM evaluates structure, produce tree JSON)      │
    │                                                 │
    ▼                                                 │
#48 Ownership Tree Visualization (Frontend)           │
    (Vue Flow interactive tree, node colors, UBO      │
     badges, dead-end indicators)                     │

Recommended implementation order:
  1. #44 Direct ownership (establishes agent class + first step)
  2. #45 Recursive tracing (core algorithm, most complex)
  3. #46 Indirect calc + UBO ID (depends on complete chain data)
  4. #47 Complexity + tree generation (depends on full ownership map)
  5. #48 Frontend visualization (depends on tree data shape)
```

## External Dependencies

```
Agent Framework (#20):
  ├── #21 BaseAgent          ← OwnershipUBOAgent extends BaseAgent
  ├── #22 Decision Fragments ← shareholder_identified, ubo_identified, ubo_chain_traced, ubo_dead_end
  └── #25 Event Store        ← step progress events

Data Integration (#13):
  ├── #14 Provider Interface  ← RegistryProvider.getShareholders()
  ├── #15 Companies House     ← UK corporate registry lookups
  └── #16 Data Caching        ← all registry queries cached

Entity Resolution (#26):
  └── #27-#28 EntityProfile   ← shareholders list as input

LLM Abstraction (#7):
  └── #8 LLM Service          ← complexity assessment (reasoning task type)

Orchestrator (#23):
  └── PARALLEL_1 stage        ← runs alongside screening after entity resolution

Frontend (#38):
  └── #41 Case Detail View    ← Ownership tab mounts tree visualization
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 5.4.2 — Ownership & UBO Mapping Agent (6-step pipeline)
- Section 4.2.1 — Registry Provider Interface (getShareholders for recursive lookups)
- Section 5.5 — Orchestrator (PARALLEL_1 stage: ownership + screening)
- Risk rules: `ownership_risk` section in `config/risk-rules.yaml`

## File Layout

```
backend/src/agents/ownership-ubo/
├── index.js              # OwnershipUBOAgent class
├── direct-ownership.js   # Direct shareholder classification
├── recursive-tracer.js   # Recursive corporate ownership tracing
├── ubo-calculator.js     # Indirect ownership calculation + UBO identification
├── complexity.js         # Structure complexity assessment
├── ownership-tree.js     # Tree data generation for visualization
└── prompts.js            # LLM prompt templates for complexity assessment

frontend/src/components/ownership/
├── OwnershipTree.vue     # Vue Flow tree container
└── OwnershipNode.vue     # Custom node component
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Depth-limited recursion | Max 10 levels (configurable) | Prevents infinite loops; most legitimate structures < 5 levels |
| Circular ownership detection | Set of visited entity IDs | Entity A → B → A detected and stopped with `ubo_dead_end` |
| Percentage ranges as midpoints | "25-50%" → 37.5% for calculation | Companies House PSC data uses ranges; midpoint is reasonable default |
| Dead ends explicitly tracked | `ubo_dead_end` fragments with reason | Foreign jurisdictions, dissolved entities, no data — all traceable in audit |
| LLM for complexity only | Not for tracing or calculation | Ownership math is deterministic; LLM adds value in subjective risk assessment |
| Vue Flow for visualization | `@vue-flow/core` with dagre layout | Interactive, handles complex trees, good Vue 3 integration |

## Agent Steps

| # | Step | LLM Task | Data Sources | Decision Fragments |
|---|------|----------|-------------|-------------------|
| 1 | `analyze_direct_ownership` | — | EntityProfile (from context) | `shareholder_identified` per shareholder |
| 2 | `trace_corporate_shareholders` | — | RegistryProvider (Companies House) | `ubo_chain_traced`, `ubo_dead_end` |
| 3 | `calculate_indirect_ownership` | — | — (computation only) | — (intermediate) |
| 4 | `identify_ubos` | — | — (threshold check) | `ubo_identified` or EDD recommendation |
| 5 | `assess_structure_complexity` | reasoning | — | Complexity risk fragments |
| 6 | `generate_ownership_tree` | — | — (data assembly) | — (produces tree output) |

## Pipeline Position

```
Entity Resolution ──► Ownership & UBO Agent ──► Risk Assessment
                  │                              ▲
                  └──► Screening Agent ───────────┘
                       (parallel)
```

## Definition of Done

- [ ] `OwnershipUBOAgent` extends `BaseAgent` with 6 steps
- [ ] Direct shareholders classified with ownership percentages and entity types
- [ ] Corporate shareholders traced recursively through registries
- [ ] Circular ownership detected and flagged
- [ ] Dead ends tracked with reasons (foreign jurisdiction, no data, dissolved)
- [ ] Indirect ownership percentages calculated through chains
- [ ] UBOs identified (≥ 25% threshold, configurable)
- [ ] No-UBO case handled with EDD recommendation
- [ ] LLM assesses structural complexity (layers, cross-border, nominees, trusts)
- [ ] Structured ownership tree produced for frontend visualization
- [ ] Vue Flow interactive tree with color-coded nodes and UBO badges
- [ ] Full ownership tracing of typical case completes within 60 seconds
