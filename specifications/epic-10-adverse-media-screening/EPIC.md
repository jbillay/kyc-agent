# EPIC: Adverse Media Screening

> GitHub Issue: [#49](https://github.com/jbillay/kyc-agent/issues/49)
> Milestone: Phase 2 — Intelligence
> Labels: `epic`, `agent`, `screening`

## Overview

The Adverse Media Screening feature extends the existing Screening Agent (Phase 1 — sanctions only) with news search and LLM-based relevance analysis. For each person and entity on the screening list, the system searches news APIs for adverse coverage, then uses an LLM to determine whether each article is genuinely relevant, about the correct person/entity, and truly adverse. This is step 5 (`run_adverse_media_screening`) in the Screening Agent's 6-step pipeline, previously deferred from Phase 1.

Adverse media hits feed directly into the Risk Assessment Agent via the `ScreeningReport`. The risk rules in `config/risk-rules.yaml` already define scoring weights by severity: high (+15), medium (+8), low (+3).

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #50 | News search integration for adverse media screening | M | High | `news-search-integration/` |
| #51 | LLM-based adverse media relevance analysis | L | High | `adverse-media-analysis/` |

## Dependency Map

```
#50 News Search Integration ────────────────────────┐
    (news API provider, query construction,          │
     result normalization, caching)                  │
    │                                                │
    ▼                                                │
#51 LLM-Based Adverse Media Analysis                 │
    (LLM evaluates relevance, categorizes,           │
     produces decision fragments, extends             │
     ScreeningReport with adverse media section)     │

Recommended implementation order:
  1. #50 News search integration (data provider — must exist first)
  2. #51 LLM adverse media analysis (depends on #50 for article data)
```

## External Dependencies

```
Screening Agent — Phase 1 (#30):
  ├── #31 Compile Screening List ← reuses the same screening subjects
  ├── #33 Hit Evaluation         ← follows the same LLM evaluation pattern
  └── ScreeningReport            ← extended with adverse media section

Agent Framework (#20):
  ├── #21 BaseAgent              ← ScreeningAgent already extends BaseAgent
  ├── #22 Decision Fragments     ← produces adverse_media_clear, adverse_media_hit
  └── #25 Event Store            ← step progress events

Data Integration (#13):
  └── #16 Data Caching           ← news search results cached in data_source_cache

LLM Abstraction (#7):
  └── #8 LLM Service             ← relevance analysis (screening task type)

Risk Assessment (downstream):
  └── screening_risk.adverse_media_per_hit ← scoring weights already defined in risk-rules.yaml
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 5.4.3 — Screening Agent, step 5 (`run_adverse_media_screening`)
- Section 4.2.2 — Screening Providers (`listType: 'adverse_media'`)
- Section 4.2.3 — Data Caching (news results cached with query hash + TTL)
- Risk rules: `screening_risk.adverse_media_per_hit` in `config/risk-rules.yaml`
- Frontend: `AdverseMediaCard.vue` component (in planned file layout)

## File Layout

```
backend/src/data-sources/media/
├── types.js              # NewsSearchProvider interface, NewsArticle type
└── news-search.js        # News search provider implementation

backend/src/agents/screening/
├── index.js              # Extended with step 5: run_adverse_media_screening
├── prompts.js            # Extended with adverse media evaluation prompt
├── screening-report.js   # Extended with adverse media section in ScreeningReport
└── adverse-media.js      # Adverse media search orchestration and LLM analysis

config/data-sources.yaml  # Extended with news search provider configuration
```

## Agent Steps (Updated Pipeline)

The Screening Agent pipeline is extended from 4 steps (Phase 1) to 5 steps:

| # | Step | LLM Task | Data Sources | Decision Fragments | Phase |
|---|------|----------|-------------|-------------------|-------|
| 1 | `compile_screening_list` | — | EntityProfile | — | Phase 1 |
| 2 | `run_sanctions_screening` | — | OFAC, UK HMT | `sanctions_clear` | Phase 1 |
| 3 | `evaluate_sanctions_hits` | screening | — | `sanctions_hit`, `sanctions_dismissed` | Phase 1 |
| 4 | `run_adverse_media_screening` | screening | News Search API | `adverse_media_clear`, `adverse_media_hit` | **Phase 2** |
| 5 | `compile_screening_report` | — | — | — | Phase 1 (extended) |

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| News API via configurable provider | Google Custom Search JSON API (default) | 100 free queries/day; Bing News API as alternative; swappable provider interface |
| LLM for relevance analysis | screening task type | Keyword-based news search returns many irrelevant results; LLM can assess relevance, disambiguate names, and categorize severity |
| Per-subject adverse media fragments | One `adverse_media_hit` per relevant article | Granular audit trail — reviewer sees exactly which articles were flagged |
| Severity categorization | high / medium / low | Maps directly to risk scoring weights in `risk-rules.yaml` |
| Article snippets, not full text | Search API returns titles + snippets | Full article scraping raises legal/IP concerns; snippets are sufficient for LLM relevance assessment |
| Conservative approach | When in doubt, flag as relevant | Same principle as sanctions screening — missing adverse media is worse than false positive |
| Configurable date range | Default: last 3 years | Balances thoroughness with relevance; configurable per client |
| Risk-relevant keyword augmentation | Search queries combine name + risk keywords | "John Smith" alone returns noise; "John Smith fraud money laundering" targets relevant results |
| Result deduplication | By URL and title similarity | Same article from different search queries should only be evaluated once |
| Caching in data_source_cache | Standard query hash + TTL pattern | Audit reproducibility — proves what news was available at decision time |

## Pipeline Position

```
Entity Resolution ──► Screening Agent ──────────────────► Risk Assessment
                  │   (steps 1-5, now including          ▲
                  │    adverse media at step 4)           │
                  └──► Ownership Agent ──────────────────┘
                       (parallel)
```

## Definition of Done

- [ ] News search provider implemented with configurable API backend
- [ ] Search queries constructed from subject name + risk-relevant keywords
- [ ] Results normalized to common `NewsArticle` format (title, source, date, snippet, URL)
- [ ] Configurable date range filter (default: last 3 years)
- [ ] Result deduplication across queries for same subject
- [ ] News results cached in `data_source_cache` with query hash + TTL
- [ ] LLM evaluates each news result: relevance, same-person check, adverse nature, category, severity
- [ ] Categories: financial crime, fraud, corruption, tax evasion, regulatory action, litigation, terrorism, organized crime, other
- [ ] Severity: high, medium, low
- [ ] `adverse_media_clear` fragment for subjects with no relevant adverse media
- [ ] `adverse_media_hit` fragment for each relevant article with category, severity, summary, and reasoning
- [ ] `ScreeningReport` extended with adverse media section (per-subject, with aggregated counts)
- [ ] Risk scoring integration: adverse media hits feed into `screening_risk.adverse_media_per_hit` weights
- [ ] Full adverse media screening of typical case (10-15 subjects) completes within 90 seconds
- [ ] Graceful handling of API rate limits, errors, and unavailability
- [ ] Integration test with known adverse media subjects
