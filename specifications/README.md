# Specifications

Technical specifications for the KYC Agent platform, organized by epic.

## Taxonomy

```
specifications/
├── README.md                              # This file
├── epic-01-infrastructure-devops/         # EPIC: Infrastructure & DevOps Setup (#1)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── docker-compose/
│   │   └── SPEC.md                        # Docker Compose stack (#2)
│   ├── database/
│   │   └── SPEC.md                        # PostgreSQL schema & migrations (#3)
│   ├── backend-scaffold/
│   │   └── SPEC.md                        # Fastify backend scaffold (#4)
│   ├── frontend-scaffold/
│   │   └── SPEC.md                        # Vue.js 3 frontend scaffold (#5)
│   └── minio-storage/
│       └── SPEC.md                        # MinIO document storage (#6)
├── epic-02-llm-abstraction/               # EPIC: LLM Abstraction Layer (#7)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── provider-interface/
│   │   └── SPEC.md                        # LLM provider interface & routing service (#8)
│   ├── ollama-provider/
│   │   └── SPEC.md                        # Ollama provider implementation (#9)
│   ├── prompt-adaptation/
│   │   └── SPEC.md                        # Prompt adaptation system (#10)
│   ├── call-logging/
│   │   └── SPEC.md                        # LLM call logging for audit trail (#11)
│   └── yaml-config-loader/
│       └── SPEC.md                        # YAML configuration loader (#12)
├── epic-03-data-integration/              # EPIC: Data Integration Layer (#13)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── provider-interface/
│   │   └── SPEC.md                        # Data source provider interface & registry abstraction (#14)
│   ├── companies-house/
│   │   └── SPEC.md                        # Companies House API integration (#15)
│   ├── data-caching/
│   │   └── SPEC.md                        # Data source response caching & versioning (#16)
│   ├── ofac-sdn/
│   │   └── SPEC.md                        # OFAC SDN sanctions list ingestion & search (#17)
│   ├── uk-hmt/
│   │   └── SPEC.md                        # UK HMT sanctions list ingestion & search (#18)
│   └── fuzzy-matching/
│       └── SPEC.md                        # Fuzzy name matching engine (#19)
├── epic-04-agent-framework/               # EPIC: Agent Framework Core (#20)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── base-agent/
│   │   └── SPEC.md                        # Base agent class with step execution lifecycle (#21)
│   ├── decision-fragments/
│   │   └── SPEC.md                        # Decision fragment store and model (#22)
│   ├── orchestrator/
│   │   └── SPEC.md                        # Case orchestrator with state machine (#23)
│   ├── agent-worker/
│   │   └── SPEC.md                        # BullMQ agent worker for job processing (#24)
│   └── event-store/
│       └── SPEC.md                        # Event store service for immutable audit logging (#25)
├── epic-05-entity-resolution/             # EPIC: Entity Resolution Agent (#26)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── search-evaluation/
│   │   └── SPEC.md                        # Search and candidate evaluation (#27)
│   └── detail-extraction/
│       └── SPEC.md                        # Detail extraction and validation (#28)
├── epic-06-screening-agent/               # EPIC: Screening Agent — Phase 1 (#30)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── compile-screening-list/
│   │   └── SPEC.md                        # Compile screening list from case data (#31)
│   ├── sanctions-screening/
│   │   └── SPEC.md                        # Run sanctions screening against local lists (#32)
│   └── hit-evaluation/
│       └── SPEC.md                        # LLM-based hit evaluation and dismissal (#33)
├── epic-07-basic-frontend/                # EPIC: Basic Frontend — Phase 1 (#38)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── dashboard-kanban/
│   │   └── SPEC.md                        # Dashboard view with case list and kanban board (#39)
│   ├── new-case-dialog/
│   │   └── SPEC.md                        # New case creation dialog (#40)
│   ├── case-detail-entity-profile/
│   │   └── SPEC.md                        # Case detail view with entity profile tab (#41)
│   ├── agent-progress/
│   │   └── SPEC.md                        # Agent progress indicator component (#42)
│   └── screening-results/
│       └── SPEC.md                        # Basic screening results display (#43)
├── epic-08-case-management-api/           # EPIC: Case Management API (#33)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── cases-crud/
│   │   └── SPEC.md                        # Cases CRUD API endpoints (#34)
│   ├── decision-fragments-api/
│   │   └── SPEC.md                        # Decision fragments API endpoints (#35)
│   └── websocket-events/
│       └── SPEC.md                        # WebSocket real-time events for case progress (#36)
├── epic-09-ownership-ubo-agent/           # EPIC: Ownership & UBO Mapping Agent (#43)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── direct-ownership/
│   │   └── SPEC.md                        # Direct ownership analysis (#44)
│   ├── recursive-tracing/
│   │   └── SPEC.md                        # Recursive corporate ownership tracing (#45)
│   ├── ubo-identification/
│   │   └── SPEC.md                        # Indirect ownership calculation and UBO identification (#46)
│   ├── complexity-assessment/
│   │   └── SPEC.md                        # Structure complexity assessment and tree generation (#47)
│   └── ownership-tree-viz/
│       └── SPEC.md                        # Ownership tree visualization — frontend (#48)
├── epic-10-adverse-media-screening/       # EPIC: Adverse Media Screening (#49)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── news-search-integration/
│   │   └── SPEC.md                        # News search integration for adverse media (#50)
│   └── adverse-media-analysis/
│       └── SPEC.md                        # LLM-based adverse media relevance analysis (#51)
├── epic-11-document-analysis-agent/       # EPIC: Document Analysis Agent (#52)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── document-classification/
│   │   └── SPEC.md                        # Document classification and data extraction (#53)
│   ├── registry-cross-referencing/
│   │   └── SPEC.md                        # Registry cross-referencing and discrepancy detection (#54)
│   └── document-upload-frontend/
│       └── SPEC.md                        # Document upload and analysis trigger in frontend (#55)
├── epic-12-risk-assessment-agent/         # EPIC: Risk Assessment Agent (#56)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── rule-engine-llm-analysis/
│   │   └── SPEC.md                        # Rule engine, LLM qualitative analysis, and review path (#58)
│   ├── narrative-generation/
│   │   └── SPEC.md                        # Risk narrative generation with fragment references (#59)
│   └── risk-scorecard-frontend/
│       └── SPEC.md                        # Risk scorecard and narrative display in frontend (#60)
├── epic-13-human-review-workflow/         # EPIC: Human Review Workflow (#61)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── review-api/
│   │   └── SPEC.md                        # Review API endpoints (queue, approve, reject, escalate, fragment override)
│   ├── qa-agent/
│   │   └── SPEC.md                        # QA Agent for automated low-risk case review (#63)
│   ├── review-queue/
│   │   └── SPEC.md                        # Review queue interface in frontend (#64)
│   ├── fragment-review/
│   │   └── SPEC.md                        # Fragment-level review and override in frontend (#65)
│   └── review-decision/
│       └── SPEC.md                        # Review decision workflow — approve/reject/escalate (#66)
├── epic-14-authentication-authorization/  # EPIC: Authentication & Authorization (#67)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── auth-service/
│   │   └── SPEC.md                        # Auth service and JWT implementation (backend)
│   ├── login-frontend/
│   │   └── SPEC.md                        # Login page and auth flow in frontend (#69)
│   └── rbac-middleware/
│       └── SPEC.md                        # Role-based access control middleware (#70)
├── epic-15-audit-trail-reporting/         # EPIC: Audit Trail & Reporting (#71)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── audit-trail-view/
│   │   └── SPEC.md                        # Audit trail view in frontend (#72)
│   ├── case-audit-export/
│   │   └── SPEC.md                        # Case audit export in PDF and JSON formats (#73)
│   └── dashboard-analytics/
│       └── SPEC.md                        # Dashboard analytics and KPI display (#74)
├── epic-16-configuration-ui/              # EPIC: Configuration UI (#75)
│   ├── EPIC.md                            # Epic overview and dependencies
│   ├── configuration-api/
│   │   └── SPEC.md                        # Configuration API endpoints (#76)
│   └── admin-config-views/
│       └── SPEC.md                        # Admin configuration views in frontend (#77)
```

## Conventions

- Each epic has its own directory named `epic-{NN}-{slug}`
- Each epic contains an `EPIC.md` with overview, scope, and dependency map
- Each story/task has a subdirectory with a `SPEC.md` containing the full specification
- Specs follow a consistent format: Context, Requirements, Technical Design, Interfaces, Acceptance Criteria, Dependencies, Testing Strategy
- GitHub issue numbers are referenced in headers for traceability
