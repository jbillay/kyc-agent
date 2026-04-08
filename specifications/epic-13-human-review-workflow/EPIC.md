# EPIC: Human Review Workflow

> GitHub Issue: [#61](https://github.com/jbillay/kyc-agent/issues/61)
> Milestone: Phase 3 — Review & Polish
> Labels: `epic`, `review-workflow`

## Overview

Complete review workflow allowing humans to approve, reject, escalate, and override agent decisions. This epic bridges the gap between autonomous agent processing and regulated human oversight — the critical "human-in-the-loop" that regulators require.

After the agent pipeline completes (entity resolution → ownership/screening → risk assessment), cases enter the review workflow. Low-risk, high-confidence cases pass through an automated QA Agent first, reducing reviewer workload. All cases ultimately reach a human reviewer who can inspect every decision fragment, override agent conclusions with documented reasons, and render a final case decision (approve, reject, escalate, or request additional information).

The review workflow produces a complete audit trail: every fragment review, override, and final decision is logged as an immutable event in the `decision_events` table.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #63 | QA Agent for automated low-risk case review | L | High | `qa-agent/` |
| #64 | Review queue interface in frontend | L | Critical | `review-queue/` |
| #65 | Fragment-level review and override in frontend | L | Critical | `fragment-review/` |
| #66 | Review decision workflow (approve/reject/escalate) | M | Critical | `review-decision/` |
| — | Review API endpoints (backend) | L | Critical | `review-api/` |

> **Note**: The Review API endpoints story does not yet have a dedicated GitHub issue. It provides the backend foundation (`/api/v1/review/*`) that all frontend stories depend on. Consider creating a tracking issue for it.

## Dependency Map

```
Review API Endpoints (backend) ─────────────────────────┐
    (review queue, approve/reject/escalate,              │
     fragment override, request-info endpoints)           │
    │                                                    │
    ├──► #63 QA Agent ───────────────────────────────────┤
    │    (automated QA for low-risk cases,               │
    │     completeness/consistency/compliance checks,     │
    │     pass → streamlined review, fail → full review) │
    │                                                    │
    ├──► #64 Review Queue Interface ─────────────────────┤
    │    (review page, case list, filters,               │
    │     workload stats, priority sorting)               │
    │    │                                               │
    │    ▼                                               │
    ├──► #65 Fragment-Level Review ──────────────────────┤
    │    (per-fragment approve/reject/modify,             │
    │     review progress, batch approve)                 │
    │    │                                               │
    │    ▼                                               │
    └──► #66 Review Decision Workflow ───────────────────┘
         (final decision panel: approve/reject/
          escalate/request info, confirmation dialogs,
          audit trail logging)

Recommended implementation order:
  1. Review API endpoints (backend foundation for all stories)
  2. #63 QA Agent (can be built in parallel with frontend)
  3. #64 Review queue interface (entry point for reviewers)
  4. #65 Fragment-level review (core review interaction)
  5. #66 Review decision workflow (final step, depends on #65 for context)
```

## External Dependencies

```
Agent Framework (#20):
  ├── #21 BaseAgent          ← QA Agent extends BaseAgent
  ├── #22 Decision Fragments ← fragment review status lifecycle
  ├── #23 Orchestrator       ← state transitions (QA_OR_REVIEW → PENDING_HUMAN_REVIEW → terminal)
  └── #25 Event Store        ← review_action events, audit trail

Risk Assessment Agent (#56):
  └── #58 Rule Engine        ← review routing (qa_agent / human_reviewer / senior_analyst)
  └── #59 Narrative          ← risk narrative displayed in review context

LLM Abstraction (#7):
  └── #8 LLM Service         ← reasoning task type (QA consistency check)

Case Management API (#33):
  └── #34 Cases CRUD          ← case state, assigned reviewer
  └── #35 Fragments API       ← fragment data for review UI
  └── #36 WebSocket Events    ← real-time review assignment notifications

Infrastructure (#1):
  └── #3 Database             ← cases, decision_fragments, decision_events tables

Frontend (#38):
  └── #41 Case Detail View    ← review mode overlays on case detail
  └── #42 Agent Progress      ← QA agent progress indicator

Authentication (#67):
  └── #69 Auth Service        ← reviewer identity, RBAC (analyst, senior_analyst)
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 5.4.6 — QA Agent (4-step pipeline: completeness, consistency, compliance, summary)
- Section 5.5 — Orchestrator state machine (QA_OR_REVIEW → PENDING_HUMAN_REVIEW → terminal states)
- Section 6.1 — Case Management (assignedReviewer, reviewDecision, reviewComment fields)
- Section 6.4 — Rule Engine (`review_routing` config in risk-rules.yaml)
- Section 6.5 — Auth & RBAC (analyst, senior_analyst, compliance_officer roles)
- Section 7.2 — Review API endpoints (queue, approve, reject, escalate, request-info, fragment override)
- Section 7.3 — WebSocket events (case:review_assigned)

## File Layout

```
backend/src/agents/qa/
├── index.js                 # QAAgent class (extends BaseAgent)
├── completeness-checker.js  # Verify all required data present
├── consistency-checker.js   # Cross-validate agent outputs
├── compliance-checker.js    # Verify regulatory requirements met
├── qa-summary-generator.js  # Generate QA findings summary
└── prompts.js               # LLM prompt templates

backend/src/api/review/
├── schemas.js               # Fastify JSON Schema definitions
├── handlers.js              # Review API route handlers
└── routes.js                # Route registration under /api/v1/review

backend/src/services/
└── review-service.js        # Review business logic (assignment, decisions, fragment override)

frontend/src/views/
└── ReviewQueue.vue           # /review page — case list with filters

frontend/src/components/review/
├── ReviewCaseList.vue        # Case list with priority sorting
├── ReviewFilters.vue         # Filter controls (risk, QA status, age)
├── WorkloadStats.vue         # Batch count, workload statistics
├── FragmentReviewPanel.vue   # Per-fragment review actions
├── FragmentReviewProgress.vue # "15 of 23 fragments reviewed"
├── BatchApproveDialog.vue    # Batch approve confirmation
├── ReviewDecisionPanel.vue   # Final decision (approve/reject/escalate/info)
├── RejectReasonDialog.vue    # Reject reason selection + free text
├── EscalateDialog.vue        # Escalation notes dialog
├── RequestInfoDialog.vue     # Specify missing information
└── StreamlinedReview.vue     # Simplified view for QA-passed cases
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| QA Agent as gatekeeper | Auto-QA for low-risk + high-confidence only | Reduces human workload on straightforward cases while maintaining oversight |
| QA trigger threshold | Risk score <= 25 AND confidence >= 85 | Conservative thresholds ensure only genuinely low-risk cases skip full review |
| QA failure path | Routes to standard human review with issues highlighted | QA never auto-approves; it only pre-validates for streamlined human review |
| Fragment-level review | Per-fragment approve/reject/modify (like code review) | Granular control lets reviewers correct specific errors without re-running entire case |
| Original preservation | Modified fragments keep original + human override | Audit trail shows what the agent decided AND what the human changed |
| Predefined reject reasons | Dropdown list + free text | Standardized reasons enable analytics; free text captures nuance |
| Review routing | Three-tier: QA → analyst → senior analyst | Risk-proportionate review ensures high-risk cases get senior attention |
| Streamlined review for QA-passed | Simplified UI (just confirm/reject) | QA-passed cases need less scrutiny; faster throughput for low-risk volume |

## Case State Transitions (Review Phase)

```
RISK_ASSESSMENT
  │
  ▼
QA_OR_REVIEW ──────────────── QA Agent evaluates (if eligible)
  │
  ├── QA passes ──► PENDING_HUMAN_REVIEW (streamlined)
  ├── QA fails ───► PENDING_HUMAN_REVIEW (full review, issues highlighted)
  └── Not eligible ► PENDING_HUMAN_REVIEW (full review)
        │
        ├──► APPROVED                  (reviewer approves)
        ├──► REJECTED                  (reviewer rejects with reason)
        ├──► ESCALATED                 (reviewer escalates to senior)
        └──► ADDITIONAL_INFO_REQUIRED  (reviewer requests more data)
```

## Definition of Done

- [ ] Review API endpoints: queue, approve, reject, escalate, request-info, fragment override
- [ ] All Review API endpoints validated with Fastify JSON Schema
- [ ] QA Agent extends BaseAgent with 4 steps: completeness, consistency, compliance, summary
- [ ] QA Agent only triggers for cases with risk score <= 25 AND confidence >= 85
- [ ] QA pass → streamlined review; QA fail → full review with issues highlighted
- [ ] Review queue page at `/review` with case list, risk sorting, filters
- [ ] Fragment-level review: approve, reject (with reason), modify (with alternative)
- [ ] Modified fragments tracked as `human_modified` with original preserved
- [ ] Review progress indicator ("15 of 23 fragments reviewed")
- [ ] Batch approve option for bulk fragment approval
- [ ] Final decision panel: Approve, Reject (with reason), Escalate (with notes), Request Info
- [ ] All review decisions logged in audit trail (decision_events)
- [ ] Case state transitions: PENDING_HUMAN_REVIEW → APPROVED/REJECTED/ESCALATED/ADDITIONAL_INFO_REQUIRED
- [ ] WebSocket notifications for review assignment and decision events
- [ ] RBAC enforced: analysts review assigned cases, senior analysts review any case
