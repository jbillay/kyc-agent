# Entity Resolution Agent — Search and Candidate Evaluation

> GitHub Issue: [#27](https://github.com/jbillay/kyc-agent/issues/27)
> Epic: Entity Resolution Agent (#26)
> Size: L (3-5 days) | Priority: Critical

## Context

The first half of the Entity Resolution Agent. Given a client name (e.g., "Barclays Bank") and optional identifiers (registration number, jurisdiction), this story covers searching the corporate registry, using an LLM to evaluate and rank candidate matches, and selecting the best match. If confidence is below threshold, the agent flags the case for human review rather than risking a wrong match.

## Requirements

### Functional

1. `EntityResolutionAgent` extends `BaseAgent`
2. Step `search_registry`: queries Companies House with entity name and optional identifiers, retrieves top 10 candidates
3. Step `evaluate_candidates`: LLM evaluates each candidate considering name similarity, jurisdiction, registration number, incorporation date, entity type — produces ranked list with confidence scores
4. Step `select_best_match`: selects highest-confidence match if above threshold (configurable, default 80%); below threshold → decision fragment flagging for human review
5. Decision fragments: `entity_match` with confidence score and reasoning
6. Handles ambiguity: multiple similar companies, dissolved vs active variants
7. Handles no results: `entity_match` fragment with 0 confidence and explanation
8. Prompt templates stored in `prompts.js`

### Non-Functional

- Search + evaluation completes in under 30 seconds (including LLM call)
- LLM prompt is model-agnostic (uses prompt adaptation layer)
- Candidate evaluation is deterministic with temperature 0.1

## Technical Design

### File: `backend/src/agents/entity-resolution/index.js`

```javascript
const { BaseAgent } = require('../base-agent');
const { FragmentType } = require('../decision-fragment');
const { prompts } = require('./prompts');

/**
 * Entity Resolution Agent.
 *
 * Resolves a client name to a verified entity in a corporate registry.
 *
 * Steps:
 *   1. search_registry — query registry with name + identifiers
 *   2. evaluate_candidates — LLM ranks matches with confidence
 *   3. select_best_match — pick top match or flag for review
 *   4. extract_entity_details — pull full profile (Story #28)
 *   5. extract_officers — pull directors/officers (Story #28)
 *   6. extract_shareholders — pull PSC register (Story #28)
 *   7. validate_entity — LLM red flag check (Story #28)
 */
class EntityResolutionAgent extends BaseAgent {
  /**
   * @param {Object} deps
   * @param {import('../../data-sources/registry-factory').RegistryFactory} deps.registryFactory
   * @param {import('../../llm/llm-service').LLMService} deps.llmService
   * @param {Object} [deps.config]
   * @param {number} [deps.config.confidenceThreshold=80]
   * @param {number} [deps.config.maxCandidates=10]
   */
  constructor(deps) {
    super('entity-resolution', [
      'search_registry',
      'evaluate_candidates',
      'select_best_match',
      'extract_entity_details',
      'extract_officers',
      'extract_shareholders',
      'validate_entity',
    ]);

    this.registryFactory = deps.registryFactory;
    this.llmService = deps.llmService;
    this.confidenceThreshold = deps.config?.confidenceThreshold || 80;
    this.maxCandidates = deps.config?.maxCandidates || 10;

    // Shared state across steps within a single execution
    this._candidates = [];
    this._selectedMatch = null;
    this._entityProfile = null;
  }

  /**
   * @override
   */
  async executeStep(stepName, context, previousSteps) {
    switch (stepName) {
      case 'search_registry':
        return this._searchRegistry(context);
      case 'evaluate_candidates':
        return this._evaluateCandidates(context);
      case 'select_best_match':
        return this._selectBestMatch(context);
      case 'extract_entity_details':
        return this._extractEntityDetails(context);
      case 'extract_officers':
        return this._extractOfficers(context);
      case 'extract_shareholders':
        return this._extractShareholders(context);
      case 'validate_entity':
        return this._validateEntity(context);
      default:
        throw new Error(`Unknown step: ${stepName}`);
    }
  }

  /**
   * @override
   */
  async compileOutput(context, steps, fragments) {
    return this._entityProfile || { error: 'Entity resolution did not complete' };
  }

  // ─── Step Implementations ─────────────────────────

  /**
   * Step 1: Search the corporate registry.
   */
  async _searchRegistry(context) {
    const provider = this.registryFactory.getProvider(context.jurisdiction);

    const query = {
      name: context.entityName,
      jurisdiction: context.jurisdiction,
    };

    // If a registration number is known, include it
    if (context.existingData?.registrationNumber) {
      query.registrationNumber = context.existingData.registrationNumber;
    }

    this._candidates = await provider.searchEntity(query);

    return {
      description: `Searched ${provider.name} for "${context.entityName}" — found ${this._candidates.length} candidates`,
      decisionFragments: [],
      llmCalls: [],
    };
  }

  /**
   * Step 2: LLM evaluates candidates and assigns confidence scores.
   */
  async _evaluateCandidates(context) {
    if (this._candidates.length === 0) {
      return {
        description: 'No candidates to evaluate',
        decisionFragments: [{
          type: FragmentType.ENTITY_MATCH,
          decision: `No registry matches found for "${context.entityName}" in ${context.jurisdiction}`,
          confidence: 0,
          evidence: {
            dataSources: [this.registryFactory.getProvider(context.jurisdiction).name],
            dataPoints: [],
            llmReasoning: 'No results returned from registry search.',
          },
          status: 'pending_review',
        }],
        llmCalls: [],
      };
    }

    const prompt = prompts.evaluateCandidates({
      entityName: context.entityName,
      jurisdiction: context.jurisdiction,
      registrationNumber: context.existingData?.registrationNumber,
      candidates: this._candidates.map((c) => ({
        name: c.name,
        registrationNumber: c.registrationNumber,
        status: c.status,
        incorporationDate: c.incorporationDate,
        entityType: c.entityType,
      })),
    });

    const response = await this.llmService.complete({
      messages: prompt.messages,
      taskType: 'classification',
      structuredOutput: {
        name: 'candidate_evaluation',
        schema: {
          type: 'object',
          properties: {
            evaluations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  registrationNumber: { type: 'string' },
                  confidence: { type: 'number' },
                  reasoning: { type: 'string' },
                },
                required: ['registrationNumber', 'confidence', 'reasoning'],
              },
            },
          },
          required: ['evaluations'],
        },
      },
      temperature: 0.1,
      callContext: {
        caseId: context.caseId,
        agentType: 'entity-resolution',
        stepName: 'evaluate_candidates',
      },
    });

    const evaluations = response.structured?.evaluations || [];

    // Merge LLM evaluations back into candidates
    for (const evaluation of evaluations) {
      const candidate = this._candidates.find(
        (c) => c.registrationNumber === evaluation.registrationNumber
      );
      if (candidate) {
        candidate.confidence = evaluation.confidence;
        candidate.reasoning = evaluation.reasoning;
      }
    }

    // Sort by confidence descending
    this._candidates.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

    const fragments = this._candidates
      .filter((c) => c.confidence != null)
      .map((c) => ({
        type: FragmentType.ENTITY_MATCH,
        decision: `Candidate "${c.name}" (${c.registrationNumber}) evaluated with ${c.confidence}% confidence`,
        confidence: c.confidence,
        evidence: {
          dataSources: [this.registryFactory.getProvider(context.jurisdiction).name],
          dataPoints: [
            { source: 'registry', field: 'company_name', value: c.name, fetchedAt: new Date().toISOString() },
            { source: 'registry', field: 'registration_number', value: c.registrationNumber, fetchedAt: new Date().toISOString() },
            { source: 'registry', field: 'status', value: c.status, fetchedAt: new Date().toISOString() },
          ],
          llmReasoning: c.reasoning,
        },
        status: 'auto_approved',
      }));

    return {
      description: `Evaluated ${evaluations.length} candidates — top match: ${this._candidates[0]?.name} (${this._candidates[0]?.confidence}%)`,
      decisionFragments: fragments,
      llmCalls: [{ model: response.model, provider: response.provider, latencyMs: response.latencyMs }],
    };
  }

  /**
   * Step 3: Select the best match or flag for human review.
   */
  async _selectBestMatch(context) {
    const best = this._candidates[0];

    if (!best || (best.confidence || 0) < this.confidenceThreshold) {
      const confidence = best?.confidence || 0;
      return {
        description: `No match above ${this.confidenceThreshold}% threshold (best: ${confidence}%) — flagged for human review`,
        decisionFragments: [{
          type: FragmentType.ENTITY_MATCH,
          decision: `Unable to confidently resolve "${context.entityName}" — best candidate "${best?.name || 'none'}" scored ${confidence}%. Flagged for human review.`,
          confidence,
          evidence: {
            dataSources: [this.registryFactory.getProvider(context.jurisdiction).name],
            dataPoints: best ? [
              { source: 'registry', field: 'company_name', value: best.name, fetchedAt: new Date().toISOString() },
              { source: 'registry', field: 'registration_number', value: best.registrationNumber, fetchedAt: new Date().toISOString() },
            ] : [],
            llmReasoning: best?.reasoning || 'No candidates found.',
          },
          status: 'pending_review',
        }],
        llmCalls: [],
      };
    }

    this._selectedMatch = best;

    return {
      description: `Selected "${best.name}" (${best.registrationNumber}) with ${best.confidence}% confidence`,
      decisionFragments: [{
        type: FragmentType.ENTITY_MATCH,
        decision: `Resolved "${context.entityName}" to "${best.name}" (${best.registrationNumber}) with ${best.confidence}% confidence`,
        confidence: best.confidence,
        evidence: {
          dataSources: [this.registryFactory.getProvider(context.jurisdiction).name],
          dataPoints: [
            { source: 'registry', field: 'company_name', value: best.name, fetchedAt: new Date().toISOString() },
            { source: 'registry', field: 'registration_number', value: best.registrationNumber, fetchedAt: new Date().toISOString() },
            { source: 'registry', field: 'status', value: best.status, fetchedAt: new Date().toISOString() },
          ],
          llmReasoning: best.reasoning,
        },
        status: 'auto_approved',
      }],
      llmCalls: [],
    };
  }

  // Steps 4-7 implemented in Story #28 (detail-extraction/SPEC.md)
  async _extractEntityDetails(context) { /* Story #28 */ }
  async _extractOfficers(context) { /* Story #28 */ }
  async _extractShareholders(context) { /* Story #28 */ }
  async _validateEntity(context) { /* Story #28 */ }
}

module.exports = { EntityResolutionAgent };
```

### File: `backend/src/agents/entity-resolution/prompts.js`

```javascript
/**
 * Prompt templates for Entity Resolution Agent.
 *
 * Each function returns { messages: LLMMessage[] } ready for llmService.complete().
 */

const prompts = {
  /**
   * Evaluate registry search candidates against the target entity.
   *
   * @param {Object} params
   * @param {string} params.entityName - Target entity name
   * @param {string} params.jurisdiction - ISO 3166-1 alpha-2
   * @param {string} [params.registrationNumber] - Known registration number
   * @param {Array} params.candidates - Registry search results
   * @returns {{ messages: import('../../llm/types').LLMMessage[] }}
   */
  evaluateCandidates({ entityName, jurisdiction, registrationNumber, candidates }) {
    const candidateList = candidates.map((c, i) =>
      `${i + 1}. "${c.name}" — Reg: ${c.registrationNumber}, Status: ${c.status}, ` +
      `Inc: ${c.incorporationDate || 'unknown'}, Type: ${c.entityType || 'unknown'}`
    ).join('\n');

    const regNumberHint = registrationNumber
      ? `\nThe client's known registration number is: ${registrationNumber}. An exact match on registration number should receive very high confidence.`
      : '';

    return {
      messages: [
        {
          role: 'system',
          content: `You are a KYC entity resolution specialist. Your task is to evaluate corporate registry search results and determine which candidate is the best match for a target entity.

Evaluate each candidate based on:
- Name similarity (exact match, partial match, abbreviations, trading names)
- Company status (active companies are preferred over dissolved unless specifically looking for a dissolved entity)
- Registration number match (if provided — this is the strongest signal)
- Entity type appropriateness
- Jurisdiction match

For each candidate, provide:
- confidence: 0-100 score (100 = certain match, 0 = no match)
- reasoning: brief explanation of why this score was assigned

Guidelines:
- Exact name + active status → 95-100
- Close name variant + active → 80-95
- Name match but dissolved → 50-75 (lower because dissolved entities may be wrong match)
- Partial name match → 30-60
- Unrelated → 0-20
- Registration number match overrides name scoring → 98-100`,
        },
        {
          role: 'user',
          content: `Target entity: "${entityName}"
Jurisdiction: ${jurisdiction}${regNumberHint}

Registry search returned these candidates:
${candidateList}

Evaluate each candidate and return a JSON object with an "evaluations" array.`,
        },
      ],
    };
  },

  /**
   * Validate entity for red flags and consistency.
   *
   * @param {Object} params
   * @param {Object} params.entityDetails - Full entity profile
   * @param {Object} params.entityStatus - Status with overdue flags
   * @param {Array} params.filingHistory - Recent filings
   * @param {string} [params.declaredEntityType] - What the client declared
   * @returns {{ messages: import('../../llm/types').LLMMessage[] }}
   */
  validateEntity({ entityDetails, entityStatus, filingHistory, declaredEntityType }) {
    const recentFilings = filingHistory.slice(0, 10).map((f) =>
      `- ${f.date}: ${f.description} (${f.filingType})`
    ).join('\n');

    return {
      messages: [
        {
          role: 'system',
          content: `You are a KYC compliance analyst reviewing a company's registry data for red flags.

Check for:
1. Company status — is it active? If dissolved/liquidation/administration, flag it.
2. Overdue filings — are accounts or confirmation statements overdue?
3. Entity type consistency — does the registry entity type match what the client declared?
4. Filing history anomalies — any unusual patterns (long gaps, sudden flurry of changes)?
5. Active notices — gazette notices, compulsory strike-off proceedings?
6. Age and activity — newly incorporated with no filings may be a shell company indicator.

For each finding, provide:
- finding: description of what was found
- severity: "high", "medium", or "low"
- recommendation: what action should be taken

Return a JSON object with a "findings" array.`,
        },
        {
          role: 'user',
          content: `Entity: ${entityDetails.name} (${entityDetails.registrationNumber})
Status: ${entityDetails.status}
Incorporated: ${entityDetails.incorporationDate}
Entity Type: ${entityDetails.entityType}
${declaredEntityType ? `Client declared entity type: ${declaredEntityType}` : ''}

Accounts overdue: ${entityStatus.accountsOverdue ? 'YES' : 'No'}
Annual return overdue: ${entityStatus.annualReturnOverdue ? 'YES' : 'No'}
Active notices: ${entityStatus.activeNotices.length > 0 ? entityStatus.activeNotices.join(', ') : 'None'}

SIC Codes: ${entityDetails.sicCodes?.join(', ') || 'None'}
Previous Names: ${entityDetails.previousNames?.length > 0 ? entityDetails.previousNames.map((n) => n.name).join(', ') : 'None'}

Recent Filing History:
${recentFilings || 'No recent filings'}

Analyze this entity for KYC red flags and return your findings.`,
        },
      ],
    };
  },
};

module.exports = { prompts };
```

### File: `backend/src/agents/entity-resolution/entity-profile.js`

```javascript
/**
 * EntityProfile — the structured output of the Entity Resolution Agent.
 *
 * This is passed as context to downstream agents:
 * - Ownership/UBO Agent uses shareholders to begin tracing
 * - Screening Agent uses officers + shareholders for name screening
 * - Risk Assessment Agent uses everything for scoring
 *
 * @typedef {Object} EntityProfile
 * @property {string} registrationNumber
 * @property {string} name
 * @property {string} jurisdiction
 * @property {string} incorporationDate
 * @property {string} entityType
 * @property {string} status
 * @property {Object} registeredAddress
 * @property {string[]} sicCodes
 * @property {{ name: string, effectiveFrom: string, effectiveTo: string|null }[]} previousNames
 * @property {Officer[]} officers
 * @property {Shareholder[]} shareholders
 * @property {Filing[]} recentFilings
 * @property {EntityStatusDetail} statusDetail
 * @property {ValidationFinding[]} validationFindings
 * @property {number} matchConfidence - 0-100 from candidate evaluation
 * @property {string} matchReasoning - LLM reasoning for the match
 * @property {Object} rawData - Original registry responses for audit
 */

/**
 * @typedef {Object} ValidationFinding
 * @property {string} finding - Description
 * @property {'high'|'medium'|'low'} severity
 * @property {string} recommendation
 */

/**
 * @typedef {Object} EntityStatusDetail
 * @property {string} status
 * @property {boolean} accountsOverdue
 * @property {boolean} annualReturnOverdue
 * @property {string[]} activeNotices
 * @property {string} [dissolvedDate]
 */

module.exports = {};
```

### LLM Interaction Flow

```
Step 2: evaluate_candidates
  │
  ├── Build prompt with candidate list
  ├── LLM task type: classification
  ├── Structured output: { evaluations: [{ registrationNumber, confidence, reasoning }] }
  ├── Temperature: 0.1 (deterministic)
  │
  └── Response merged back into candidates → sorted by confidence

Step 7: validate_entity (Story #28)
  │
  ├── Build prompt with entity details, status, filings
  ├── LLM task type: reasoning
  ├── Structured output: { findings: [{ finding, severity, recommendation }] }
  ├── Temperature: 0.1
  │
  └── Each finding → decision fragment
```

### Confidence Threshold Decision

| Scenario | Best Confidence | Action |
|----------|----------------|--------|
| Exact match found | 95-100 | Auto-select, `auto_approved` |
| Strong match | 80-94 | Auto-select, `auto_approved` |
| Ambiguous | 50-79 | Flag for human review, `pending_review` |
| No good match | 0-49 | Flag for human review, `pending_review` |
| No candidates | 0 | Flag for human review, explain no results |

## Acceptance Criteria

- [ ] `EntityResolutionAgent` extends `BaseAgent`
- [ ] Step `search_registry`: queries Companies House with entity name and optional identifiers
- [ ] Step `evaluate_candidates`: LLM evaluates candidates with structured output (confidence + reasoning per candidate)
- [ ] Step `select_best_match`: selects highest-confidence match above threshold (default 80%)
- [ ] Below threshold → `entity_match` fragment with `pending_review` status
- [ ] No results → `entity_match` fragment with 0 confidence
- [ ] Decision fragments include evidence (data sources, data points, LLM reasoning)
- [ ] Prompt templates stored in separate `prompts.js` file
- [ ] LLM called with `classification` task type and temperature 0.1
- [ ] Handles dissolved vs active disambiguation
- [ ] Registration number match boosts confidence to 98-100
- [ ] Integration test with real Companies House data (search for "Barclays")

## Dependencies

- **Depends on**: #21 (BaseAgent), #22 (Decision fragments), #14 (RegistryProvider interface), #15 (Companies House provider), #8 (LLM service), #16 (Data caching)
- **Blocks**: #28 (Detail extraction — needs selected match)

## Testing Strategy

1. **Search — results found**: Mock registry returns 5 candidates, verify step completes with candidate list
2. **Search — no results**: Mock registry returns empty, verify 0-confidence fragment created
3. **Evaluate — structured output**: Mock LLM returns evaluations, verify candidates sorted by confidence
4. **Evaluate — LLM failure**: LLM throws error, verify step retried per BaseAgent config
5. **Select — above threshold**: Best candidate at 92%, verify auto-selected with `auto_approved`
6. **Select — below threshold**: Best candidate at 65%, verify flagged with `pending_review`
7. **Select — registration number match**: Candidate reg number matches input, verify 98%+ confidence
8. **Ambiguity**: Two candidates with similar names (one active, one dissolved), verify active preferred
9. **Prompt content**: Verify prompt includes entity name, jurisdiction, candidate list
10. **Evidence completeness**: Verify fragments include data source names, data points, LLM reasoning
11. **Integration**: Search Companies House for "Barclays", verify results include Barclays Bank PLC (01026167)
