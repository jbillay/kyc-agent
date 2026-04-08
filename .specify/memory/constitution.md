<!--
## Sync Impact Report

**Version change**: [unversioned template] → 1.0.0

### Modified Principles
- All principles: new (replaced template placeholders)

### Added Sections
- Core Principles (5 principles)
- Regulatory Compliance Constraints
- Development Workflow & Quality Gates
- Governance

### Removed Sections
- All bracket-token placeholder comments

### Templates Status
- `.specify/templates/plan-template.md` ✅ reviewed — Constitution Check section is generic and compatible; no update required
- `.specify/templates/spec-template.md` ✅ reviewed — requirements structure is compatible; no update required
- `.specify/templates/tasks-template.md` ✅ reviewed — task categories align with layered architecture; no update required

### Deferred TODOs
- None — all fields resolved from CLAUDE.md and kyc-agent-architecture.md
-->

# KYC Agent Constitution

## Core Principles

### I. Auditability First (NON-NEGOTIABLE)

Every agent action, LLM call, data source query, and decision MUST be recorded as an
immutable event in the `decision_events` table. This table MUST be append-only, enforced
at the database level via PostgreSQL rules that prevent UPDATE and DELETE operations.

Every agent decision MUST be expressed as a **Decision Fragment** that links:
- The decision type and confidence score (0–100)
- The evidence and data sources consulted
- The LLM reasoning that produced it
- The review status (`auto_approved`, `pending_review`, or human override)

No decision is considered valid or compliant if it cannot be reconstructed from the event
stream alone. Audit reproducibility MUST be preserved by caching external data source
responses in PostgreSQL (`data_source_cache`) keyed by `(provider, query_hash, fetched_at)`.

**Rationale**: Regulated financial institutions must demonstrate compliance to regulators
(FCA, FinCEN). An incomplete or mutable audit trail is a regulatory violation, not merely
a technical debt item.

### II. LLM-Agnostic Provider Interface (NON-NEGOTIABLE)

All LLM calls MUST be routed through `backend/src/llm/llm-service.js`. No agent, service,
or API handler MAY call an LLM provider directly.

All LLM providers MUST implement the `LLMProvider` interface (`complete`, `isAvailable`,
`listModels`). Task-based model routing MUST be defined in `config/llm.yaml`, mapping
`LLMTaskType` values (`reasoning`, `extraction`, `screening`, `classification`,
`summarization`) to specific models per provider.

The default provider MUST be Ollama (open-source, self-hosted). Commercial API providers
(OpenAI, Anthropic) are opt-in via configuration only.

**Rationale**: LLM vendor lock-in would compromise client data sovereignty and create
unpredictable cost exposure. The abstraction layer also enables task-optimized model routing
without requiring changes to agent logic.

### III. Strict Layered Architecture

The system MUST adhere to its 6-layer dependency hierarchy. Each layer MAY ONLY depend on
layers below it; upward or cross-layer dependencies are prohibited.

```
Layer 6: Frontend           → may depend on: L5 API only (via HTTP/WebSocket)
Layer 5: API                → may depend on: L4 services only
Layer 4: Core Services      → may depend on: L3 agents, L2 data sources, L1 LLM
Layer 3: Agent Framework    → may depend on: L2 data sources, L1 LLM
Layer 2: Data Integration   → may depend on: L1 LLM (for media relevance analysis)
Layer 1: LLM Abstraction    → no dependencies on other project layers
```

New modules MUST be placed in the layer that reflects their actual dependency scope.
Introducing a dependency that violates layer order requires an explicit architecture
decision documented in the relevant specification.

**Rationale**: Layer discipline is the primary mechanism preventing tight coupling across
the system. Violations propagate into test complexity, deployment fragility, and difficult
future refactors.

### IV. Data Sovereignty & Standalone Deployment

All data MUST remain within the deployment boundary by default. No data MAY leave the
deployment environment unless the operator explicitly configures an external provider
(e.g., an external LLM API, a news search API with a configured key).

The complete platform stack MUST be runnable with `docker-compose up` and no external
cloud services, accounts, or API keys required for core functionality.

External data source responses (registries, screening lists, news) MUST be cached
locally in PostgreSQL and MUST be fetchable from local cache for audit replay purposes.

**Rationale**: Target clients (regulated financial institutions) have strict data residency
obligations and IT security policies that prohibit uncontrolled data egress. The standalone
deployment also enables air-gapped or on-premises deployments.

### V. Configuration-Driven Compliance Logic

Risk rules, risk thresholds, screening list sources, country risk ratings, PEP definitions,
and review routing decisions MUST be declared in YAML configuration files:

- `config/risk-rules.yaml` — scoring rules, thresholds, review routing
- `config/llm.yaml` — provider and model routing per task type
- `config/data-sources.yaml` — registry and screening source configuration
- `config/screening-sources.yaml` — sanctions list URLs and update schedules

No compliance logic (risk scores, thresholds, routing decisions) MAY be hardcoded in
application code. Changes to risk appetite or regulatory requirements MUST be expressible
as configuration changes without code modifications.

**Rationale**: Each client operates under different regulatory obligations and risk
appetites. Hardcoded compliance logic would require code forks or deployments per client,
destroying maintainability and creating audit surface risk.

## Regulatory Compliance Constraints

The platform MUST support the following regulatory obligations as first-class requirements,
not secondary concerns:

- **UK**: Money Laundering Regulations 2017 (as amended); FCA Handbook (SYSC, SUP)
- **US**: Bank Secrecy Act (BSA); USA PATRIOT Act; FinCEN Customer Due Diligence Rule
- **International baseline**: FATF Recommendations

Specific requirements that shape implementation decisions:

- Beneficial ownership identification MUST use the 25% threshold (both UK and US CDD Rule)
- Sanctions and PEP screening MUST be performed against locally cached, version-pinned
  screening lists (OFAC SDN, UK HMT, UN, EU) with fuzzy matching
- Due diligence levels (simplified, standard, enhanced) MUST be driven by risk scores
  produced by the rule engine, not by agent heuristics
- Record retention MUST be designed for a minimum of 5 years after relationship end
- All agent actions contributing to a regulatory decision MUST be reproducible from the
  event store alone

Any feature that touches a regulatory obligation MUST reference the applicable regulation
in its specification.

## Development Workflow & Quality Gates

### Agent Development

New agents MUST extend `BaseAgent` and execute sequential, logged steps. Each step MUST
produce at least one Decision Fragment. Agents MUST NOT perform LLM calls directly —
all calls go through `llm-service.js`.

Agent state transitions MUST follow the defined pipeline state machine:
```
CREATED → ENTITY_RESOLUTION → [PARALLEL: ownership-ubo + screening]
        → RISK_ASSESSMENT → QA_OR_REVIEW → PENDING_HUMAN_REVIEW
        → APPROVED / REJECTED / ESCALATED
```

### API Development

All Fastify endpoints MUST include JSON Schema validation. No endpoint MAY return
unvalidated data shapes to the frontend. WebSocket events for real-time case updates
MUST be emitted through Socket.io and MUST follow the established event naming conventions.

### Testing

Backend tests run with `cd backend && npm test`. A single test file can be run with
`cd backend && npx jest path/to/test.js`. Frontend tests run with `cd frontend && npm test`.

Integration tests MUST cover agent pipeline state transitions and event store integrity.
Append-only enforcement of `decision_events` MUST be covered by a database-level test.

### Stack Operations

Full stack: `docker-compose up`. Rebuild: `docker-compose up --build`. All services are
defined in `docker-compose.yml` with ports documented in CLAUDE.md.

## Governance

This constitution supersedes all other practices, conventions, and informal agreements
within this project. When any document, code review comment, or discussion contradicts a
principle stated here, this constitution takes precedence.

**Amendment procedure**:
1. Propose the amendment with a written rationale explaining why the current principle is
   insufficient or incorrect.
2. Assess the impact on existing specifications, plans, and tasks using the consistency
   propagation checklist (see `/speckit-constitution` skill).
3. Bump the version according to semantic versioning: MAJOR for principle removals or
   redefinitions, MINOR for additions or material expansions, PATCH for clarifications.
4. Update `LAST_AMENDED_DATE` to the amendment date.
5. Propagate changes to affected templates and specifications.

**Compliance review**: All implementation plans MUST include a Constitution Check gate
before Phase 0 research and again after Phase 1 design. Violations require explicit
justification in the plan's Complexity Tracking table.

**Versioning policy**: `MAJOR.MINOR.PATCH` per semantic versioning conventions applied
to governance scope (defined above).

**Version**: 1.0.0 | **Ratified**: 2026-04-08 | **Last Amended**: 2026-04-08
