# Risk Assessment Agent — Rule Engine, LLM Qualitative Analysis, and Review Path

> GitHub Issue: [#58](https://github.com/jbillay/kyc-agent/issues/58)
> Epic: Risk Assessment Agent (#56)
> Size: L (3-5 days) | Priority: Critical

## Context

The Risk Assessment Agent runs after all prior agents (entity resolution, ownership & UBO, screening, document analysis) have completed for a case. This story establishes the `RiskAssessmentAgent` class and implements five of its six steps: collecting inputs from prior agents, applying the configurable rule engine, running LLM qualitative analysis, calculating the final risk score and rating, and determining the review path. Step 5 (narrative generation) is covered in Story #59.

The rule engine reads `config/risk-rules.yaml` and applies additive scoring across five risk categories: country, industry, ownership, screening, and document analysis. Each rule match produces a `risk_factor_identified` decision fragment. The LLM then performs qualitative analysis to identify factors the rules cannot capture — unusual business patterns, contextual red flags, and mitigating factors. The combined score determines the risk rating (LOW / MEDIUM / HIGH / VERY_HIGH) and the review path (QA agent, human reviewer, or senior analyst).

## Requirements

### Functional

1. `RiskAssessmentAgent` extends `BaseAgent` with 6 step names: `collect_risk_inputs`, `apply_rule_engine`, `llm_risk_analysis`, `calculate_final_risk`, `generate_narrative`, `determine_review_path`
2. Agent receives a `caseId` in its context, retrieves all prior agent results from the `agent_results` table
3. Step `collect_risk_inputs`:
   - Queries `agent_results` for the case where `agent_type` IN (`entity-resolution`, `ownership-ubo`, `screening`, `document-analysis`)
   - Queries `decision_fragments` for the case to gather all existing fragments
   - Assembles a `RiskInputs` object containing:
     - `entityProfile`: resolved entity data (name, jurisdiction, SIC codes, incorporation date, registered address)
     - `ownershipData`: ownership tree, UBO list, complexity score, layer count, cross-border flag, nominee detection
     - `screeningResults`: sanctions hits (confirmed/dismissed), PEP matches, adverse media hits with severity
     - `documentAnalysis`: document verification statuses, discrepancies found
     - `fragments`: all decision fragments from prior agents
   - Gracefully handles missing agent outputs (e.g., no documents uploaded = empty `documentAnalysis`)
4. Step `apply_rule_engine`:
   - Loads `config/risk-rules.yaml` via the YAML config loader (from Epic #2)
   - Applies rules in order: country risk, industry risk, ownership risk, screening risk
   - **Country risk**: checks entity jurisdiction + ownership jurisdictions against `high_risk.countries` (+30) and `medium_risk.countries` (+15)
   - **Industry risk**: checks SIC codes against `high_risk.sic_codes` (+25) and `medium_risk.sic_codes` (+10); checks entity description / industry keywords against `high_risk.keywords` (+25) and `medium_risk.keywords` (+10)
   - **Ownership risk**: checks layer count against `layers_threshold` (+5 per extra layer), cross-border ownership (+10), opaque jurisdictions (+20), nominee detected (+15), no UBO identified (+25)
   - **Screening risk**: confirmed sanctions hit (+100, immediate), PEP identified (+20), adverse media per severity (high: +15, medium: +8, low: +3)
   - Each rule match produces a `risk_factor_identified` decision fragment with: the category, the specific rule triggered, the score addition, and evidence linking to the source data
   - Accumulates a `ruleScore` (sum of all additions, capped at 100) and a `scoreBreakdown` object with per-category subtotals
5. Step `llm_risk_analysis`:
   - Sends all collected inputs and rule engine results to the LLM with `reasoning` task type
   - Prompt instructs the LLM to identify factors that rules may miss:
     - Unusual business patterns (e.g., dormant company with sudden activity)
     - Contextual red flags (e.g., jurisdiction mismatch between registration and operations)
     - Mitigating factors (e.g., long-established company, publicly listed parent)
     - Overall coherence of the case (do all pieces fit together?)
   - LLM returns structured JSON with `additionalFactors[]` (each: description, impact: `increase`|`decrease`|`neutral`, severity: `high`|`medium`|`low`, reasoning)
   - Each factor with `increase` or `decrease` impact produces a `risk_factor_identified` decision fragment
   - LLM-identified factors do NOT modify the numeric score directly; they are qualitative annotations that inform the reviewer and may adjust the final rating in `calculate_final_risk`
6. Step `calculate_final_risk`:
   - Starts with `ruleScore` from step 2
   - Applies LLM adjustment: if LLM identified high-severity increase factors, adds up to +10; if LLM identified high-severity decrease factors, subtracts up to -10 (floor 0, cap 100)
   - Maps final score to rating using `thresholds` from YAML: low (0-25), medium (26-50), high (51-75), very_high (76-100)
   - Determines recommended due diligence level: `simplified` (low), `standard` (medium), `enhanced` (high or very_high)
   - Calculates overall confidence as the average confidence of all input decision fragments
   - Produces `risk_score_calculated` decision fragment with: final score, rating, score breakdown, DD level, confidence
7. Step `determine_review_path` (step 6 in the pipeline):
   - Applies review routing rules from YAML:
     - `qa_agent`: risk score ≤ 25 AND confidence ≥ 85
     - `senior_analyst`: risk score ≥ 51
     - `human_reviewer`: everything else
   - Updates the case's `review_path` field
   - Emits a WebSocket event with the review assignment
   - Does NOT produce a decision fragment (routing is a system decision, not an audit finding)

### Non-Functional

- Rule engine evaluation completes in under 100ms (pure computation, no I/O beyond initial YAML load)
- YAML config is loaded once at agent construction and cached; not re-read per step
- LLM qualitative analysis call completes within configured LLM timeout
- Graceful degradation: if LLM analysis fails, the agent continues with rule-engine-only score and logs a warning
- Score is always an integer 0-100; rating is always one of the four enum values

## Technical Design

### File: `backend/src/agents/risk-assessment/index.js`

```javascript
const { BaseAgent } = require('../base-agent');
const { FragmentType } = require('../decision-fragment');
const { collectRiskInputs } = require('./risk-input-collector');
const { RuleEngine } = require('./rule-engine');
const { analyzeLLMRisk } = require('./llm-risk-analyzer');
const { calculateFinalRisk } = require('./risk-calculator');
const { generateNarrative } = require('./narrative-generator');
const { determineReviewPath } = require('./review-router');

/**
 * Risk Assessment Agent.
 *
 * Synthesizes all prior agent outputs into a risk score and narrative.
 *
 * Steps:
 *   1. collect_risk_inputs — gather outputs from all prior agents
 *   2. apply_rule_engine — quantitative scoring via risk-rules.yaml
 *   3. llm_risk_analysis — qualitative analysis of factors rules miss
 *   4. calculate_final_risk — combine rule + LLM into final rating
 *   5. generate_narrative — LLM narrative with fragment refs (Story #59)
 *   6. determine_review_path — route case to QA, human, or senior
 */
class RiskAssessmentAgent extends BaseAgent {
  /**
   * @param {Object} deps
   * @param {import('../../llm/llm-service').LLMService} deps.llmService
   * @param {Object} deps.db - Database pool
   * @param {Object} deps.config - Loaded risk-rules.yaml config
   * @param {import('../../services/event-store').EventStore} deps.eventStore
   * @param {import('socket.io').Server} deps.io - Socket.io server for WebSocket events
   */
  constructor(deps) {
    super('risk-assessment', [
      'collect_risk_inputs',
      'apply_rule_engine',
      'llm_risk_analysis',
      'calculate_final_risk',
      'generate_narrative',
      'determine_review_path',
    ]);

    this.llmService = deps.llmService;
    this.db = deps.db;
    this.ruleEngine = new RuleEngine(deps.config.risk_rules);
    this.eventStore = deps.eventStore;
    this.io = deps.io;

    // Shared state across steps
    this._riskInputs = null;
    this._ruleResults = null;
    this._llmAnalysis = null;
    this._finalRisk = null;
    this._narrative = null;
    this._reviewPath = null;
  }

  /** @override */
  async executeStep(stepName, context, previousSteps) {
    switch (stepName) {
      case 'collect_risk_inputs':
        return this._collectRiskInputs(context);
      case 'apply_rule_engine':
        return this._applyRuleEngine(context);
      case 'llm_risk_analysis':
        return this._llmRiskAnalysis(context);
      case 'calculate_final_risk':
        return this._calculateFinalRisk(context);
      case 'generate_narrative':
        return this._generateNarrative(context);
      case 'determine_review_path':
        return this._determineReviewPath(context);
      default:
        throw new Error(`Unknown step: ${stepName}`);
    }
  }

  /** @override */
  async compileOutput(context, steps, fragments) {
    return {
      caseId: context.caseId,
      riskScore: this._finalRisk?.score,
      riskRating: this._finalRisk?.rating,
      scoreBreakdown: this._finalRisk?.scoreBreakdown,
      llmFactors: this._llmAnalysis?.additionalFactors || [],
      recommendedDDLevel: this._finalRisk?.ddLevel,
      confidence: this._finalRisk?.confidence,
      narrative: this._narrative,
      reviewPath: this._reviewPath,
    };
  }

  // ─── Step 1: Collect Risk Inputs ──────────

  async _collectRiskInputs(context) {
    const caseId = context.caseId;
    if (!caseId) {
      throw new Error('caseId not found in context — cannot assess risk');
    }

    this._riskInputs = await collectRiskInputs(this.db, caseId);

    const agentCount = [
      this._riskInputs.entityProfile,
      this._riskInputs.ownershipData,
      this._riskInputs.screeningResults,
      this._riskInputs.documentAnalysis,
    ].filter(Boolean).length;

    return {
      description: `Collected risk inputs from ${agentCount} agent(s) and ${this._riskInputs.fragments.length} decision fragments`,
      decisionFragments: [],
      llmCalls: [],
    };
  }

  // ─── Step 2: Apply Rule Engine ──────────

  async _applyRuleEngine(context) {
    this._ruleResults = this.ruleEngine.evaluate(this._riskInputs);

    const fragments = this._ruleResults.factors.map((factor) => ({
      type: FragmentType.RISK_FACTOR_IDENTIFIED,
      decision: `${factor.category}: ${factor.description} (+${factor.scoreAddition})`,
      confidence: 95, // Rule-based = high confidence
      evidence: {
        dataSources: [factor.category],
        dataPoints: factor.evidence,
      },
      status: 'pending_review',
    }));

    return {
      description: `Rule engine scored ${this._ruleResults.ruleScore}/100 with ${this._ruleResults.factors.length} risk factor(s) across ${Object.keys(this._ruleResults.scoreBreakdown).length} categories`,
      decisionFragments: fragments,
      llmCalls: [],
    };
  }

  // ─── Step 3: LLM Risk Analysis ──────────

  async _llmRiskAnalysis(context) {
    try {
      this._llmAnalysis = await analyzeLLMRisk(
        this._riskInputs,
        this._ruleResults,
        this.llmService
      );
    } catch (err) {
      // Graceful degradation: continue with rule-engine-only score
      console.warn('LLM risk analysis failed, continuing with rule score only:', err.message);
      this._llmAnalysis = { additionalFactors: [], llmCall: null };

      return {
        description: 'LLM risk analysis skipped due to error — using rule engine score only',
        decisionFragments: [],
        llmCalls: [],
      };
    }

    const fragments = this._llmAnalysis.additionalFactors
      .filter((f) => f.impact !== 'neutral')
      .map((factor) => ({
        type: FragmentType.RISK_FACTOR_IDENTIFIED,
        decision: `LLM-identified: ${factor.description} (${factor.impact}, severity: ${factor.severity})`,
        confidence: 70, // LLM-derived = moderate confidence
        evidence: {
          dataSources: ['llm_analysis'],
          dataPoints: [
            { source: 'llm_analysis', field: 'reasoning', value: factor.reasoning, fetchedAt: new Date().toISOString() },
          ],
        },
        status: 'pending_review',
      }));

    return {
      description: `LLM identified ${this._llmAnalysis.additionalFactors.length} additional factor(s): ${fragments.length} with risk impact`,
      decisionFragments: fragments,
      llmCalls: this._llmAnalysis.llmCall ? [this._llmAnalysis.llmCall] : [],
    };
  }

  // ─── Step 4: Calculate Final Risk ──────────

  async _calculateFinalRisk(context) {
    this._finalRisk = calculateFinalRisk(
      this._ruleResults,
      this._llmAnalysis,
      this._riskInputs.fragments
    );

    return {
      description: `Final risk: ${this._finalRisk.rating} (score: ${this._finalRisk.score}/100, confidence: ${this._finalRisk.confidence}%, DD level: ${this._finalRisk.ddLevel})`,
      decisionFragments: [{
        type: FragmentType.RISK_SCORE_CALCULATED,
        decision: `Risk assessment complete: ${this._finalRisk.rating} (${this._finalRisk.score}/100). Recommended due diligence: ${this._finalRisk.ddLevel}`,
        confidence: this._finalRisk.confidence,
        evidence: {
          dataSources: ['rule_engine', 'llm_analysis'],
          dataPoints: [
            { source: 'rule_engine', field: 'rule_score', value: String(this._ruleResults.ruleScore), fetchedAt: new Date().toISOString() },
            { source: 'risk_calculator', field: 'final_score', value: String(this._finalRisk.score), fetchedAt: new Date().toISOString() },
            { source: 'risk_calculator', field: 'rating', value: this._finalRisk.rating, fetchedAt: new Date().toISOString() },
            ...Object.entries(this._finalRisk.scoreBreakdown).map(([cat, val]) => ({
              source: 'rule_engine', field: `category_${cat}`, value: String(val), fetchedAt: new Date().toISOString(),
            })),
          ],
        },
        status: 'pending_review',
      }],
      llmCalls: [],
    };
  }

  // Step 5 implemented in Story #59
  async _generateNarrative(context) { /* Story #59 */ }

  // ─── Step 6: Determine Review Path ──────────

  async _determineReviewPath(context) {
    this._reviewPath = determineReviewPath(
      this._finalRisk.score,
      this._finalRisk.confidence,
      this.ruleEngine.config.review_routing || this.ruleEngine.reviewRouting
    );

    // Update case review path in database
    await this.db.query(
      'UPDATE cases SET review_path = $1 WHERE id = $2',
      [this._reviewPath, context.caseId]
    );

    // Emit WebSocket event
    if (this.io) {
      this.io.to(`case:${context.caseId}`).emit('case:review-assigned', {
        caseId: context.caseId,
        reviewPath: this._reviewPath,
        riskRating: this._finalRisk.rating,
        riskScore: this._finalRisk.score,
      });
    }

    return {
      description: `Case routed to ${this._reviewPath} (score: ${this._finalRisk.score}, confidence: ${this._finalRisk.confidence}%)`,
      decisionFragments: [],
      llmCalls: [],
    };
  }
}

module.exports = { RiskAssessmentAgent };
```

### File: `backend/src/agents/risk-assessment/risk-input-collector.js`

```javascript
/**
 * @typedef {Object} RiskInputs
 * @property {Object|null} entityProfile - Entity resolution output
 * @property {Object|null} ownershipData - Ownership & UBO output
 * @property {Object|null} screeningResults - Screening agent output
 * @property {Object|null} documentAnalysis - Document analysis output
 * @property {Object[]} fragments - All decision fragments for the case
 */

/**
 * Collect all prior agent outputs for a case.
 *
 * @param {Object} db - Database pool
 * @param {string} caseId
 * @returns {Promise<RiskInputs>}
 */
async function collectRiskInputs(db, caseId) {
  // Fetch agent results
  const agentResultsQuery = await db.query(
    `SELECT agent_type, output FROM agent_results
     WHERE case_id = $1 AND status = 'completed'
     ORDER BY completed_at DESC`,
    [caseId]
  );

  const agentOutputs = {};
  for (const row of agentResultsQuery.rows) {
    // Take the most recent completed result per agent type
    if (!agentOutputs[row.agent_type]) {
      agentOutputs[row.agent_type] = row.output;
    }
  }

  // Fetch all decision fragments
  const fragmentsQuery = await db.query(
    `SELECT id, type, decision, confidence, evidence, status, created_at
     FROM decision_fragments
     WHERE case_id = $1
     ORDER BY created_at ASC`,
    [caseId]
  );

  return {
    entityProfile: agentOutputs['entity-resolution'] || null,
    ownershipData: agentOutputs['ownership-ubo'] || null,
    screeningResults: agentOutputs['screening'] || null,
    documentAnalysis: agentOutputs['document-analysis'] || null,
    fragments: fragmentsQuery.rows,
  };
}

module.exports = { collectRiskInputs };
```

### File: `backend/src/agents/risk-assessment/rule-engine.js`

```javascript
/**
 * @typedef {Object} RuleResult
 * @property {number} ruleScore - Total score from rules (0-100)
 * @property {Object} scoreBreakdown - Per-category subtotals
 * @property {Object[]} factors - Individual rule matches
 */

/**
 * Configurable risk scoring engine driven by risk-rules.yaml.
 */
class RuleEngine {
  /**
   * @param {Object} config - Parsed risk_rules section from risk-rules.yaml
   */
  constructor(config) {
    this.config = config;
  }

  /**
   * Evaluate risk inputs against all configured rules.
   *
   * @param {import('./risk-input-collector').RiskInputs} inputs
   * @returns {RuleResult}
   */
  evaluate(inputs) {
    const factors = [];
    const scoreBreakdown = {
      country: 0,
      industry: 0,
      ownership: 0,
      screening: 0,
    };

    // Country risk
    const countryFactors = this._evaluateCountryRisk(inputs);
    for (const f of countryFactors) {
      factors.push(f);
      scoreBreakdown.country += f.scoreAddition;
    }

    // Industry risk
    const industryFactors = this._evaluateIndustryRisk(inputs);
    for (const f of industryFactors) {
      factors.push(f);
      scoreBreakdown.industry += f.scoreAddition;
    }

    // Ownership risk
    const ownershipFactors = this._evaluateOwnershipRisk(inputs);
    for (const f of ownershipFactors) {
      factors.push(f);
      scoreBreakdown.ownership += f.scoreAddition;
    }

    // Screening risk
    const screeningFactors = this._evaluateScreeningRisk(inputs);
    for (const f of screeningFactors) {
      factors.push(f);
      scoreBreakdown.screening += f.scoreAddition;
    }

    const ruleScore = Math.min(100, Object.values(scoreBreakdown).reduce((a, b) => a + b, 0));

    return { ruleScore, scoreBreakdown, factors };
  }

  /**
   * Evaluate country risk from entity jurisdiction and ownership jurisdictions.
   * @param {Object} inputs
   * @returns {Object[]}
   */
  _evaluateCountryRisk(inputs) {
    const factors = [];
    const rules = this.config.country_risk;
    if (!rules || !inputs.entityProfile) return factors;

    const jurisdictions = new Set();

    // Entity jurisdiction
    const entityJurisdiction = inputs.entityProfile.jurisdiction;
    if (entityJurisdiction) jurisdictions.add(entityJurisdiction.toUpperCase());

    // Ownership jurisdictions
    if (inputs.ownershipData?.ownershipTree) {
      _extractJurisdictions(inputs.ownershipData.ownershipTree, jurisdictions);
    }

    for (const jurisdiction of jurisdictions) {
      if (rules.high_risk?.countries?.includes(jurisdiction)) {
        factors.push({
          category: 'country',
          description: `High-risk jurisdiction: ${jurisdiction}`,
          scoreAddition: rules.high_risk.score_addition,
          evidence: [
            { source: 'entity_profile', field: 'jurisdiction', value: jurisdiction, fetchedAt: new Date().toISOString() },
          ],
        });
      } else if (rules.medium_risk?.countries?.includes(jurisdiction)) {
        factors.push({
          category: 'country',
          description: `Medium-risk jurisdiction: ${jurisdiction}`,
          scoreAddition: rules.medium_risk.score_addition,
          evidence: [
            { source: 'entity_profile', field: 'jurisdiction', value: jurisdiction, fetchedAt: new Date().toISOString() },
          ],
        });
      }
    }

    return factors;
  }

  /**
   * Evaluate industry risk from SIC codes and keywords.
   * @param {Object} inputs
   * @returns {Object[]}
   */
  _evaluateIndustryRisk(inputs) {
    const factors = [];
    const rules = this.config.industry_risk;
    if (!rules || !inputs.entityProfile) return factors;

    const sicCodes = inputs.entityProfile.sicCodes || [];
    const description = (inputs.entityProfile.description || '').toLowerCase();

    // SIC code matching
    for (const sic of sicCodes) {
      if (rules.high_risk?.sic_codes?.includes(sic)) {
        factors.push({
          category: 'industry',
          description: `High-risk SIC code: ${sic}`,
          scoreAddition: rules.high_risk.score_addition,
          evidence: [
            { source: 'entity_profile', field: 'sic_code', value: sic, fetchedAt: new Date().toISOString() },
          ],
        });
      } else if (rules.medium_risk?.sic_codes?.includes(sic)) {
        factors.push({
          category: 'industry',
          description: `Medium-risk SIC code: ${sic}`,
          scoreAddition: rules.medium_risk.score_addition,
          evidence: [
            { source: 'entity_profile', field: 'sic_code', value: sic, fetchedAt: new Date().toISOString() },
          ],
        });
      }
    }

    // Keyword matching in entity description
    for (const keyword of (rules.high_risk?.keywords || [])) {
      if (description.includes(keyword.toLowerCase())) {
        factors.push({
          category: 'industry',
          description: `High-risk industry keyword: "${keyword}"`,
          scoreAddition: rules.high_risk.score_addition,
          evidence: [
            { source: 'entity_profile', field: 'description', value: keyword, fetchedAt: new Date().toISOString() },
          ],
        });
        break; // Only one keyword match per risk level
      }
    }

    for (const keyword of (rules.medium_risk?.keywords || [])) {
      if (description.includes(keyword.toLowerCase())) {
        factors.push({
          category: 'industry',
          description: `Medium-risk industry keyword: "${keyword}"`,
          scoreAddition: rules.medium_risk.score_addition,
          evidence: [
            { source: 'entity_profile', field: 'description', value: keyword, fetchedAt: new Date().toISOString() },
          ],
        });
        break;
      }
    }

    return factors;
  }

  /**
   * Evaluate ownership structure risk.
   * @param {Object} inputs
   * @returns {Object[]}
   */
  _evaluateOwnershipRisk(inputs) {
    const factors = [];
    const rules = this.config.ownership_risk;
    if (!rules || !inputs.ownershipData) return factors;

    const ownership = inputs.ownershipData;

    // Ownership layers
    const layerCount = ownership.layerCount || 0;
    const threshold = rules.layers_threshold || 3;
    if (layerCount > threshold) {
      const extraLayers = layerCount - threshold;
      factors.push({
        category: 'ownership',
        description: `Complex ownership: ${layerCount} layers (${extraLayers} above threshold)`,
        scoreAddition: extraLayers * (rules.score_per_extra_layer || 5),
        evidence: [
          { source: 'ownership_agent', field: 'layer_count', value: String(layerCount), fetchedAt: new Date().toISOString() },
        ],
      });
    }

    // Cross-border ownership
    if (ownership.crossBorder) {
      factors.push({
        category: 'ownership',
        description: 'Cross-border ownership structure detected',
        scoreAddition: rules.cross_border_addition || 10,
        evidence: [
          { source: 'ownership_agent', field: 'cross_border', value: 'true', fetchedAt: new Date().toISOString() },
        ],
      });
    }

    // Opaque jurisdictions in ownership chain
    if (ownership.opaqueJurisdictions?.length > 0) {
      factors.push({
        category: 'ownership',
        description: `Opaque jurisdiction(s) in ownership chain: ${ownership.opaqueJurisdictions.join(', ')}`,
        scoreAddition: rules.opaque_jurisdiction_addition || 20,
        evidence: [
          { source: 'ownership_agent', field: 'opaque_jurisdictions', value: ownership.opaqueJurisdictions.join(', '), fetchedAt: new Date().toISOString() },
        ],
      });
    }

    // Nominee detected
    if (ownership.nomineeDetected) {
      factors.push({
        category: 'ownership',
        description: 'Nominee shareholder or director detected',
        scoreAddition: rules.nominee_detected_addition || 15,
        evidence: [
          { source: 'ownership_agent', field: 'nominee_detected', value: 'true', fetchedAt: new Date().toISOString() },
        ],
      });
    }

    // No UBO identified
    if (!ownership.ubos || ownership.ubos.length === 0) {
      factors.push({
        category: 'ownership',
        description: 'No Ultimate Beneficial Owner (UBO) identified',
        scoreAddition: rules.no_ubo_identified_addition || 25,
        evidence: [
          { source: 'ownership_agent', field: 'ubo_count', value: '0', fetchedAt: new Date().toISOString() },
        ],
      });
    }

    return factors;
  }

  /**
   * Evaluate screening results risk.
   * @param {Object} inputs
   * @returns {Object[]}
   */
  _evaluateScreeningRisk(inputs) {
    const factors = [];
    const rules = this.config.screening_risk;
    if (!rules || !inputs.screeningResults) return factors;

    const screening = inputs.screeningResults;

    // Confirmed sanctions hit — immediate score 100
    if (screening.confirmedSanctionsHits?.length > 0) {
      factors.push({
        category: 'screening',
        description: `Confirmed sanctions hit(s): ${screening.confirmedSanctionsHits.length} match(es)`,
        scoreAddition: rules.confirmed_sanctions_hit || 100,
        evidence: screening.confirmedSanctionsHits.map((hit) => ({
          source: 'screening_agent', field: 'sanctions_hit', value: hit.listName || hit.name, fetchedAt: new Date().toISOString(),
        })),
      });
    }

    // PEP matches
    if (screening.pepMatches?.length > 0) {
      factors.push({
        category: 'screening',
        description: `Politically Exposed Person (PEP) match(es): ${screening.pepMatches.length}`,
        scoreAddition: rules.pep_identified || 20,
        evidence: screening.pepMatches.map((match) => ({
          source: 'screening_agent', field: 'pep_match', value: match.name || 'PEP identified', fetchedAt: new Date().toISOString(),
        })),
      });
    }

    // Adverse media
    const adverseMedia = screening.adverseMediaHits || [];
    for (const hit of adverseMedia) {
      const severity = hit.severity || 'low';
      const addition = rules.adverse_media_per_hit?.[`${severity}_severity`] || 3;
      factors.push({
        category: 'screening',
        description: `Adverse media (${severity}): ${hit.headline || hit.description || 'media hit'}`,
        scoreAddition: addition,
        evidence: [
          { source: 'screening_agent', field: 'adverse_media', value: hit.headline || hit.url || severity, fetchedAt: new Date().toISOString() },
        ],
      });
    }

    return factors;
  }
}

/**
 * Recursively extract jurisdictions from an ownership tree.
 * @param {Object} node
 * @param {Set<string>} jurisdictions
 */
function _extractJurisdictions(node, jurisdictions) {
  if (node.jurisdiction) {
    jurisdictions.add(node.jurisdiction.toUpperCase());
  }
  if (node.children) {
    for (const child of node.children) {
      _extractJurisdictions(child, jurisdictions);
    }
  }
}

module.exports = { RuleEngine, _extractJurisdictions };
```

### File: `backend/src/agents/risk-assessment/llm-risk-analyzer.js`

```javascript
const { prompts } = require('./prompts');

/**
 * @typedef {Object} LLMRiskAnalysis
 * @property {Object[]} additionalFactors - LLM-identified risk factors
 * @property {Object|null} llmCall - LLM call metadata for audit
 */

/**
 * Run LLM qualitative risk analysis.
 *
 * @param {import('./risk-input-collector').RiskInputs} inputs
 * @param {import('./rule-engine').RuleResult} ruleResults
 * @param {import('../../llm/llm-service').LLMService} llmService
 * @returns {Promise<LLMRiskAnalysis>}
 */
async function analyzeLLMRisk(inputs, ruleResults, llmService) {
  const response = await llmService.complete({
    taskType: 'reasoning',
    messages: [
      { role: 'system', content: prompts.qualitativeAnalysis() },
      { role: 'user', content: _buildAnalysisContext(inputs, ruleResults) },
    ],
  });

  const parsed = _parseAnalysisResponse(response.content);

  return {
    additionalFactors: parsed.additionalFactors,
    llmCall: {
      taskType: 'reasoning',
      model: response.model,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      durationMs: response.durationMs,
    },
  };
}

/**
 * Build context string for LLM analysis from all inputs.
 *
 * @param {Object} inputs
 * @param {Object} ruleResults
 * @returns {string}
 */
function _buildAnalysisContext(inputs, ruleResults) {
  const sections = [];

  sections.push('## Rule Engine Results');
  sections.push(`Score: ${ruleResults.ruleScore}/100`);
  sections.push(`Breakdown: ${JSON.stringify(ruleResults.scoreBreakdown)}`);
  sections.push(`Factors: ${ruleResults.factors.map((f) => f.description).join('; ')}`);

  if (inputs.entityProfile) {
    sections.push('\n## Entity Profile');
    sections.push(JSON.stringify(inputs.entityProfile, null, 2));
  }

  if (inputs.ownershipData) {
    sections.push('\n## Ownership Structure');
    sections.push(JSON.stringify(inputs.ownershipData, null, 2));
  }

  if (inputs.screeningResults) {
    sections.push('\n## Screening Results');
    sections.push(JSON.stringify(inputs.screeningResults, null, 2));
  }

  if (inputs.documentAnalysis) {
    sections.push('\n## Document Analysis');
    sections.push(JSON.stringify(inputs.documentAnalysis, null, 2));
  }

  return sections.join('\n');
}

/**
 * Parse LLM analysis response.
 * Expects JSON with additionalFactors array.
 *
 * @param {string} responseText
 * @returns {{ additionalFactors: Object[] }}
 */
function _parseAnalysisResponse(responseText) {
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const factors = (parsed.additionalFactors || []).map((f) => ({
        description: f.description || 'Unspecified factor',
        impact: ['increase', 'decrease', 'neutral'].includes(f.impact) ? f.impact : 'neutral',
        severity: ['high', 'medium', 'low'].includes(f.severity) ? f.severity : 'low',
        reasoning: f.reasoning || '',
      }));
      return { additionalFactors: factors };
    }
  } catch {
    // Fall through to default
  }

  return { additionalFactors: [] };
}

module.exports = { analyzeLLMRisk, _buildAnalysisContext, _parseAnalysisResponse };
```

### File: `backend/src/agents/risk-assessment/risk-calculator.js`

```javascript
/**
 * @typedef {Object} FinalRisk
 * @property {number} score - 0-100
 * @property {string} rating - low | medium | high | very_high
 * @property {Object} scoreBreakdown - Per-category subtotals
 * @property {string} ddLevel - simplified | standard | enhanced
 * @property {number} confidence - 0-100
 */

/**
 * Combine rule engine score and LLM analysis into a final risk assessment.
 *
 * @param {import('./rule-engine').RuleResult} ruleResults
 * @param {import('./llm-risk-analyzer').LLMRiskAnalysis} llmAnalysis
 * @param {Object[]} fragments - All prior decision fragments (for confidence calc)
 * @returns {FinalRisk}
 */
function calculateFinalRisk(ruleResults, llmAnalysis, fragments) {
  let score = ruleResults.ruleScore;

  // LLM adjustment: high-severity factors can shift score ±10
  const highIncreaseCount = llmAnalysis.additionalFactors
    .filter((f) => f.impact === 'increase' && f.severity === 'high').length;
  const highDecreaseCount = llmAnalysis.additionalFactors
    .filter((f) => f.impact === 'decrease' && f.severity === 'high').length;

  score += Math.min(10, highIncreaseCount * 5);
  score -= Math.min(10, highDecreaseCount * 5);
  score = Math.max(0, Math.min(100, score));

  // Map to rating
  const rating = _scoreToRating(score);

  // Recommended due diligence level
  const ddLevel = _ratingToDDLevel(rating);

  // Confidence: average of all prior fragment confidence values
  const confidences = fragments
    .filter((f) => typeof f.confidence === 'number')
    .map((f) => f.confidence);
  const confidence = confidences.length > 0
    ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
    : 50;

  return {
    score,
    rating,
    scoreBreakdown: ruleResults.scoreBreakdown,
    ddLevel,
    confidence,
  };
}

/**
 * Map numeric score to risk rating.
 * @param {number} score
 * @returns {string}
 */
function _scoreToRating(score) {
  if (score <= 25) return 'low';
  if (score <= 50) return 'medium';
  if (score <= 75) return 'high';
  return 'very_high';
}

/**
 * Map risk rating to recommended due diligence level.
 * @param {string} rating
 * @returns {string}
 */
function _ratingToDDLevel(rating) {
  switch (rating) {
    case 'low': return 'simplified';
    case 'medium': return 'standard';
    case 'high':
    case 'very_high': return 'enhanced';
    default: return 'standard';
  }
}

module.exports = { calculateFinalRisk, _scoreToRating, _ratingToDDLevel };
```

### File: `backend/src/agents/risk-assessment/review-router.js`

```javascript
/**
 * Determine the review path for a case based on risk score, confidence,
 * and review routing configuration from risk-rules.yaml.
 *
 * @param {number} score - Final risk score (0-100)
 * @param {number} confidence - Overall confidence (0-100)
 * @param {Object} routingConfig - review_routing section from risk-rules.yaml
 * @returns {string} One of: 'qa_agent', 'human_reviewer', 'senior_analyst'
 */
function determineReviewPath(score, confidence, routingConfig) {
  if (!routingConfig) {
    return 'human_reviewer';
  }

  // High risk → senior analyst
  const highRisk = routingConfig.high_risk;
  if (highRisk && score >= (highRisk.min_risk_score || 51)) {
    return highRisk.route || 'senior_analyst';
  }

  // Low risk + high confidence → QA agent
  const lowRiskHighConf = routingConfig.low_risk_high_confidence;
  if (lowRiskHighConf && score <= (lowRiskHighConf.max_risk_score || 25) && confidence >= (lowRiskHighConf.min_confidence || 85)) {
    return lowRiskHighConf.route || 'qa_agent';
  }

  // Everything else → human reviewer
  return routingConfig.standard?.route || 'human_reviewer';
}

module.exports = { determineReviewPath };
```

### File: `backend/src/agents/risk-assessment/prompts.js`

```javascript
const prompts = {
  /**
   * Prompt for qualitative risk analysis.
   * @returns {string}
   */
  qualitativeAnalysis() {
    return `You are a senior KYC risk analyst performing qualitative risk analysis. You have access to the full case data including entity profile, ownership structure, screening results, and document analysis.

The rule engine has already calculated a quantitative risk score. Your job is to identify factors that the rules may miss:

1. **Unusual business patterns** — dormant company with sudden activity, business type inconsistent with stated purpose, revenue inconsistent with company size
2. **Contextual red flags** — jurisdiction mismatch between registration and operations, shell company indicators, nominee structures, unusually complex arrangements for company size
3. **Mitigating factors** — long-established company, publicly listed parent, regulated industry membership, clean screening history, complete documentation
4. **Overall coherence** — do all the pieces fit together? Are there contradictions between different data sources?

Respond with a JSON object:
{
  "additionalFactors": [
    {
      "description": "<clear, concise description of the factor>",
      "impact": "<increase | decrease | neutral>",
      "severity": "<high | medium | low>",
      "reasoning": "<explanation of why this factor matters>"
    }
  ]
}

Rules:
- Only identify factors that the rule engine would NOT have captured
- Be specific — cite data from the case
- Keep the list focused: 3-8 factors maximum
- Do not invent or hallucinate data — only analyze what is present
- If nothing unusual is found, return an empty additionalFactors array`;
  },
};

module.exports = { prompts };
```

### Data Schemas

**`RiskAssessment` output** (stored in `agent_results.output` JSONB):

```json
{
  "caseId": "uuid",
  "riskScore": 42,
  "riskRating": "medium",
  "scoreBreakdown": {
    "country": 15,
    "industry": 10,
    "ownership": 10,
    "screening": 3
  },
  "llmFactors": [
    {
      "description": "Jurisdiction mismatch: registered in UK but operations in high-risk region",
      "impact": "increase",
      "severity": "medium",
      "reasoning": "..."
    }
  ],
  "recommendedDDLevel": "standard",
  "confidence": 78,
  "narrative": "...(from Story #59)",
  "reviewPath": "human_reviewer"
}
```

**`RiskInputs`** (internal, assembled in step 1):

```json
{
  "entityProfile": {
    "name": "Example Corp Ltd",
    "jurisdiction": "GB",
    "sicCodes": ["62020"],
    "description": "Software development",
    "incorporationDate": "2015-03-22",
    "registeredAddress": "..."
  },
  "ownershipData": {
    "ownershipTree": { "...": "..." },
    "ubos": [{ "name": "John Doe", "percentage": 75 }],
    "layerCount": 2,
    "crossBorder": false,
    "opaqueJurisdictions": [],
    "nomineeDetected": false,
    "complexityScore": "low"
  },
  "screeningResults": {
    "confirmedSanctionsHits": [],
    "dismissedSanctionsHits": [...],
    "pepMatches": [],
    "adverseMediaHits": [{ "severity": "low", "headline": "..." }]
  },
  "documentAnalysis": {
    "documents": [{ "type": "certificate_of_incorporation", "status": "verified" }],
    "discrepancies": []
  },
  "fragments": [...]
}
```

## Acceptance Criteria

- [ ] `RiskAssessmentAgent` extends `BaseAgent` with 6 step names
- [ ] Agent receives `caseId` in context and retrieves all prior agent results
- [ ] Step `collect_risk_inputs` gathers entity resolution, ownership, screening, and document analysis outputs
- [ ] Missing agent outputs handled gracefully (null, not error)
- [ ] Step `apply_rule_engine` loads `config/risk-rules.yaml` and applies all rule categories
- [ ] Country risk: checks entity + ownership jurisdictions against high/medium lists
- [ ] Industry risk: checks SIC codes and keywords against high/medium lists
- [ ] Ownership risk: layers threshold, cross-border, opaque jurisdictions, nominee, no UBO
- [ ] Screening risk: confirmed sanctions (+100), PEP (+20), adverse media by severity
- [ ] Each rule match produces a `risk_factor_identified` decision fragment with evidence
- [ ] Score accumulates additively, capped at 100
- [ ] Score breakdown stored per category
- [ ] Step `llm_risk_analysis` sends case data to LLM with `reasoning` task type
- [ ] LLM identifies unusual patterns, contextual red flags, mitigating factors, coherence
- [ ] LLM factors produce `risk_factor_identified` fragments (non-neutral only)
- [ ] LLM failure degrades gracefully to rule-engine-only scoring
- [ ] Step `calculate_final_risk` combines rule score + LLM adjustment (±10 max)
- [ ] Risk rating: low (0-25), medium (26-50), high (51-75), very_high (76-100)
- [ ] DD level: simplified (low), standard (medium), enhanced (high/very_high)
- [ ] Confidence calculated as average of all input fragment confidences
- [ ] `risk_score_calculated` decision fragment produced with full breakdown
- [ ] Step `determine_review_path` applies routing rules from YAML
- [ ] Review paths: qa_agent (≤25 score + ≥85 confidence), senior_analyst (≥51 score), human_reviewer (default)
- [ ] Case `review_path` updated in database
- [ ] WebSocket event emitted with review assignment
- [ ] LLM calls recorded for audit trail

## Dependencies

- **Depends on**: #21 (BaseAgent), #22 (Decision Fragments — `risk_factor_identified`, `risk_score_calculated` types), #25 (Event Store), #8 (LLM Service — reasoning task type), #12 (YAML config loader), #3 (Database — agent_results, decision_fragments tables), #36 (WebSocket events)
- **Blocks**: #59 (Narrative generation — needs `_finalRisk` and `_riskInputs`), #60 (Frontend — needs RiskAssessment output shape)
- **Soft dependency on**: #26 (Entity Resolution), #43 (Ownership & UBO), #30 (Screening), #52 (Document Analysis) — these provide the inputs, but their outputs may be partially available

## Testing Strategy

1. **Full pipeline — low risk**: Case with clean entity (GB jurisdiction, software SIC, 1-layer ownership, no screening hits) → score ≤ 25, rating low, route qa_agent
2. **Full pipeline — high risk**: Case with high-risk jurisdiction (IR), sanctions hit → score 100, rating very_high, route senior_analyst
3. **Country risk — high**: Entity jurisdiction in high-risk list → +30 scored
4. **Country risk — medium**: Entity jurisdiction in medium-risk list → +15 scored
5. **Country risk — ownership jurisdictions**: Ownership tree contains high-risk jurisdiction → +30 scored
6. **Industry risk — SIC code match**: SIC code 64205 → +25 scored
7. **Industry risk — keyword match**: Description contains "cryptocurrency" → +25 scored
8. **Ownership risk — deep layers**: 5 layers with threshold 3 → +10 (2 × 5)
9. **Ownership risk — cross-border**: crossBorder flag → +10
10. **Ownership risk — no UBO**: Empty UBO list → +25
11. **Ownership risk — nominee**: nomineeDetected flag → +15
12. **Screening risk — sanctions**: Confirmed sanctions hit → +100 (capped)
13. **Screening risk — PEP**: PEP match → +20
14. **Screening risk — adverse media**: One high + one low severity → +15 + +3
15. **Score capping**: Multiple risk factors totaling >100 → capped at 100
16. **LLM analysis — additional factors**: LLM returns increase factors → `risk_factor_identified` fragments created
17. **LLM analysis — mitigating factors**: LLM returns decrease factor → score adjusted down (max -10)
18. **LLM analysis — failure**: LLM throws error → agent continues with rule score, warning logged
19. **LLM response parsing**: Valid JSON → factors extracted; malformed JSON → empty factors array
20. **Final risk calculation**: Rule score 38 + 1 high-increase LLM factor → score 43, medium
21. **Confidence calculation**: Fragments with confidences [90, 80, 70] → confidence 80
22. **Review routing — qa_agent**: Score 20 + confidence 90 → qa_agent
23. **Review routing — senior_analyst**: Score 55 + any confidence → senior_analyst
24. **Review routing — human_reviewer**: Score 35 + confidence 70 → human_reviewer
25. **Missing agent outputs**: No document analysis output → documentAnalysis is null, no ownership rules fire for it
26. **Missing caseId**: No caseId in context → error thrown
27. **WebSocket emission**: After review path determined → event emitted on `case:{caseId}` room
28. **Database update**: After review path determined → `cases.review_path` updated
