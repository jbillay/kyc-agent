# KYC Agent — System Architecture Document

## 1. Project Overview

### 1.1 Vision

KYC Agent is an **agentic AI platform** that automates Know Your Customer (KYC) processes for mid-market financial institutions and fintechs. Unlike traditional KYC SaaS platforms (Fenergo, CLM Pro, Encompass) that are workflow orchestration tools requiring human analysts to perform the cognitive work, KYC Agent uses autonomous AI agents to **execute the entire KYC case** — from entity resolution through risk assessment — with humans performing quality assurance on the output.

### 1.2 Core Design Principles

- **LLM-Agnostic**: The platform runs on open-source LLMs (Mistral, Llama, etc.) by default. No dependency on commercial LLM APIs. Clients can plug in any LLM — local, self-hosted, or cloud-based.
- **Standalone Deployment**: The entire platform runs from a single `docker-compose up` command. No external dependencies required beyond the Docker runtime.
- **Data Sovereignty**: All data stays within the client's infrastructure. No data leaves the deployment boundary unless the client explicitly configures external LLM providers.
- **Auditable by Design**: Every agent action, LLM call, data source query, and decision is recorded as an immutable event. Full regulatory audit trail is a first-class concern, not an afterthought.
- **Configurable Compliance**: Risk rules, thresholds, screening lists, and review workflows are configuration-driven, not hardcoded. Each client can tailor the platform to their risk appetite and regulatory obligations.

### 1.3 Target Markets

- **Primary**: UK-regulated financial institutions (FCA-supervised), US-regulated entities (FinCEN/BSA)
- **Segment**: Mid-market banks, fintechs, payment institutions, e-money institutions, crypto exchanges
- **Use Case**: Corporate client onboarding (KYC/KYB), with individual KYC as a secondary use case

### 1.4 Regulatory Context

The platform must support compliance with:

- **UK**: Money Laundering Regulations 2017 (as amended), FCA Handbook (SYSC, SUP)
- **US**: Bank Secrecy Act (BSA), USA PATRIOT Act, FinCEN CDD Rule
- **International**: FATF Recommendations (the baseline standard)

Key regulatory requirements that shape the architecture:

- Customer identification and verification (CID/CIV)
- Beneficial ownership identification (25% threshold UK, 25% threshold US CDD Rule)
- Sanctions and PEP screening
- Risk-based approach to due diligence (simplified, standard, enhanced)
- Ongoing monitoring and periodic reviews
- Record-keeping (5 years minimum after relationship ends)
- Ability to demonstrate compliance to regulators (audit trail)

---

## 2. System Architecture

### 2.1 High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                     Docker Compose Stack                          │
│                                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │  Frontend    │  │  API Server  │  │  Agent Workers           │ │
│  │  (Vue.js 3) │  │  (Fastify)   │  │  (BullMQ consumers)     │ │
│  │  :3000      │  │  :4000       │  │                          │ │
│  └─────────────┘  └──────────────┘  └──────────────────────────┘ │
│                                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐ │
│  │ PostgreSQL  │  │  Redis       │  │  MinIO                   │ │
│  │ (data +     │  │  (job queue  │  │  (document storage)      │ │
│  │  events)    │  │   + pubsub)  │  │                          │ │
│  │  :5432      │  │  :6379       │  │  :9000                   │ │
│  └─────────────┘  └──────────────┘  └──────────────────────────┘ │
│                                                                   │
│  ┌─────────────┐                                                  │
│  │  Ollama     │  ← Default LLM runtime (swappable)              │
│  │  :11434     │                                                  │
│  └─────────────┘                                                  │
└───────────────────────────────────────────────────────────────────┘
```

### 2.2 Layer Architecture

The system is organized into six layers:

```
┌──────────────────────────────────────────────┐
│  Layer 6: Frontend (Vue.js 3 + JavaScript)   │
├──────────────────────────────────────────────┤
│  Layer 5: API Layer (Fastify + WebSocket)    │
├──────────────────────────────────────────────┤
│  Layer 4: Core Platform Services             │
│  (Case Mgmt, Rules Engine, Auth, Storage)    │
├──────────────────────────────────────────────┤
│  Layer 3: Agent Framework                    │
│  (Orchestrator + Specialized Agents)         │
├──────────────────────────────────────────────┤
│  Layer 2: Data Integration Layer             │
│  (Registries, Screening Lists, News APIs)    │
├──────────────────────────────────────────────┤
│  Layer 1: LLM Abstraction Layer              │
│  (Provider Interface + Model Routing)        │
└──────────────────────────────────────────────┘
```

---

## 3. Layer 1 — LLM Abstraction Layer

### 3.1 Purpose

Every interaction with an LLM passes through this layer. No agent or service calls an LLM directly. This ensures model-agnosticism, centralized logging, prompt adaptation, and the ability to route different tasks to different models.

### 3.2 Provider Interface

Data structures are documented with JSDoc and enforced at runtime with a validation library (Joi or Zod).

```javascript
// src/llm/types.js

/**
 * @typedef {Object} LLMMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {Object} LLMStructuredOutput
 * @property {Object} schema - JSON Schema for the expected output
 * @property {boolean} strict - Whether to enforce schema compliance
 */

/**
 * @typedef {'reasoning'|'extraction'|'screening'|'classification'|'summarization'} LLMTaskType
 *
 * - reasoning:       Complex analysis, risk assessment, narrative generation
 * - extraction:      Data extraction from documents, structured parsing
 * - screening:       Sanctions/PEP/adverse media analysis
 * - classification:  Risk classification, entity type detection
 * - summarization:   Generating summaries, narratives
 */

/**
 * @typedef {Object} LLMRequest
 * @property {LLMMessage[]} messages
 * @property {LLMStructuredOutput} [structuredOutput]
 * @property {number} [temperature=0.1] - Default 0.1 for deterministic KYC work
 * @property {number} [maxTokens]
 * @property {LLMTaskType} taskType - Used for model routing
 */

/**
 * @typedef {Object} LLMResponse
 * @property {string} content
 * @property {Object} [structured] - Parsed structured output if schema was provided
 * @property {{ promptTokens: number, completionTokens: number, totalTokens: number }} usage
 * @property {string} model - Actual model used
 * @property {string} provider - Provider name
 * @property {number} latencyMs
 */

/**
 * LLM Provider Interface — every provider must implement these methods.
 *
 * @typedef {Object} LLMProvider
 * @property {string} name
 * @property {(request: LLMRequest) => Promise<LLMResponse>} complete
 * @property {() => Promise<boolean>} isAvailable
 * @property {() => Promise<string[]>} listModels
 */
```

### 3.3 Supported Providers

| Provider | Implementation | Use Case |
|----------|---------------|----------|
| **Ollama** | `OllamaProvider` | Default local runtime. Zero-config. Pulls and runs models automatically. |
| **vLLM** | `VLLMProvider` | High-performance self-hosted inference. For clients with GPU infrastructure. |
| **OpenAI-Compatible** | `OpenAICompatibleProvider` | Covers LMStudio, LocalAI, Together.ai, Groq, and any API following the OpenAI chat completions format. |
| **Anthropic** | `AnthropicProvider` | Optional cloud provider for clients who prefer Claude. |
| **OpenAI** | `OpenAIProvider` | Optional cloud provider for clients who prefer GPT. |

### 3.4 Model Routing Configuration

```yaml
# config/llm.yaml

llm:
  default_provider: "ollama"

  providers:
    ollama:
      base_url: "http://ollama:11434"
      timeout_ms: 120000
      retry:
        max_attempts: 3
        backoff_ms: 1000

    vllm:
      base_url: "http://gpu-server:8000"
      api_key: ""  # Optional, for secured deployments
      timeout_ms: 60000

    anthropic:
      api_key: "${ANTHROPIC_API_KEY}"  # Environment variable reference
      timeout_ms: 30000

  # Model routing: maps task types to specific models per provider
  routing:
    ollama:
      reasoning: "mistral-nemo:12b"
      extraction: "llama3:8b"
      screening: "mistral-nemo:12b"
      classification: "llama3:8b"
      summarization: "mistral-nemo:12b"

    vllm:
      reasoning: "mistralai/Mistral-Small-24B"
      extraction: "meta-llama/Llama-3-8B-Instruct"
      screening: "mistralai/Mistral-Small-24B"
      classification: "meta-llama/Llama-3-8B-Instruct"
      summarization: "mistralai/Mistral-Small-24B"

    anthropic:
      reasoning: "claude-sonnet-4-20250514"
      extraction: "claude-sonnet-4-20250514"
      screening: "claude-sonnet-4-20250514"
      classification: "claude-haiku-4-5-20251001"
      summarization: "claude-sonnet-4-20250514"
```

### 3.5 Prompt Adaptation

Different models require different prompt formats. The abstraction layer handles this transparently:

```javascript
// src/llm/prompt-adapter.js

/**
 * Prompt Adapter Interface — each provider has its own adapter.
 *
 * @typedef {Object} PromptAdapter
 * @property {(messages: LLMMessage[]) => string|LLMMessage[]} formatMessages
 * @property {(schema: Object) => string} formatStructuredOutputInstruction
 */

// Implementations:
// - Ollama/Mistral: uses [INST] tags for instruct models
// - Llama 3: uses <|start_header_id|> format
// - OpenAI-compatible: passes messages array directly
// - Anthropic: uses system/human/assistant format
```

### 3.6 LLM Call Logging

Every LLM call is logged to the decision fragment store:

```javascript
/**
 * @typedef {Object} LLMCallLog
 * @property {string} id
 * @property {string} timestamp
 * @property {string} caseId
 * @property {string} agentId
 * @property {string} stepId
 * @property {string} provider
 * @property {string} model
 * @property {LLMTaskType} taskType
 * @property {{ messages: LLMMessage[], temperature: number, maxTokens: number }} request
 * @property {{ content: string, structured?: Object, usage: Object, latencyMs: number }} response
 */
```

---

## 4. Layer 2 — Data Integration Layer

### 4.1 Purpose

Abstracts all external data sources behind a unified interface. Every data source is a swappable provider. All responses are cached and versioned for audit reproducibility.

### 4.2 Data Source Categories

#### 4.2.1 Corporate Registry Providers

```javascript
// src/data-sources/registry/types.js

/**
 * Registry Provider Interface — every corporate registry must implement these methods.
 *
 * @typedef {Object} RegistryProvider
 * @property {string} name
 * @property {string[]} jurisdictions - ISO 3166-1 alpha-2 codes
 * @property {(query: EntitySearchQuery) => Promise<EntitySearchResult[]>} searchEntity
 * @property {(entityId: string) => Promise<EntityDetails>} getEntityDetails
 * @property {(entityId: string) => Promise<Officer[]>} getOfficers
 * @property {(entityId: string) => Promise<Shareholder[]>} getShareholders
 * @property {(entityId: string) => Promise<Filing[]>} getFilingHistory
 * @property {(entityId: string) => Promise<EntityStatus>} getEntityStatus
 */

/**
 * @typedef {Object} EntitySearchQuery
 * @property {string} name
 * @property {string} [jurisdiction]
 * @property {string} [registrationNumber]
 * @property {string} [incorporationDate]
 */

/**
 * @typedef {Object} EntityDetails
 * @property {string} registrationNumber
 * @property {string} name
 * @property {string} jurisdiction
 * @property {string} incorporationDate
 * @property {string} entityType - "limited-company", "llp", "plc", etc.
 * @property {Object} registeredAddress
 * @property {'active'|'dissolved'|'liquidation'|'administration'|'other'} status
 * @property {string[]} [sicCodes]
 * @property {{ name: string, effectiveFrom: string, effectiveTo: string }[]} [previousNames]
 * @property {Object} rawData - Original API response for audit
 */
```

**MVP Implementations:**

| Provider | API | Cost | Jurisdictions |
|----------|-----|------|---------------|
| **Companies House** | `https://api.company-information.service.gov.uk` | Free (600 req/5min) | UK (GB) |
| **SEC EDGAR** | `https://efts.sec.gov/LATEST/` | Free | US |
| **OpenCorporates** (future) | `https://api.opencorporates.com` | Paid | 140+ jurisdictions |
| **Orbis/BvD** (future) | Proprietary API | Paid | Global |

#### 4.2.2 Screening Providers

```javascript
// src/data-sources/screening/types.js

/**
 * Screening Provider Interface.
 *
 * @typedef {Object} ScreeningProvider
 * @property {string} name
 * @property {'sanctions'|'pep'|'adverse_media'} listType
 * @property {(query: ScreeningQuery) => Promise<ScreeningHit[]>} search
 * @property {() => Promise<ListMetadata>} getListMetadata
 * @property {() => Promise<UpdateResult>} updateList - For locally cached lists
 */

/**
 * @typedef {Object} ScreeningQuery
 * @property {string} name
 * @property {string} [dateOfBirth]
 * @property {string} [nationality]
 * @property {'individual'|'entity'} entityType
 * @property {string[]} [aliases]
 */

/**
 * @typedef {Object} ScreeningHit
 * @property {string} source - "OFAC-SDN", "UK-HMT", "UN-CONSOLIDATED", etc.
 * @property {string} matchedName
 * @property {number} matchScore - 0-100 fuzzy match score
 * @property {string[]} matchedFields - Which fields matched
 * @property {Object} listEntry
 * @property {string} listEntry.id
 * @property {string[]} listEntry.names
 * @property {string} [listEntry.dateOfBirth]
 * @property {string[]} [listEntry.nationality]
 * @property {string[]} [listEntry.programs] - Sanctions programs (e.g., "SDGT", "IRAN")
 * @property {string} [listEntry.remarks]
 * @property {string} [listEntry.listedDate]
 * @property {Object} rawData
 */
```

**MVP Screening Sources (all free):**

| List | Format | Update Frequency | Source URL |
|------|--------|-----------------|------------|
| OFAC SDN | XML/CSV | Daily | `https://sanctionslistservice.ofac.treas.gov/` |
| OFAC Consolidated | XML | Daily | Same as above |
| UK HMT Sanctions | CSV | As needed | `https://www.gov.uk/government/publications/financial-sanctions-consolidated-list-of-targets` |
| UN Consolidated | XML | As needed | `https://scsanctions.un.org/resources/xml/` |
| EU Consolidated | XML | As needed | `https://webgate.ec.europa.eu/fsd/fsf/` |

**Adverse media** will use web search APIs (e.g., Bing News API or Google Custom Search) combined with LLM-based relevance analysis.

#### 4.2.3 Data Caching & Versioning

All external data source responses are cached in PostgreSQL:

```sql
CREATE TABLE data_source_cache (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(100) NOT NULL,
    query_hash VARCHAR(64) NOT NULL,     -- SHA-256 of the query parameters
    query_params JSONB NOT NULL,
    response_data JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,              -- Provider-specific TTL
    case_id UUID REFERENCES cases(id),   -- Which case triggered this fetch
    UNIQUE(provider, query_hash, fetched_at)
);

CREATE INDEX idx_cache_provider_query ON data_source_cache(provider, query_hash, fetched_at DESC);
```

This means:
- Every case can prove exactly what data was available at decision time.
- Re-running a case with historical data is possible for audits.
- Redundant API calls are avoided within the TTL window.

---

## 5. Layer 3 — Agent Framework

### 5.1 Agent Architecture Overview

The agent framework follows a **team model** where specialized agents handle specific KYC tasks, coordinated by an orchestrator.

```
                    ┌──────────────┐
                    │ Orchestrator │
                    └──────┬───────┘
                           │
          ┌────────────────┼─────────────────┐
          │                │                  │
    ┌─────┴──────┐  ┌─────┴──────┐  ┌───────┴────────┐
    │  Entity    │  │ Ownership  │  │  Screening     │
    │ Resolution │  │  & UBO     │  │  Agent         │
    │  Agent     │  │  Agent     │  │                │
    └────────────┘  └────────────┘  └────────────────┘
          │                │                  │
    ┌─────┴──────┐  ┌─────┴──────┐           │
    │  Document  │  │   Risk     │           │
    │  Analysis  │  │ Assessment │           │
    │  Agent     │  │  Agent     │           │
    └────────────┘  └────────────┘           │
                           │                  │
                    ┌──────┴──────┐           │
                    │  QA Agent   │ ◄─────────┘
                    │ (low-risk)  │
                    └─────────────┘
```

### 5.2 Base Agent Interface

```javascript
// src/agents/base-agent.js

/**
 * @typedef {Object} AgentContext
 * @property {string} caseId
 * @property {string} entityName
 * @property {string} jurisdiction
 * @property {Object} existingData - Data from previous agents
 * @property {Object} config - Client-specific configuration
 */

/**
 * @typedef {Object} AgentStep
 * @property {string} stepId
 * @property {string} name
 * @property {string} description
 * @property {'pending'|'running'|'completed'|'failed'|'skipped'} status
 * @property {string} [startedAt]
 * @property {string} [completedAt]
 * @property {DecisionFragment[]} decisionFragments
 * @property {LLMCallLog[]} llmCalls
 * @property {string} [error]
 */

/**
 * @typedef {Object} AgentResult
 * @property {string} agentId
 * @property {string} agentType
 * @property {string} caseId
 * @property {'completed'|'failed'|'partial'} status
 * @property {AgentStep[]} steps
 * @property {Object} output - Structured output for downstream agents
 * @property {DecisionFragment[]} decisionFragments
 * @property {number} confidence - 0-100 overall confidence
 * @property {string} startedAt
 * @property {string} completedAt
 * @property {number} totalLLMCalls
 * @property {number} totalLatencyMs
 */

/**
 * Base Agent class — all specialized agents extend this.
 *
 * Lifecycle:
 *   1. Initialize agent run
 *   2. Execute each step sequentially
 *   3. For each step:
 *      a. Call LLM through abstraction layer
 *      b. Call data sources through integration layer
 *      c. Produce decision fragments
 *      d. Handle errors with retry logic
 *   4. Compile and return results
 */
class BaseAgent {
  /** @type {string} */
  agentType;

  /** @type {string[]} */
  steps;

  /**
   * @param {AgentContext} context
   * @returns {Promise<AgentResult>}
   */
  async execute(context) {
    throw new Error('Must be implemented by subclass');
  }

  /**
   * @param {string} stepName
   * @param {AgentContext} context
   * @param {AgentStep[]} previousSteps
   * @returns {Promise<AgentStep>}
   */
  async executeStep(stepName, context, previousSteps) {
    throw new Error('Must be implemented by subclass');
  }
}

module.exports = { BaseAgent };
```

### 5.3 Decision Fragment Model

The core audit and explainability unit:

```javascript
// src/agents/decision-fragment.js

/**
 * Decision Fragment Types:
 *
 *   entity_match             — "Matched to Companies House record X"
 *   entity_detail_extracted  — "Extracted SIC code, address, etc."
 *   officer_identified       — "Identified John Smith as director"
 *   shareholder_identified   — "Identified HoldCo Ltd as 40% shareholder"
 *   ubo_identified           — "Identified Jane Doe as UBO with 60% indirect ownership"
 *   ubo_chain_traced         — "Traced ownership through 3 entities"
 *   ubo_dead_end             — "Cannot trace ownership beyond Entity X"
 *   sanctions_clear          — "No sanctions matches found for Person X"
 *   sanctions_hit            — "Potential sanctions match found"
 *   sanctions_dismissed      — "Sanctions hit dismissed: DOB mismatch"
 *   pep_clear                — "No PEP matches found"
 *   pep_hit                  — "PEP match found"
 *   adverse_media_clear      — "No relevant adverse media found"
 *   adverse_media_hit        — "Relevant adverse media found"
 *   document_verified        — "Certificate matches registry data"
 *   document_discrepancy     — "Address mismatch between document and registry"
 *   risk_factor_identified   — "High-risk jurisdiction identified"
 *   risk_score_calculated    — "Overall risk score: MEDIUM (55/100)"
 *   narrative_generated      — "Risk narrative generated"
 */

/**
 * @typedef {Object} DecisionFragment
 * @property {string} id
 * @property {string} caseId
 * @property {string} agentType
 * @property {string} stepId
 * @property {string} timestamp
 * @property {string} type - One of the fragment types listed above
 * @property {string} decision - Human-readable decision statement
 * @property {number} confidence - 0-100
 * @property {Object} evidence
 * @property {string[]} evidence.dataSources
 * @property {DataPoint[]} evidence.dataPoints
 * @property {string} [evidence.llmReasoning]
 * @property {'auto_approved'|'pending_review'|'human_approved'|'human_rejected'|'human_modified'} status
 * @property {string} [reviewedBy]
 * @property {string} [reviewComment]
 * @property {string} [reviewedAt]
 */

/**
 * @typedef {Object} DataPoint
 * @property {string} source
 * @property {string} field
 * @property {*} value
 * @property {string} fetchedAt
 * @property {string} [cacheId]
 */
```

### 5.4 Specialized Agents

#### 5.4.1 Entity Resolution Agent

**Purpose**: Takes a client name and identifiers, resolves to a verified entity in corporate registries.

**Steps:**
1. `search_registry` — Query Companies House (or relevant registry) with the entity name and any provided identifiers.
2. `evaluate_candidates` — LLM evaluates candidate matches based on name similarity, jurisdiction, incorporation date, registration number (if provided). Produces a ranked list with confidence scores.
3. `select_best_match` — Select the highest-confidence match, or flag for human input if confidence is below threshold (configurable, default 80%).
4. `extract_entity_details` — Pull full entity details from the registry: registration number, addresses, SIC codes, status, previous names, filing history.
5. `extract_officers` — Pull current and historical directors/officers.
6. `extract_shareholders` — Pull current shareholders (for Companies House: PSC register).
7. `validate_entity` — LLM performs a consistency check: does the entity type match what the client declared? Is the entity active? Are there any red flags in the filing history (e.g., overdue accounts, compulsory strike-off notices)?

**Output**: Structured `EntityProfile` object containing all extracted data, list of officers, list of shareholders, and validation decision fragments.

#### 5.4.2 Ownership & UBO Mapping Agent

**Purpose**: Traces the ownership chain from direct shareholders to ultimate beneficial owners.

**Steps:**
1. `analyze_direct_ownership` — Take the shareholder list from the Entity Resolution Agent, classify each shareholder as individual or corporate, and record direct ownership percentages.
2. `trace_corporate_shareholders` — For each corporate shareholder, recursively query registries to find their own shareholders. Build the ownership tree layer by layer. Stop when: an individual is reached, the ownership percentage falls below the threshold, a maximum depth is reached (configurable, default 10 levels), or a dead end is hit (opaque jurisdiction, no data available).
3. `calculate_indirect_ownership` — Calculate indirect ownership percentages through the chain. An individual who owns 50% of Entity A, which owns 40% of the target, has 20% indirect ownership.
4. `identify_ubos` — Identify all individuals who meet the UBO threshold (25% for UK/US). Flag any cases where no UBO can be identified (which triggers enhanced due diligence requirements).
5. `assess_structure_complexity` — LLM evaluates the overall ownership structure for complexity indicators: number of layers, cross-border elements, circular ownership, nominee structures, trusts, bearer shares.
6. `generate_ownership_tree` — Produce a structured tree representation suitable for visual rendering.

**Output**: Structured `OwnershipMap` object with tree data, list of identified UBOs, dead-end flags, and complexity assessment.

#### 5.4.3 Screening Agent

**Purpose**: Screens all identified individuals and entities against sanctions, PEP, and adverse media sources.

**Steps:**
1. `compile_screening_list` — Collect all individuals (directors, UBOs, authorized signatories) and entities (the client, intermediate holding companies) that need screening. Include known aliases and alternative name spellings.
2. `run_sanctions_screening` — For each person/entity on the list, query all configured sanctions lists. Use fuzzy name matching with configurable threshold (default 85%).
3. `evaluate_sanctions_hits` — For each potential hit, LLM evaluates whether it's a true match or false positive based on: name similarity, date of birth match/mismatch, nationality match/mismatch, other identifiers. Produces a decision fragment for each hit explaining why it was confirmed or dismissed.
4. `run_pep_screening` — Screen against PEP databases. Evaluate hits using same approach as sanctions.
5. `run_adverse_media_screening` — Search for adverse media on each person/entity. LLM analyzes news results to determine relevance and severity. Categorizes hits: financial crime, fraud, corruption, tax evasion, regulatory action, litigation, other.
6. `compile_screening_report` — Aggregate all screening results into a structured report with clear hit/dismiss status for each person/entity/list combination.

**Output**: Structured `ScreeningReport` with per-person/entity results, confirmed hits, dismissed hits with reasoning, and overall screening risk assessment.

#### 5.4.4 Document Analysis Agent

**Purpose**: Analyzes uploaded KYC documents, extracts data, and cross-references against registry data.

**Steps:**
1. `classify_document` — Identify the document type: certificate of incorporation, articles of association, proof of address, utility bill, bank statement, ID document, etc.
2. `extract_document_data` — Extract structured data from the document: entity name, registration number, addresses, dates, names of individuals, etc.
3. `cross_reference_registry` — Compare extracted data against entity profile from the Entity Resolution Agent. Identify matches and discrepancies.
4. `validate_document_authenticity` — Check for obvious issues: document date vs. expected date, formatting inconsistencies, missing required elements.
5. `generate_document_report` — Produce a structured report of extracted data, cross-reference results, and any discrepancies or concerns.

**Output**: Structured `DocumentAnalysisReport` with extraction results, cross-reference findings, and discrepancy flags.

#### 5.4.5 Risk Assessment Agent

**Purpose**: Synthesizes all previous agent outputs into a risk score and narrative.

**Steps:**
1. `collect_risk_inputs` — Gather all outputs from previous agents.
2. `apply_rule_engine` — Apply configurable risk rules to calculate a quantitative risk score. See section 6.4 for the rule engine specification.
3. `llm_risk_analysis` — LLM performs qualitative risk analysis considering factors the rule engine may not capture: unusual patterns, contextual red flags, mitigating factors.
4. `calculate_final_risk` — Combine rule engine score and LLM analysis into a final risk rating (LOW / MEDIUM / HIGH / VERY HIGH) with a numeric score (0-100).
5. `generate_narrative` — LLM generates a risk assessment narrative that: summarizes the entity, describes the ownership structure, lists screening findings, notes any discrepancies, explains the risk rating, and recommends the due diligence level (simplified, standard, enhanced). Every statement in the narrative links to supporting decision fragments.
6. `determine_review_path` — Based on risk rating and confidence, determine the review path: AI QA review (low risk + high confidence), standard human review (medium risk or medium confidence), senior analyst review (high risk or low confidence).

**Output**: Structured `RiskAssessment` with score breakdown, narrative, recommended DD level, and review assignment.

#### 5.4.6 QA Agent (for Low-Risk Cases)

**Purpose**: Performs automated quality assurance on low-risk, high-confidence cases before they reach a human reviewer.

**Steps:**
1. `completeness_check` — Verify all required data points are present.
2. `consistency_check` — Cross-validate agent outputs for internal consistency.
3. `rule_compliance_check` — Verify the case meets minimum regulatory requirements for the assigned DD level.
4. `generate_qa_summary` — Produce a QA summary noting any issues found or confirming the case is ready for streamlined human review.

**Output**: Structured `QAReport` with pass/fail status and any issues for human attention.

### 5.5 Orchestrator

```javascript
// src/agents/orchestrator.js

/**
 * Case states (state machine):
 *
 *   CREATED → ENTITY_RESOLUTION → PARALLEL_1 (ownership + screening)
 *   → RISK_ASSESSMENT → QA_OR_REVIEW → PENDING_HUMAN_REVIEW
 *   → APPROVED | REJECTED | ESCALATED | ADDITIONAL_INFO_REQUIRED
 */

const WORKFLOW = {
  CREATED: {
    next: 'ENTITY_RESOLUTION',
    agents: ['entity-resolution']
  },
  ENTITY_RESOLUTION: {
    next: 'PARALLEL_1',
    agents: ['ownership-ubo', 'screening'],
    parallel: true,
    dependencies: {
      'ownership-ubo': ['entity-resolution'],
      'screening': ['entity-resolution']
    }
  },
  PARALLEL_1: {
    next: 'RISK_ASSESSMENT',
    agents: ['risk-assessment'],
    dependencies: {
      'risk-assessment': ['entity-resolution', 'ownership-ubo', 'screening']
    }
  },
  RISK_ASSESSMENT: {
    next: 'QA_OR_REVIEW',
    agents: ['qa-agent']
  }
};

/**
 * Agent job payload for BullMQ.
 *
 * @typedef {Object} AgentJob
 * @property {'agent-execution'} type
 * @property {string} caseId
 * @property {string} agentType
 * @property {AgentContext} context
 * @property {number} priority
 * @property {number} attempts
 * @property {number} maxAttempts
 */

module.exports = { WORKFLOW };
```

---

## 6. Layer 4 — Core Platform Services

### 6.1 Case Management Service

```javascript
// src/services/case-management.js

/**
 * @typedef {Object} KYCCase
 * @property {string} id
 * @property {string} clientName
 * @property {'corporate'|'individual'} clientType
 * @property {string} jurisdiction
 * @property {string} [registrationNumber]
 * @property {Object} [additionalIdentifiers]
 * @property {string} state - CaseState value
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {string} [completedAt]
 * @property {Object} [entityProfile]
 * @property {Object} [ownershipMap]
 * @property {Object} [screeningReport]
 * @property {Object[]} [documentAnalysisReports]
 * @property {Object} [riskAssessment]
 * @property {Object} [qaReport]
 * @property {string} [assignedReviewer]
 * @property {'approved'|'rejected'|'escalated'|'additional_info'} [reviewDecision]
 * @property {string} [reviewComment]
 * @property {string} [reviewedAt]
 * @property {'simplified'|'standard'|'enhanced'} ddLevel
 * @property {string[]} [tags]
 * @property {'api'|'manual'|'batch'} [source]
 */
```

### 6.2 Decision Fragment Store (Event Store)

All agent activity is stored as an append-only event stream:

```sql
CREATE TABLE decision_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    agent_type VARCHAR(50) NOT NULL,
    step_id VARCHAR(100) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    data JSONB NOT NULL,
    sequence_number BIGSERIAL
);

CREATE INDEX idx_events_case ON decision_events(case_id, sequence_number);
CREATE INDEX idx_events_type ON decision_events(event_type, timestamp);
CREATE INDEX idx_events_agent ON decision_events(case_id, agent_type, step_id);

-- Prevent updates/deletes (append-only)
CREATE RULE no_update AS ON UPDATE TO decision_events DO INSTEAD NOTHING;
CREATE RULE no_delete AS ON DELETE TO decision_events DO INSTEAD NOTHING;
```

### 6.3 Document Storage

Uses MinIO (S3-compatible) for file storage:

```javascript
/**
 * @typedef {Object} DocumentRecord
 * @property {string} id
 * @property {string} caseId
 * @property {string} filename
 * @property {string} mimeType
 * @property {number} sizeBytes
 * @property {string} minioKey
 * @property {string} uploadedAt
 * @property {string} uploadedBy
 * @property {string} [documentType]
 * @property {string} [extractedText]
 * @property {Object} [extractedData]
 * @property {'pending'|'analyzing'|'analyzed'|'failed'} analysisStatus
 */
```

### 6.4 Rule Engine

Configurable risk scoring rules in YAML:

```yaml
# config/risk-rules.yaml

risk_rules:
  version: "1.0"

  country_risk:
    high_risk:
      countries: ["AF", "IR", "KP", "SY", "YE", "MM", "LY", "SO", "SS"]
      score_addition: 30
    medium_risk:
      countries: ["RU", "BY", "VE", "NI", "ZW", "CU", "PK"]
      score_addition: 15

  industry_risk:
    high_risk:
      sic_codes: ["64205", "64209"]
      keywords: ["cryptocurrency", "virtual asset", "money transfer", "gambling"]
      score_addition: 25
    medium_risk:
      sic_codes: ["64191", "64192"]
      keywords: ["precious metals", "art dealing", "real estate"]
      score_addition: 10

  ownership_risk:
    layers_threshold: 3
    score_per_extra_layer: 5
    cross_border_addition: 10
    opaque_jurisdiction_addition: 20
    nominee_detected_addition: 15
    no_ubo_identified_addition: 25

  screening_risk:
    confirmed_sanctions_hit: 100
    pep_identified: 20
    adverse_media_per_hit:
      high_severity: 15
      medium_severity: 8
      low_severity: 3

  thresholds:
    low: { min: 0, max: 25 }
    medium: { min: 26, max: 50 }
    high: { min: 51, max: 75 }
    very_high: { min: 76, max: 100 }

  review_routing:
    low_risk_high_confidence:
      min_confidence: 85
      max_risk_score: 25
      route: "qa_agent"
    standard:
      route: "human_reviewer"
    high_risk:
      min_risk_score: 51
      route: "senior_analyst"
```

### 6.5 Authentication & Authorization

```javascript
// src/services/auth-service.js

/**
 * User roles and their permissions (JWT-based auth, RBAC).
 *
 *   analyst:
 *     - cases:read, cases:review_assigned, documents:upload, documents:read
 *
 *   senior_analyst (inherits analyst):
 *     - cases:review_any, cases:escalate, cases:override_risk
 *
 *   compliance_officer (inherits senior_analyst):
 *     - rules:read, rules:modify, reports:generate, audit:read
 *
 *   admin (all permissions):
 *     - users:manage, system:configure, providers:configure
 */
```

---

## 7. Layer 5 — API Layer

### 7.1 Framework

**Fastify** (JavaScript) — chosen for performance and built-in JSON schema validation.

### 7.2 API Endpoint Groups

#### Cases API

```
POST   /api/v1/cases                    Create a new KYC case
GET    /api/v1/cases                    List cases (filters: state, risk, assignee, date range)
GET    /api/v1/cases/:id                Get case details
GET    /api/v1/cases/:id/fragments      Get decision fragments for a case
GET    /api/v1/cases/:id/timeline       Get chronological event timeline
POST   /api/v1/cases/:id/documents      Upload documents to a case
POST   /api/v1/cases/:id/rerun/:agent   Re-run a specific agent on a case
PATCH  /api/v1/cases/:id/state          Manually transition case state (with auth)
```

#### Review API

```
GET    /api/v1/review/queue             Get cases pending review (for current user)
POST   /api/v1/review/:caseId/approve   Approve a case
POST   /api/v1/review/:caseId/reject    Reject a case (with reason)
POST   /api/v1/review/:caseId/escalate  Escalate to senior reviewer
POST   /api/v1/review/:caseId/request-info  Request additional information
PATCH  /api/v1/review/:caseId/fragments/:fragmentId  Override a decision fragment
```

#### Configuration API

```
GET    /api/v1/config/risk-rules        Get current risk rules
PUT    /api/v1/config/risk-rules        Update risk rules
GET    /api/v1/config/llm               Get LLM configuration
PUT    /api/v1/config/llm               Update LLM configuration
GET    /api/v1/config/data-sources      Get data source configuration
PUT    /api/v1/config/data-sources      Update data source configuration
```

#### Admin / Audit API

```
GET    /api/v1/audit/events             Query audit events (with filters)
GET    /api/v1/audit/cases/:id/export   Export full audit trail (PDF/JSON)
GET    /api/v1/admin/users              List users
POST   /api/v1/admin/users              Create user
GET    /api/v1/admin/system/health      System health check
GET    /api/v1/admin/system/stats       System statistics
```

### 7.3 WebSocket Events

Real-time updates via Socket.io:

```javascript
/**
 * Server → Client WebSocket events:
 *
 *   'case:state_changed'        — { caseId, oldState, newState }
 *   'case:agent_started'        — { caseId, agentType }
 *   'case:agent_step_completed' — { caseId, agentType, stepId, stepName }
 *   'case:agent_completed'      — { caseId, agentType, status, confidence }
 *   'case:fragment_added'       — { caseId, fragment }
 *   'case:review_assigned'      — { caseId, reviewerId }
 *   'case:completed'            — { caseId, riskRating, riskScore }
 */
```

### 7.4 Schema Validation

Fastify uses JSON Schema natively for request/response validation, providing runtime type safety without a compile step:

```javascript
// Example: create case endpoint with JSON Schema validation
const createCaseSchema = {
  body: {
    type: 'object',
    required: ['clientName', 'clientType', 'jurisdiction'],
    properties: {
      clientName: { type: 'string', minLength: 1 },
      clientType: { type: 'string', enum: ['corporate', 'individual'] },
      jurisdiction: { type: 'string', pattern: '^[A-Z]{2}$' },
      registrationNumber: { type: 'string' },
      additionalIdentifiers: { type: 'object' }
    }
  }
};

app.post('/api/v1/cases', { schema: createCaseSchema }, createCaseHandler);
```

Additionally, **Joi** or **Zod** can be used for complex business logic validation within services and agents.

---

## 8. Layer 6 — Frontend (Vue.js 3)

### 8.1 Technology Stack

| Technology | Purpose |
|-----------|---------|
| **Vue 3** + **JavaScript** | Core framework with Composition API |
| **Pinia** | State management |
| **Vue Router** | Client-side routing |
| **Vue Flow** | Ownership tree visualization |
| **PrimeVue** or **Naive UI** | Component library (data tables, forms, dialogs) |
| **Socket.io Client** | Real-time WebSocket updates |
| **D3.js** (optional) | Advanced data visualizations if needed |
| **Vite** | Build tool |

### 8.2 Application Views

#### 8.2.1 Dashboard View (`/dashboard`)

Kanban-style board showing cases by state:
- **In Progress**: Cases where agents are currently working
- **Pending Review**: Cases awaiting human QA
- **Approved**: Completed cases
- **Escalated / Needs Info**: Cases requiring attention

Each card shows: entity name, jurisdiction, current risk rating (color-coded), time elapsed, assigned reviewer.

Real-time updates via WebSocket — cards move between columns live as agents complete.

#### 8.2.2 Case Detail View (`/cases/:id`)

The primary work surface. Sections:

**Header**: Entity name, registration number, jurisdiction, current state badge, risk rating badge, timeline summary.

**Entity Profile Tab**: Company details, officers table, filing history summary, discrepancy flags.

**Ownership Tab**: Interactive ownership tree (Vue Flow), nodes with entity/person name, ownership %, jurisdiction. Color coding: green (verified), yellow (partially verified), red (dead end / high risk). Click any node for its decision fragments.

**Screening Tab**: Per-person/entity screening results, expandable panels for each hit showing match score, matched fields, LLM reasoning for confirmation/dismissal. Human can override any dismissal/confirmation.

**Documents Tab**: Document upload area, classification and verification status, extracted data vs. registry data comparison.

**Risk Assessment Tab**: Risk score breakdown (visual scorecard/bar chart), risk factors with per-factor scores, generated narrative with clickable links to supporting fragments.

**Audit Trail Tab**: Chronological event log, filterable by agent, event type, decision type, confidence level. Expandable entries showing full fragment detail including LLM reasoning.

#### 8.2.3 Review Interface (`/review`)

Streamlined view for reviewers: case list, one-click access to case detail, inline approve/reject/escalate buttons, fragment-level override capability, review comment field, review history.

#### 8.2.4 Configuration View (`/admin/config`)

Admin interface for: risk rules editor (YAML/form-based), LLM provider configuration, data source configuration, user management, system health and statistics.

---

## 9. Data Model

### 9.1 Database Schema Overview

```sql
CREATE TABLE cases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_name VARCHAR(500) NOT NULL,
    client_type VARCHAR(20) NOT NULL CHECK (client_type IN ('corporate', 'individual')),
    jurisdiction VARCHAR(10) NOT NULL,
    registration_number VARCHAR(100),
    additional_identifiers JSONB DEFAULT '{}',
    state VARCHAR(50) NOT NULL DEFAULT 'CREATED',
    dd_level VARCHAR(20) NOT NULL DEFAULT 'standard',
    risk_score INTEGER,
    risk_rating VARCHAR(20),
    assigned_reviewer UUID REFERENCES users(id),
    review_decision VARCHAR(30),
    review_comment TEXT,
    reviewed_at TIMESTAMPTZ,
    source VARCHAR(20) DEFAULT 'manual',
    tags TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE agent_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    agent_type VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,
    output JSONB NOT NULL,
    confidence INTEGER,
    steps JSONB NOT NULL,
    total_llm_calls INTEGER,
    total_latency_ms INTEGER,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    UNIQUE(case_id, agent_type)
);

CREATE TABLE decision_fragments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    agent_type VARCHAR(50) NOT NULL,
    step_id VARCHAR(100) NOT NULL,
    type VARCHAR(50) NOT NULL,
    decision TEXT NOT NULL,
    confidence INTEGER NOT NULL,
    evidence JSONB NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending_review',
    reviewed_by UUID REFERENCES users(id),
    review_comment TEXT,
    reviewed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE decision_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    agent_type VARCHAR(50) NOT NULL,
    step_id VARCHAR(100) NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    data JSONB NOT NULL,
    sequence_number BIGSERIAL
);

CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id UUID NOT NULL REFERENCES cases(id),
    filename VARCHAR(500) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    minio_key VARCHAR(500) NOT NULL,
    document_type VARCHAR(100),
    extracted_text TEXT,
    extracted_data JSONB,
    analysis_status VARCHAR(20) NOT NULL DEFAULT 'pending',
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    uploaded_by UUID REFERENCES users(id)
);

CREATE TABLE screening_lists (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_name VARCHAR(100) NOT NULL UNIQUE,
    list_type VARCHAR(20) NOT NULL,
    source_url VARCHAR(500),
    last_updated TIMESTAMPTZ,
    entry_count INTEGER,
    metadata JSONB
);

CREATE TABLE screening_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    list_id UUID NOT NULL REFERENCES screening_lists(id),
    entry_id VARCHAR(200) NOT NULL,
    entity_type VARCHAR(20) NOT NULL,
    primary_name VARCHAR(500) NOT NULL,
    aliases TEXT[],
    date_of_birth VARCHAR(20),
    nationalities TEXT[],
    programs TEXT[],
    remarks TEXT,
    raw_data JSONB NOT NULL,
    UNIQUE(list_id, entry_id)
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(30) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);
```

---

## 10. Deployment

### 10.1 Docker Compose Configuration

```yaml
version: '3.8'

services:
  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    ports:
      - "3000:3000"
    environment:
      - VITE_API_URL=http://localhost:4000
      - VITE_WS_URL=ws://localhost:4000
    depends_on:
      - api

  api:
    build:
      context: ./backend
      dockerfile: Dockerfile
    ports:
      - "4000:4000"
    environment:
      - DATABASE_URL=postgresql://kyc:kyc@postgres:5432/kycagent
      - REDIS_URL=redis://redis:6379
      - MINIO_ENDPOINT=minio
      - MINIO_PORT=9000
      - MINIO_ACCESS_KEY=minioadmin
      - MINIO_SECRET_KEY=minioadmin
      - JWT_SECRET=${JWT_SECRET:-change-me-in-production}
    depends_on:
      - postgres
      - redis
      - minio

  agent-worker:
    build:
      context: ./backend
      dockerfile: Dockerfile
    command: ["node", "src/workers/agent-worker.js"]
    environment:
      - DATABASE_URL=postgresql://kyc:kyc@postgres:5432/kycagent
      - REDIS_URL=redis://redis:6379
      - MINIO_ENDPOINT=minio
      - MINIO_PORT=9000
      - LLM_CONFIG_PATH=/app/config/llm.yaml
    depends_on:
      - postgres
      - redis
      - ollama
    deploy:
      replicas: 2

  screening-sync:
    build:
      context: ./backend
      dockerfile: Dockerfile
    command: ["node", "src/workers/screening-sync.js"]
    environment:
      - DATABASE_URL=postgresql://kyc:kyc@postgres:5432/kycagent

  postgres:
    image: postgres:16
    ports:
      - "5432:5432"
    environment:
      - POSTGRES_USER=kyc
      - POSTGRES_PASSWORD=kyc
      - POSTGRES_DB=kycagent
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./backend/db/init.sql:/docker-entrypoint-initdb.d/init.sql

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redisdata:/data

  minio:
    image: minio/minio
    ports:
      - "9000:9000"
      - "9001:9001"
    environment:
      - MINIO_ROOT_USER=minioadmin
      - MINIO_ROOT_PASSWORD=minioadmin
    command: server /data --console-address ":9001"
    volumes:
      - miniodata:/data

  ollama:
    image: ollama/ollama
    ports:
      - "11434:11434"
    volumes:
      - ollamadata:/root/.ollama
    # GPU support (uncomment for NVIDIA GPU):
    # deploy:
    #   resources:
    #     reservations:
    #       devices:
    #         - driver: nvidia
    #           count: 1
    #           capabilities: [gpu]

volumes:
  pgdata:
  redisdata:
  miniodata:
  ollamadata:
```

### 10.2 Hardware Requirements

**Minimum (development/demo):**
- 16 GB RAM, 8 CPU cores, 50 GB disk
- No GPU required (Ollama runs on CPU, slower but functional)

**Recommended (production with local LLM):**
- 32 GB RAM, 16 CPU cores
- NVIDIA GPU with 24+ GB VRAM (e.g., RTX 4090, A5000)
- 200 GB SSD

**Without local LLM (using external provider):**
- 8 GB RAM, 4 CPU cores, 100 GB SSD

---

## 11. Project Structure

```
kyc-agent/
├── docker-compose.yaml
├── README.md
├── config/
│   ├── llm.yaml
│   ├── risk-rules.yaml
│   ├── data-sources.yaml
│   └── screening-sources.yaml
│
├── backend/
│   ├── package.json
│   ├── jsconfig.json
│   ├── Dockerfile
│   ├── src/
│   │   ├── index.js
│   │   ├── llm/
│   │   │   ├── types.js
│   │   │   ├── llm-service.js
│   │   │   ├── providers/
│   │   │   │   ├── ollama.js
│   │   │   │   ├── vllm.js
│   │   │   │   ├── openai-compatible.js
│   │   │   │   ├── anthropic.js
│   │   │   │   └── openai.js
│   │   │   └── prompt-adapters/
│   │   │       ├── mistral.js
│   │   │       ├── llama.js
│   │   │       └── default.js
│   │   ├── data-sources/
│   │   │   ├── types.js
│   │   │   ├── cache.js
│   │   │   ├── registry/
│   │   │   │   ├── types.js
│   │   │   │   ├── companies-house.js
│   │   │   │   └── sec-edgar.js
│   │   │   ├── screening/
│   │   │   │   ├── types.js
│   │   │   │   ├── ofac.js
│   │   │   │   ├── uk-hmt.js
│   │   │   │   ├── un-consolidated.js
│   │   │   │   └── fuzzy-matcher.js
│   │   │   └── media/
│   │   │       ├── types.js
│   │   │       └── news-search.js
│   │   ├── agents/
│   │   │   ├── types.js
│   │   │   ├── base-agent.js
│   │   │   ├── orchestrator.js
│   │   │   ├── decision-fragment.js
│   │   │   ├── entity-resolution/
│   │   │   │   ├── agent.js
│   │   │   │   └── prompts.js
│   │   │   ├── ownership-ubo/
│   │   │   │   ├── agent.js
│   │   │   │   └── prompts.js
│   │   │   ├── screening/
│   │   │   │   ├── agent.js
│   │   │   │   └── prompts.js
│   │   │   ├── document-analysis/
│   │   │   │   ├── agent.js
│   │   │   │   └── prompts.js
│   │   │   ├── risk-assessment/
│   │   │   │   ├── agent.js
│   │   │   │   └── prompts.js
│   │   │   └── qa/
│   │   │       ├── agent.js
│   │   │       └── prompts.js
│   │   ├── services/
│   │   │   ├── case-management.js
│   │   │   ├── document-service.js
│   │   │   ├── rule-engine.js
│   │   │   ├── event-store.js
│   │   │   └── auth-service.js
│   │   ├── api/
│   │   │   ├── cases.js
│   │   │   ├── review.js
│   │   │   ├── config.js
│   │   │   ├── admin.js
│   │   │   ├── auth.js
│   │   │   └── websocket.js
│   │   ├── db/
│   │   │   ├── init.sql
│   │   │   ├── migrations/
│   │   │   └── connection.js
│   │   └── workers/
│   │       ├── agent-worker.js
│   │       └── screening-sync.js
│   └── tests/
│       ├── agents/
│       ├── services/
│       └── integration/
│
├── frontend/
│   ├── package.json
│   ├── jsconfig.json
│   ├── vite.config.js
│   ├── Dockerfile
│   ├── src/
│   │   ├── main.js
│   │   ├── App.vue
│   │   ├── router/
│   │   │   └── index.js
│   │   ├── stores/
│   │   │   ├── cases.js
│   │   │   ├── review.js
│   │   │   ├── auth.js
│   │   │   └── websocket.js
│   │   ├── views/
│   │   │   ├── DashboardView.vue
│   │   │   ├── CaseDetailView.vue
│   │   │   ├── ReviewView.vue
│   │   │   ├── ConfigView.vue
│   │   │   └── LoginView.vue
│   │   ├── components/
│   │   │   ├── cases/
│   │   │   │   ├── CaseCard.vue
│   │   │   │   ├── CaseKanban.vue
│   │   │   │   └── NewCaseDialog.vue
│   │   │   ├── entity/
│   │   │   │   ├── EntityProfile.vue
│   │   │   │   └── OfficersTable.vue
│   │   │   ├── ownership/
│   │   │   │   ├── OwnershipTree.vue
│   │   │   │   └── OwnershipNode.vue
│   │   │   ├── screening/
│   │   │   │   ├── ScreeningResults.vue
│   │   │   │   ├── ScreeningHitCard.vue
│   │   │   │   └── AdverseMediaCard.vue
│   │   │   ├── documents/
│   │   │   │   ├── DocumentUpload.vue
│   │   │   │   └── DocumentVerification.vue
│   │   │   ├── risk/
│   │   │   │   ├── RiskScorecard.vue
│   │   │   │   └── RiskNarrative.vue
│   │   │   ├── review/
│   │   │   │   ├── ReviewPanel.vue
│   │   │   │   └── FragmentReview.vue
│   │   │   ├── audit/
│   │   │   │   └── AuditTimeline.vue
│   │   │   └── common/
│   │   │       ├── AgentProgress.vue
│   │   │       └── DecisionFragmentBadge.vue
│   │   ├── composables/
│   │   │   ├── useCase.js
│   │   │   ├── useWebSocket.js
│   │   │   └── useAuth.js
│   │   └── types/
│   │       └── index.js
│   └── tests/
│       └── components/
│
└── docs/
    ├── architecture.md
    ├── api-reference.md
    ├── deployment-guide.md
    ├── agent-development-guide.md
    └── configuration-guide.md
```

---

## 12. MVP Phasing

### Phase 1 — Foundation (Months 1-2)

- [ ] Docker Compose setup with all infrastructure services
- [ ] LLM abstraction layer with Ollama provider
- [ ] Companies House data source integration
- [ ] Entity Resolution Agent (all steps)
- [ ] Decision fragment store and event logging
- [ ] Basic API endpoints (cases CRUD, fragments)
- [ ] OFAC SDN and UK HMT screening list ingestion
- [ ] Screening Agent (sanctions only, no adverse media yet)
- [ ] Basic Vue.js frontend: case creation, case list, entity profile display

### Phase 2 — Intelligence (Months 3-4)

- [ ] Ownership & UBO Mapping Agent
- [ ] Adverse media screening (news API + LLM analysis)
- [ ] Document Analysis Agent (PDF extraction + cross-referencing)
- [ ] Risk Assessment Agent with configurable rule engine
- [ ] Narrative generation
- [ ] Ownership tree visualization (Vue Flow)
- [ ] Screening results UI with hit/dismiss reasoning
- [ ] Risk scorecard and narrative display
- [ ] WebSocket real-time updates

### Phase 3 — Review & Polish (Months 5-6)

- [ ] QA Agent for low-risk cases
- [ ] Human review interface with fragment-level overrides
- [ ] Review workflow (approve, reject, escalate, request info)
- [ ] Full audit trail UI with export capability
- [ ] Configuration UI (risk rules, LLM settings, data sources)
- [ ] Authentication and role-based access control
- [ ] Dashboard with case analytics and KPIs
- [ ] Performance optimization and stress testing
- [ ] Demo environment with sample data
- [ ] Documentation and deployment guide

---

## 13. Key Technical Decisions & Rationale

| Decision | Choice | Rationale |
|----------|--------|-----------|
| LLM approach | Open-source first, pluggable | Cost control, data sovereignty, client trust in regulated markets |
| LLM runtime | Ollama (default) | Zero-config, runs on CPU and GPU, large model library, active community |
| Backend language | JavaScript / Node.js | Founder expertise, shared language with frontend, large ecosystem, fast iteration |
| Type safety approach | JSDoc + Joi/Zod runtime validation | Full editor support (autocomplete, type checking) without a compile step; runtime validation catches malformed data at API and service boundaries |
| API framework | Fastify | Performance (2x Express), built-in JSON schema validation, strong JavaScript support |
| Frontend framework | Vue.js 3 + JavaScript | Founder preference, Composition API suits complex state, strong European community |
| Database | PostgreSQL | Robust JSONB support for agent outputs, mature, reliable, free |
| Job queue | BullMQ (Redis) | Battle-tested Node.js job queue, priorities, retries, delayed jobs, dashboard |
| Document storage | MinIO | S3-compatible, self-hosted, no cloud dependency |
| Agent framework | Custom (not LangChain) | Full control over audit trail, prompt management, and LLM abstraction |
| Deployment | Docker Compose | Single-command deployment, portable, works on any Linux server |
| Screening data | Locally cached lists | No external API calls during screening = faster + auditable + offline capable |
| Event storage | Append-only PostgreSQL | Simple, auditable, queryable, no additional infrastructure needed |

---

## 14. Future Considerations (Post-MVP)

- **Multi-jurisdiction support**: Add registries for EU member states, APAC jurisdictions
- **Orbis/BvD integration**: Premium corporate data for global ownership tracing
- **PEP database integration**: Commercial PEP databases (Dow Jones, Refinitiv)
- **Ongoing monitoring**: Automated periodic re-screening and trigger-event monitoring
- **Batch processing**: Bulk onboarding for portfolio KYC remediation projects
- **API-first onboarding**: Embed KYC Agent into client onboarding flows via API
- **Fine-tuned models**: Train specialized models on KYC decision data for improved accuracy
- **Multi-tenancy**: Support multiple clients on a single deployment (SaaS mode)
- **Kubernetes deployment**: Helm charts for enterprise-grade orchestration
- **SOC 2 / ISO 27001**: Security certifications for enterprise sales
