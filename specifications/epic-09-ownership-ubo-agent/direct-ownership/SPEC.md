# Ownership & UBO Agent — Direct Ownership Analysis

> GitHub Issue: [#44](https://github.com/jbillay/kyc-agent/issues/44)
> Epic: Ownership & UBO Mapping Agent (#43)
> Size: M (1-3 days) | Priority: Critical

## Context

Before tracing can begin, the agent must classify the direct shareholders from the Entity Resolution Agent's output. Each shareholder/PSC entry is classified as individual or corporate, with ownership percentage extracted (handling Companies House's range-based format). Corporate shareholders are flagged for recursive tracing in the next step. This step establishes the `OwnershipUBOAgent` class with its 6-step pipeline.

## Requirements

### Functional

1. `OwnershipUBOAgent` extends `BaseAgent` with 6 step names
2. Step `analyze_direct_ownership`: takes shareholder/PSC list from EntityProfile
3. Classifies each shareholder as individual or corporate
4. Records direct ownership percentage, handling Companies House PSC ranges ("25-50%", "75% or more")
5. Records nature of control statements
6. Decision fragment `shareholder_identified` for each direct shareholder
7. Produces structured list of corporate shareholders requiring further tracing

### Non-Functional

- Step completes in under 1 second (no external calls, data already in context)

## Technical Design

### File: `backend/src/agents/ownership-ubo/index.js`

```javascript
const { BaseAgent } = require('../base-agent');
const { FragmentType } = require('../decision-fragment');
const { analyzeDirectOwnership } = require('./direct-ownership');
const { prompts } = require('./prompts');

/**
 * Ownership & UBO Mapping Agent.
 *
 * Traces ownership chains from direct shareholders to ultimate beneficial
 * owners. Runs in PARALLEL_1 alongside Screening after Entity Resolution.
 *
 * Steps:
 *   1. analyze_direct_ownership — classify direct shareholders
 *   2. trace_corporate_shareholders — recursive registry lookups
 *   3. calculate_indirect_ownership — multiply percentages through chains
 *   4. identify_ubos — flag individuals above UBO threshold
 *   5. assess_structure_complexity — LLM evaluates structure risk
 *   6. generate_ownership_tree — produce tree JSON for visualization
 */
class OwnershipUBOAgent extends BaseAgent {
  /**
   * @param {Object} deps
   * @param {import('../../data-sources/registry').RegistryFactory} deps.registryFactory
   * @param {import('../../llm/llm-service').LLMService} deps.llmService
   * @param {Object} [deps.config]
   * @param {number} [deps.config.uboThreshold=25]
   * @param {number} [deps.config.tracingThreshold=10]
   * @param {number} [deps.config.maxDepth=10]
   */
  constructor(deps) {
    super('ownership-ubo', [
      'analyze_direct_ownership',
      'trace_corporate_shareholders',
      'calculate_indirect_ownership',
      'identify_ubos',
      'assess_structure_complexity',
      'generate_ownership_tree',
    ]);

    this.registryFactory = deps.registryFactory;
    this.llmService = deps.llmService;
    this.uboThreshold = deps.config?.uboThreshold || 25;
    this.tracingThreshold = deps.config?.tracingThreshold || 10;
    this.maxDepth = deps.config?.maxDepth || 10;

    // Shared state across steps
    this._directShareholders = [];
    this._corporateToTrace = [];
    this._ownershipChains = [];     // Full traced chains
    this._deadEnds = [];            // Entities that couldn't be traced further
    this._indirectOwnerships = [];  // Calculated indirect percentages
    this._ubos = [];                // Identified UBOs
    this._complexityAssessment = null;
    this._ownershipTree = null;
  }

  /** @override */
  async executeStep(stepName, context, previousSteps) {
    switch (stepName) {
      case 'analyze_direct_ownership':
        return this._analyzeDirectOwnership(context);
      case 'trace_corporate_shareholders':
        return this._traceCorporateShareholders(context);
      case 'calculate_indirect_ownership':
        return this._calculateIndirectOwnership(context);
      case 'identify_ubos':
        return this._identifyUBOs(context);
      case 'assess_structure_complexity':
        return this._assessStructureComplexity(context);
      case 'generate_ownership_tree':
        return this._generateOwnershipTree(context);
      default:
        throw new Error(`Unknown step: ${stepName}`);
    }
  }

  /** @override */
  async compileOutput(context, steps, fragments) {
    return {
      tree: this._ownershipTree,
      ubos: this._ubos,
      deadEnds: this._deadEnds,
      complexityAssessment: this._complexityAssessment,
      directShareholders: this._directShareholders,
      chains: this._ownershipChains,
    };
  }

  // ─── Step 1: Analyze Direct Ownership ──────────

  async _analyzeDirectOwnership(context) {
    const entityProfile = context.existingData?.['entity-resolution'];

    if (!entityProfile) {
      throw new Error('Entity Resolution output not found in context — cannot analyze ownership');
    }

    const result = analyzeDirectOwnership(entityProfile, {
      tracingThreshold: this.tracingThreshold,
    });

    this._directShareholders = result.shareholders;
    this._corporateToTrace = result.corporateToTrace;

    return {
      description: `Analyzed ${result.shareholders.length} direct shareholders: ${result.individuals} individuals, ${result.corporates} corporate (${result.corporateToTrace.length} to trace)`,
      decisionFragments: result.fragments,
      llmCalls: [],
    };
  }

  // Steps 2-6 implemented in Stories #45, #46, #47
  async _traceCorporateShareholders(context) { /* Story #45 */ }
  async _calculateIndirectOwnership(context) { /* Story #46 */ }
  async _identifyUBOs(context) { /* Story #46 */ }
  async _assessStructureComplexity(context) { /* Story #47 */ }
  async _generateOwnershipTree(context) { /* Story #47 */ }
}

module.exports = { OwnershipUBOAgent };
```

### File: `backend/src/agents/ownership-ubo/direct-ownership.js`

```javascript
const { FragmentType } = require('../decision-fragment');

/**
 * @typedef {Object} DirectShareholder
 * @property {string} name
 * @property {'individual'|'corporate'} entityType
 * @property {number} ownershipPercentage - Numeric percentage (midpoint for ranges)
 * @property {string} ownershipRange - Original range string from registry
 * @property {string[]} naturesOfControl
 * @property {string} [nationality]
 * @property {string} [countryOfResidence]
 * @property {string} [registrationNumber] - For corporate shareholders
 * @property {string} [jurisdiction] - For corporate shareholders
 * @property {boolean} requiresTracing - True if corporate and above threshold
 */

/**
 * Analyze direct shareholders from EntityProfile.
 *
 * Classifies each PSC/shareholder as individual or corporate,
 * parses ownership percentage ranges, and identifies corporate
 * entities requiring recursive tracing.
 *
 * @param {Object} entityProfile
 * @param {Object} config
 * @param {number} config.tracingThreshold - Min % to trigger tracing (default 10)
 * @returns {{ shareholders: DirectShareholder[], corporateToTrace: DirectShareholder[], individuals: number, corporates: number, fragments: Object[] }}
 */
function analyzeDirectOwnership(entityProfile, config) {
  const shareholders = [];
  const corporateToTrace = [];
  const fragments = [];

  const currentShareholders = (entityProfile.shareholders || []).filter((s) => !s.ceasedDate);

  for (const sh of currentShareholders) {
    const entityType = _classifyEntityType(sh);
    const ownershipPercentage = _parseOwnershipPercentage(sh.ownershipPercentage);
    const ownershipRange = sh.ownershipPercentage || 'unknown';

    const entry = {
      name: sh.name,
      entityType,
      ownershipPercentage,
      ownershipRange,
      naturesOfControl: sh.naturesOfControl || [],
      nationality: sh.nationality || undefined,
      countryOfResidence: sh.countryOfResidence || undefined,
      registrationNumber: sh.registrationNumber || undefined,
      jurisdiction: sh.jurisdiction || undefined,
      requiresTracing: entityType === 'corporate' && ownershipPercentage >= config.tracingThreshold,
    };

    shareholders.push(entry);

    if (entry.requiresTracing) {
      corporateToTrace.push(entry);
    }

    // Produce decision fragment for each shareholder
    fragments.push({
      type: FragmentType.SHAREHOLDER_IDENTIFIED,
      decision: `Identified ${entityType} "${sh.name}" as direct shareholder with ${ownershipRange} ownership (${ownershipPercentage.toFixed(1)}% calculated)`,
      confidence: 90,
      evidence: {
        dataSources: ['entity-resolution'],
        dataPoints: [
          { source: 'entity-resolution', field: 'shareholder', value: sh.name, fetchedAt: new Date().toISOString() },
          { source: 'entity-resolution', field: 'ownership_percentage', value: ownershipRange, fetchedAt: new Date().toISOString() },
          { source: 'entity-resolution', field: 'entity_type', value: entityType, fetchedAt: new Date().toISOString() },
        ],
      },
      status: 'auto_approved',
    });
  }

  const individuals = shareholders.filter((s) => s.entityType === 'individual').length;
  const corporates = shareholders.filter((s) => s.entityType === 'corporate').length;

  return { shareholders, corporateToTrace, individuals, corporates, fragments };
}

/**
 * Classify a shareholder as individual or corporate.
 *
 * Companies House PSC entries have a `kind` or `type` field:
 * - "individual-person-with-significant-control" → individual
 * - "corporate-entity-person-with-significant-control" → corporate
 * - "legal-person-person-with-significant-control" → corporate
 *
 * Falls back to heuristics: presence of registration number,
 * company suffixes (Ltd, PLC, Inc, GmbH, etc.).
 *
 * @param {Object} shareholder
 * @returns {'individual'|'corporate'}
 */
function _classifyEntityType(shareholder) {
  // Explicit type from registry data
  if (shareholder.type === 'individual') return 'individual';
  if (shareholder.type === 'corporate' || shareholder.type === 'legal-person') return 'corporate';

  // Companies House PSC kind
  const kind = (shareholder.kind || '').toLowerCase();
  if (kind.includes('individual')) return 'individual';
  if (kind.includes('corporate') || kind.includes('legal-person')) return 'corporate';

  // Heuristic: has registration number → corporate
  if (shareholder.registrationNumber) return 'corporate';

  // Heuristic: company suffixes
  const corporateSuffixes = [
    'ltd', 'limited', 'plc', 'inc', 'incorporated', 'corp', 'corporation',
    'llc', 'llp', 'lp', 'gmbh', 'ag', 'sa', 'sarl', 'bv', 'nv',
    'pty', 'sdn bhd', 'pte', 'co.',
  ];
  const nameLower = (shareholder.name || '').toLowerCase();
  if (corporateSuffixes.some((suffix) => nameLower.endsWith(suffix) || nameLower.includes(` ${suffix} `))) {
    return 'corporate';
  }

  // Default to individual
  return 'individual';
}

/**
 * Parse ownership percentage from Companies House PSC format.
 *
 * Companies House uses ranges and control statements:
 * - "25-to-50-percent" → 37.5 (midpoint)
 * - "50-to-75-percent" → 62.5
 * - "75-to-100-percent" → 87.5
 * - "25-50%" → 37.5
 * - "75% or more" → 87.5
 * - Direct numbers: "40%" → 40, "40" → 40
 *
 * @param {string|number|undefined} percentage
 * @returns {number} Numeric percentage (0-100)
 */
function _parseOwnershipPercentage(percentage) {
  if (typeof percentage === 'number') return percentage;
  if (!percentage) return 0;

  const str = String(percentage).toLowerCase().replace(/\s+/g, '');

  // Range patterns: "25-to-50-percent", "25-50%", "25-50"
  const rangeMatch = str.match(/(\d+)[^\d]+(\d+)/);
  if (rangeMatch) {
    const low = parseInt(rangeMatch[1], 10);
    const high = parseInt(rangeMatch[2], 10);
    return (low + high) / 2;
  }

  // "75% or more", "75 or more"
  const orMoreMatch = str.match(/(\d+).*or\s*more/);
  if (orMoreMatch) {
    const low = parseInt(orMoreMatch[1], 10);
    return (low + 100) / 2;
  }

  // Direct number: "40%", "40"
  const directMatch = str.match(/(\d+(?:\.\d+)?)/);
  if (directMatch) {
    return parseFloat(directMatch[1]);
  }

  return 0;
}

module.exports = { analyzeDirectOwnership, _classifyEntityType, _parseOwnershipPercentage };
```

### Ownership Percentage Parsing

Companies House PSC data uses range-based percentages:

| Registry Value | Parsed Percentage | Method |
|---------------|-------------------|--------|
| `"25-to-50-percent"` | 37.5 | Midpoint of range |
| `"50-to-75-percent"` | 62.5 | Midpoint of range |
| `"75-to-100-percent"` | 87.5 | Midpoint of range |
| `"25-50%"` | 37.5 | Midpoint of range |
| `"75% or more"` | 87.5 | Midpoint of 75-100 |
| `"40%"` | 40 | Direct number |
| `40` (number) | 40 | Pass-through |
| `undefined` | 0 | Default |

### Entity Type Classification

```
Shareholder entry
  │
  ├── Explicit type field? → use directly
  │
  ├── Companies House PSC kind?
  │     "individual-person-with-significant-control" → individual
  │     "corporate-entity-person-with-significant-control" → corporate
  │
  ├── Has registrationNumber? → corporate
  │
  ├── Name has corporate suffix (Ltd, PLC, Inc, GmbH...)? → corporate
  │
  └── Default → individual
```

## Acceptance Criteria

- [ ] `OwnershipUBOAgent` extends `BaseAgent` with 6 step names
- [ ] Step `analyze_direct_ownership` takes shareholder/PSC list from EntityProfile
- [ ] Each shareholder classified as individual or corporate
- [ ] Ownership percentage parsed from Companies House range format (midpoint)
- [ ] Handles: "25-to-50-percent", "50-to-75-percent", "75-to-100-percent", "X% or more", direct numbers
- [ ] Nature of control statements recorded per shareholder
- [ ] `shareholder_identified` fragment produced per direct shareholder
- [ ] Corporate shareholders above tracing threshold flagged for recursive tracing
- [ ] Ceased/inactive shareholders excluded
- [ ] Missing EntityProfile throws clear error
- [ ] Step description includes shareholder count breakdown

## Dependencies

- **Depends on**: #21 (BaseAgent), #22 (Decision Fragments — `shareholder_identified` type), #27-#28 (Entity Resolution — EntityProfile.shareholders)
- **Blocks**: #45 (Recursive tracing — needs `_corporateToTrace` list)

## Testing Strategy

1. **Full analysis**: EntityProfile with 3 PSCs (2 individual, 1 corporate) → verify all classified correctly
2. **Corporate classification — explicit type**: `type: 'corporate'` → verify corporate
3. **Corporate classification — PSC kind**: `kind: 'corporate-entity-person-with-significant-control'` → verify corporate
4. **Corporate classification — registration number**: Has regNumber → verify corporate
5. **Corporate classification — name suffix**: "HoldCo Ltd" → verify corporate
6. **Individual classification — default**: No indicators → verify individual
7. **Percentage parsing — range**: "25-to-50-percent" → 37.5
8. **Percentage parsing — short range**: "50-75%" → 62.5
9. **Percentage parsing — or more**: "75% or more" → 87.5
10. **Percentage parsing — direct**: "40%" → 40
11. **Percentage parsing — number**: 40 → 40
12. **Percentage parsing — undefined**: undefined → 0
13. **Tracing threshold**: Corporate at 15% with threshold 10% → requiresTracing=true; corporate at 5% → false
14. **Ceased shareholder excluded**: PSC with ceasedDate → not in output
15. **Fragments**: Verify fragment count matches shareholder count, each has correct type and evidence
16. **Missing EntityProfile**: No entity-resolution data → verify error thrown
