# EPIC: Audit Trail & Reporting

> GitHub Issue: [#71](https://github.com/jbillay/kyc-agent/issues/71)
> Milestone: Phase 3 — Review & Polish
> Labels: `epic`, `audit`

## Overview

Complete audit trail UI and export capabilities for regulatory compliance. This epic delivers the transparency and evidence layer that compliance officers need to demonstrate due diligence to regulators.

The KYC Agent platform already captures all agent activity as immutable events in the `decision_events` table (append-only, enforced by PostgreSQL rules). This epic surfaces that data through three capabilities: a chronological timeline view within each case, a regulatory-grade export system (PDF and JSON), and a dashboard analytics layer for operational KPIs.

These features are essential for regulated financial institutions where every KYC decision must be traceable, reproducible, and exportable for auditors and regulators on demand.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #72 | Audit trail view in frontend | M | High | `audit-trail-view/` |
| #73 | Case audit export (PDF/JSON) | L | High | `case-audit-export/` |
| #74 | Dashboard analytics and KPIs | M | Medium | `dashboard-analytics/` |

## Dependency Map

```
#72 Audit Trail View (frontend) ────────────────────┐
    (timeline component, event filters,              │
     expandable detail panels)                       │
    │                                                │
    └──► #73 Case Audit Export ─────────────────────┤
         (JSON aggregation, PDF generation,          │
          async export for large cases)              │
                                                     │
#74 Dashboard Analytics ────────────────────────────┘
    (KPI metrics, charts, time period selectors)
    (independent — can be built in parallel)

Recommended implementation order:
  1. #72 Audit trail view (frontend timeline + backend timeline endpoint)
  2. #73 Case audit export (builds on timeline data, adds PDF generation)
  3. #74 Dashboard analytics (independent, can overlap with #73)
```

## External Dependencies

```
Infrastructure (#1):
  └── #3 Database             ← decision_events, cases, agent_results, decision_fragments tables

Agent Framework (#20):
  └── #25 Event Store         ← append-only decision_events table (data source for audit trail)

Case Management API (#33):
  └── #34 Cases CRUD          ← case data for export
  └── #35 Decision Fragments  ← fragment data for export
  └── #36 WebSocket Events    ← real-time event updates in timeline

Basic Frontend (#38):
  └── #41 Case Detail View    ← Audit Trail tab lives within case detail

Authentication (#67):
  └── Auth Service            ← audit:read permission required
  └── #70 RBAC Middleware      ← endpoint protection (compliance_officer+ for export)

Human Review (#61):
  └── Review API              ← review history included in audit export
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 6.2 — Decision Fragment Store (Event Store): append-only `decision_events` schema
- Section 7.2 — Admin / Audit API: `GET /api/v1/audit/events`, `GET /api/v1/audit/cases/:id/export`
- Section 8.2.1 — Dashboard View: case analytics and KPIs
- Section 8.2.2 — Case Detail View: Audit Trail Tab description
- Section 9.1 — Database Schema: `decision_events`, `cases`, `agent_results`, `decision_fragments`

## File Layout

```
backend/src/api/
└── audit.js                     # Audit API routes (/api/v1/audit/*)

backend/src/services/
├── audit-service.js             # Audit query, aggregation, export orchestration
└── pdf-export-service.js        # PDF report generation (pdfkit)

frontend/src/components/case/
├── AuditTrailTab.vue            # Audit trail timeline component
├── AuditEventCard.vue           # Individual event card with expandable detail
└── AuditFilters.vue             # Filter bar (agent type, event type, date, confidence)

frontend/src/components/dashboard/
├── AnalyticsPanel.vue           # Analytics section on dashboard
├── CasesByRiskChart.vue         # Pie chart: cases by risk rating
├── CasesByStateChart.vue        # Bar chart: cases by state
└── KpiCards.vue                 # KPI metric cards with trend indicators

frontend/src/views/
└── DashboardView.vue            # Updated with analytics section
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Timeline data source | `decision_events` table | Already append-only and immutable; single source of truth for audit |
| PDF generation | `pdfkit` (server-side) | No browser dependency, deterministic output, suitable for regulatory submission |
| Large export handling | BullMQ async job | PDF generation for complex cases can take 10-30s; avoid HTTP timeout |
| Chart library | Chart.js (via PrimeVue Charts or standalone) | Lightweight, well-documented, sufficient for KPI dashboards |
| Timeline rendering | Virtual scrolling | Cases can have 100+ events; DOM performance requires virtualization |
| Export auth | `compliance_officer` role minimum | Exports contain sensitive KYC data; restrict to authorized roles |
| Analytics data | Aggregated from `cases` + `decision_events` | No separate analytics table needed for MVP; acceptable query cost at expected scale |

## Definition of Done

- [ ] Audit Trail tab visible in case detail view with chronological event timeline
- [ ] Events show timestamp, type icon, agent/user, summary description
- [ ] Events expandable to show full payload (fragments, LLM calls, data queries)
- [ ] Timeline filterable by agent type, event type, date range, confidence level
- [ ] Search within events functional
- [ ] Virtual scrolling handles 100+ events smoothly
- [ ] `GET /api/v1/audit/events` returns filtered audit events
- [ ] `GET /api/v1/audit/cases/:id/export?format=json` returns complete case audit data
- [ ] `GET /api/v1/audit/cases/:id/export?format=pdf` returns professionally formatted PDF
- [ ] PDF includes: cover page, executive summary, entity profile, ownership structure, screening results, risk assessment, complete audit trail, reviewer decisions
- [ ] Export metadata includes: export date, exported by, platform version
- [ ] Large exports handled asynchronously (job ID returned, download when ready)
- [ ] Dashboard shows KPI metrics: total cases, avg processing time, cases by risk/state
- [ ] Time period selector: today, this week, this month, custom range
- [ ] Trend indicators show change vs previous period
- [ ] All audit endpoints protected by RBAC (compliance_officer+ for export)
