# EPIC: Basic Frontend — Phase 1

> GitHub Issue: [#38](https://github.com/jbillay/kyc-agent/issues/38)
> Milestone: Phase 1 — Foundation
> Labels: `epic`, `frontend`

## Overview

The Basic Frontend delivers the minimal Vue.js 3 SPA that analysts need to interact with the KYC Agent platform. It covers the core workflow: viewing a kanban-style dashboard of cases, creating new cases, inspecting entity profiles resolved by the Entity Resolution Agent, monitoring agent progress in real-time, and reviewing sanctions screening results. All views update live via WebSocket as agents complete their work.

Phase 1 focuses on read-heavy views for the data produced by the Entity Resolution and Screening agents. Ownership tree visualization, document analysis, risk assessment display, and the full review workflow are deferred to Phase 2.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #39 | Dashboard view with case list and kanban board | L | Critical | `dashboard-kanban/` |
| #40 | New case creation dialog | M | Critical | `new-case-dialog/` |
| #41 | Case detail view with entity profile tab | L | Critical | `case-detail-entity-profile/` |
| #42 | Agent progress indicator component | M | High | `agent-progress/` |
| #43 | Basic screening results display | M | High | `screening-results/` |

## Dependency Map

```
#39 Dashboard + Kanban ──────────────────────────────────┐
    (case list, filters, WebSocket updates)               │
    │                                                     │
    ├── #40 New Case Dialog                               │
    │   (form, POST /api/v1/cases, dashboard refresh)     │
    │                                                     │
    └── Click card ──► #41 Case Detail + Entity Profile   │
                        (tabbed view, entity data tables)  │
                        │                                  │
                        ├── #42 Agent Progress Indicator   │
                        │   (pipeline status, WebSocket)   │
                        │                                  │
                        └── #43 Screening Results Display  │
                            (per-subject hits, reasoning)  │

Recommended implementation order:
  1. #39 Dashboard + Kanban (establishes routing, stores, WebSocket)
  2. #40 New Case Dialog (builds on dashboard)
  3. #41 Case Detail + Entity Profile (case data display)
  4. #42 Agent Progress Indicator (reusable component for case detail)
  5. #43 Screening Results Display (screening tab in case detail)
```

## External Dependencies

```
Infrastructure (#1):
  ├── #4 Fastify Backend     ← API endpoints consumed by frontend
  └── #5 Frontend Scaffold   ← Vue.js 3 project skeleton, Vite, router

API Layer (backend):
  ├── POST /api/v1/cases       ← case creation
  ├── GET  /api/v1/cases       ← case list with filters
  ├── GET  /api/v1/cases/:id   ← case detail
  ├── GET  /api/v1/cases/:id/fragments  ← decision fragments
  └── GET  /api/v1/cases/:id/timeline   ← event timeline

WebSocket Events (Socket.io):
  ├── case:state_changed         ← kanban card movement
  ├── case:agent_started         ← agent progress
  ├── case:agent_step_completed  ← step-level progress
  ├── case:agent_completed       ← agent done + confidence
  └── case:fragment_added        ← new decision fragment data

Agent Framework (#20):
  └── #22 Decision Fragments  ← fragment types and statuses displayed in UI

Entity Resolution (#26):
  └── #27-#28 EntityProfile   ← data shown in entity profile tab

Screening Agent (#30):
  └── #31-#33 ScreeningReport ← data shown in screening results tab
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 8 — Layer 6: Frontend (Vue.js 3)
- Section 8.2.1 — Dashboard View (kanban board layout)
- Section 8.2.2 — Case Detail View (tabbed layout, entity profile, screening)
- Section 7.3 — WebSocket Events (server → client event contracts)
- Section 11 — Frontend project structure

## Technology Stack

| Technology | Purpose |
|-----------|---------|
| Vue 3 (Composition API) | Core framework |
| Pinia | State management (cases store, WebSocket store) |
| Vue Router | Client-side routing (`/dashboard`, `/cases/:id`) |
| PrimeVue or Naive UI | Component library (DataTable, Dialog, Tabs, Accordion) |
| Socket.io Client | Real-time WebSocket updates |
| Vite | Build tool + HMR |

## File Layout

```
frontend/src/
├── router/
│   └── index.js              # Route definitions
├── stores/
│   ├── cases.js              # Cases Pinia store (list, detail, CRUD)
│   └── websocket.js          # WebSocket connection + event handlers
├── views/
│   ├── DashboardView.vue     # Kanban board page
│   └── CaseDetailView.vue    # Tabbed case detail page
├── components/
│   ├── cases/
│   │   ├── CaseCard.vue      # Kanban card component
│   │   ├── CaseKanban.vue    # Kanban board with columns
│   │   ├── CaseFilters.vue   # Filter bar (state, risk, date, search)
│   │   └── NewCaseDialog.vue # Case creation modal
│   ├── entity/
│   │   ├── EntityProfile.vue # Company details, officers, shareholders
│   │   └── OfficersTable.vue # Officers/shareholders data table
│   ├── screening/
│   │   ├── ScreeningResults.vue  # Per-subject screening panels
│   │   └── ScreeningHitCard.vue  # Individual hit detail card
│   └── common/
│       ├── AgentProgress.vue     # Pipeline progress indicator
│       └── DecisionFragmentBadge.vue  # Confidence/status badge
├── composables/
│   ├── useCase.js            # Case data fetching + reactivity
│   └── useWebSocket.js       # WebSocket connection composable
└── types/
    └── index.js              # JSDoc typedefs for frontend models
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Composition API + `<script setup>` | Standard for all components | Cleaner than Options API for reactive state and composables |
| Pinia over Vuex | Pinia stores for cases + websocket | Type-safe, modular, Vue 3 recommended |
| Socket.io for real-time | WebSocket via Socket.io client | Matches backend Socket.io server; auto-reconnect, fallback |
| PrimeVue/Naive UI components | DataTable, Dialog, Tabs, Accordion | Production-ready data display; no custom table implementation |
| Route-level code splitting | Lazy-loaded views via `() => import()` | Fast initial load; dashboard and case detail are separate chunks |
| Optimistic UI for case creation | Card appears immediately, confirmed by WebSocket | Responsive feel; WebSocket event confirms server-side creation |

## Definition of Done

- [ ] Dashboard view with kanban board showing cases by state
- [ ] Case cards with entity name, jurisdiction, risk badge, time elapsed
- [ ] Real-time card movement via WebSocket events
- [ ] Filter bar: state, risk rating, date range, name search
- [ ] New case creation dialog with form validation
- [ ] Case detail view at `/cases/:id` with tabbed layout
- [ ] Entity Profile tab showing company details, officers, shareholders
- [ ] Agent progress indicator showing pipeline stages with real-time updates
- [ ] Screening tab with per-subject results and hit details
- [ ] WebSocket integration for all live-updating components
- [ ] Responsive layout for common screen sizes
