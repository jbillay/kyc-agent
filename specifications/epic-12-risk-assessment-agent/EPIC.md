# EPIC: Risk Assessment Agent

> GitHub Issue: [#56](https://github.com/jbillay/kyc-agent/issues/56)
> Milestone: Phase 2 — Intelligence
> Labels: `epic`, `agent`

## Overview

The Risk Assessment Agent synthesizes all previous agent outputs — entity resolution, ownership & UBO, screening, and document analysis — into a unified risk score and narrative. It applies a configurable rule engine for quantitative scoring, uses an LLM for qualitative analysis of factors rules cannot capture, combines both into a final risk rating (LOW / MEDIUM / HIGH / VERY_HIGH with a 0-100 numeric score), generates a professional risk narrative linked to supporting decision fragments, and routes the case to the appropriate review path (QA agent, human reviewer, or senior analyst).

The rule engine is driven by `config/risk-rules.yaml`, covering five risk categories: country risk, industry risk, ownership complexity, screening results, and document analysis. The LLM adds contextual analysis — unusual business patterns, red flags, mitigating factors — that rule-based scoring cannot express. The generated narrative is suitable for regulatory review, with every claim traceable to a decision fragment.

The frontend provides a Risk Assessment tab in the case detail view with a visual scorecard (gauge, category breakdown, individual risk factors) and the formatted narrative with clickable fragment references.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #58 | Rule engine, LLM qualitative analysis, and review path routing | L | Critical | `rule-engine-llm-analysis/` |
| #59 | Risk narrative generation | L | Critical | `narrative-generation/` |
| #60 | Risk scorecard and narrative display in frontend | L | Critical | `risk-scorecard-frontend/` |

## Dependency Map

```
#58 Rule Engine & LLM Qualitative Analysis ──────┐
    (collect risk inputs from all agents,         │
     apply rule engine from risk-rules.yaml,      │
     LLM qualitative analysis,                    │
     calculate final risk score + rating,         │
     determine review path)                       │
    │                                             │
    ▼                                             │
#59 Risk Narrative Generation                      │
    (LLM generates professional narrative,        │
     links every claim to decision fragment,      │
     stores as part of RiskAssessment output)     │
    │                                             │
    ▼                                             │
#60 Risk Scorecard Frontend                        │
    (Risk tab in case detail, gauge + score       │
     breakdown, risk factors list, formatted      │
     narrative with clickable fragment refs)      │

Recommended implementation order:
  1. #58 Rule engine + LLM analysis (establishes agent class + steps 1-4, 6)
  2. #59 Narrative generation (step 5, depends on risk score + factors)
  3. #60 Frontend (depends on API and RiskAssessment data shape)
```

## External Dependencies

```
Agent Framework (#20):
  ├── #21 BaseAgent          ← RiskAssessmentAgent extends BaseAgent
  ├── #22 Decision Fragments ← risk_factor_identified, risk_score_calculated, narrative_generated
  ├── #23 Orchestrator       ← triggers risk assessment after parallel agents complete
  └── #25 Event Store        ← step progress events

LLM Abstraction (#7):
  ├── #8 LLM Service         ← reasoning task type (qualitative analysis)
  └── #8 LLM Service         ← summarization task type (narrative generation)

Entity Resolution (#26):
  └── #27-#28 EntityProfile   ← entity details, jurisdiction, industry

Ownership & UBO Agent (#43):
  └── #44-#47 OwnershipTree   ← ownership layers, UBO list, complexity score

Screening Agent (#30):
  └── #31-#33 ScreeningResults ← sanctions hits, PEP matches, adverse media

Document Analysis Agent (#52):
  └── #53-#54 DocumentAnalysis ← document verification status, discrepancies

Infrastructure (#1):
  └── #3 Database             ← agent_results table, decision_fragments table

Case Management API (#33):
  └── #34 Cases CRUD          ← case state transitions
  └── #36 WebSocket Events    ← real-time risk assessment progress

Frontend (#38):
  └── #41 Case Detail View    ← Risk Assessment tab mounts in case detail
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 5.4.5 — Risk Assessment Agent (6-step pipeline)
- Section 6.4 — Rule Engine (`config/risk-rules.yaml` specification)
- Section 7.1 — Cases API (agent result retrieval)
- Database: `agent_results` table (stores RiskAssessment output as JSONB)

## File Layout

```
backend/src/agents/risk-assessment/
├── index.js              # RiskAssessmentAgent class
├── risk-input-collector.js  # Gathers outputs from all prior agents
├── rule-engine.js        # Configurable rule-based scoring
├── llm-risk-analyzer.js  # LLM qualitative risk analysis
├── risk-calculator.js    # Combines rule + LLM scores into final rating
├── narrative-generator.js # LLM narrative generation with fragment refs
├── review-router.js      # Determines review path from risk + confidence
└── prompts.js            # LLM prompt templates

frontend/src/components/risk-assessment/
├── RiskAssessmentTab.vue    # Risk Assessment tab container
├── RiskGauge.vue            # Circular gauge / score display (0-100)
├── RiskBreakdown.vue        # Category score breakdown chart
├── RiskFactorsList.vue      # Individual risk factors with explanations
├── RiskNarrative.vue        # Formatted narrative with fragment references
└── FragmentPopover.vue      # Popover showing full fragment details on click
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Scoring model | Additive (base 0 + additions per category) | Simple, explainable, auditable — reviewers can see exactly what added points |
| Score capping | Capped at 100, confirmed sanctions hit = immediate 100 | A sanctions match is an absolute blocker regardless of other factors |
| Rule configuration | YAML file (`config/risk-rules.yaml`) | Non-developers can adjust thresholds; version-controlled; no code changes |
| LLM task for analysis | `reasoning` task type | Qualitative analysis requires multi-step reasoning |
| LLM task for narrative | `summarization` task type | Narrative is a synthesis of existing facts, not new reasoning |
| Fragment linking | `[ref:fragment_id]` markers in narrative text | Frontend renders as clickable links; searchable; auditable |
| Narrative length | Proportional to risk level | Low risk = concise (1-2 paragraphs), high risk = detailed (4-6 paragraphs) |
| Review routing | Three paths based on risk + confidence | Automates triage; low-risk cases don't need senior attention |
| Score breakdown storage | Per-category scores in `RiskAssessment.scoreBreakdown` | Enables frontend bar chart and auditors can see which category drove risk |

## Agent Steps

| # | Step | LLM Task | Data Sources | Decision Fragments |
|---|------|----------|-------------|-------------------|
| 1 | `collect_risk_inputs` | — | agent_results (all prior agents) | — (intermediate) |
| 2 | `apply_rule_engine` | — | risk-rules.yaml, collected inputs | `risk_factor_identified` per rule match |
| 3 | `llm_risk_analysis` | reasoning | All collected inputs + rule results | `risk_factor_identified` per LLM-identified factor |
| 4 | `calculate_final_risk` | — | Rule score + LLM factors | `risk_score_calculated` |
| 5 | `generate_narrative` | summarization | All fragments + risk data | `narrative_generated` |
| 6 | `determine_review_path` | — | Final score + confidence | — (updates case routing) |

## Pipeline Position

```
Entity Resolution ──► Ownership & UBO Agent ──┐
                  │                            │
                  ├──► Screening Agent ────────┤
                  │    (parallel)              │
                  │                            ▼
                  └──► Document Analysis ──► Risk Assessment Agent ──► QA / Review
                       (parallel)            (runs after ALL prior
                                              agents complete)
```

## Definition of Done

- [ ] `RiskAssessmentAgent` extends `BaseAgent` with 6 steps
- [ ] Step `collect_risk_inputs` gathers outputs from entity resolution, ownership, screening, and document analysis agents
- [ ] Rule engine loads `config/risk-rules.yaml` and calculates additive risk score
- [ ] Rule engine covers: country risk, industry risk, ownership complexity, screening results
- [ ] Confirmed sanctions hit immediately sets score to 100
- [ ] LLM qualitative analysis identifies factors rules may miss
- [ ] Final risk rating: LOW (0-25), MEDIUM (26-50), HIGH (51-75), VERY_HIGH (76-100)
- [ ] Risk narrative generated by LLM with `[ref:fragment_id]` markers
- [ ] Narrative tone is professional and suitable for regulatory review
- [ ] Narrative length proportional to risk level
- [ ] Review routing: qa_agent (low risk + high confidence), human_reviewer (standard), senior_analyst (high risk)
- [ ] Decision fragments: `risk_factor_identified`, `risk_score_calculated`, `narrative_generated`
- [ ] Output stored as `RiskAssessment` JSONB in `agent_results`
- [ ] Frontend Risk Assessment tab with score gauge, breakdown chart, factors list
- [ ] Clickable fragment references in narrative open popover with fragment details
- [ ] Recommended due diligence level displayed (simplified, standard, enhanced)
