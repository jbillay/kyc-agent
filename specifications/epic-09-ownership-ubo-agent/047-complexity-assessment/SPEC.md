# Ownership & UBO Agent — Structure Complexity Assessment and Ownership Tree Generation

> GitHub Issue: [#47](https://github.com/jbillay/kyc-agent/issues/47)
> Epic: Ownership & UBO Mapping Agent (#43)
> Size: M (1-3 days) | Priority: High

## Context

After ownership chains are traced and UBOs identified, the agent evaluates the overall ownership structure for complexity indicators that contribute to risk scoring. An LLM assesses the structure for: number of layers, cross-border elements, nominee indicators, trust structures, bearer share indicators, circular ownership, and opaque jurisdictions. This is one of the few steps where LLM adds genuine value — the assessment is subjective and context-dependent, unlike the deterministic percentage calculations. The final step produces a structured JSON tree suitable for the Vue Flow frontend visualization.

## Requirements

### Functional

1. Step `assess_structure_complexity`: LLM evaluates ownership structure for complexity indicators
2. Complexity indicators assessed: layer count, cross-border elements, nominee indicators, trust structures, bearer shares, circular ownership, opaque jurisdictions
3. Produces structured complexity assessment with risk-relevant flags
4. Decision fragments for specific complexity concerns
5. Step `generate_ownership_tree`: produces JSON tree compatible with Vue Flow node/edge format
6. Tree includes all nodes (entities + individuals), edges (ownership relationships), UBO markers, dead-end indicators

### Non-Functional

- LLM assessment completes in under 15 seconds
- Tree generation completes in under 1 second (data assembly only)

## Technical Design

### File: `backend/src/agents/ownership-ubo/complexity.js`

```javascript
const { FragmentType } = require('../decision-fragment');

/**
 * @typedef {Object} ComplexityAssessment
 * @property {number} layerCount - Number of ownership layers
 * @property {boolean} hasCrossBorderElements - Ownership crosses jurisdictions
 * @property {string[]} crossBorderJurisdictions - Foreign jurisdictions encountered
 * @property {boolean} hasNomineeIndicators - Signs of nominee arrangements
 * @property {boolean} hasTrustStructures - Trust entities in chain
 * @property {boolean} hasBearerShareIndicators - Bearer share instruments detected
 * @property {boolean} hasCircularOwnership - Circular ownership detected
 * @property {boolean} hasOpaqueJurisdictions - Jurisdictions known for opacity
 * @property {string[]} opaqueJurisdictions - Which opaque jurisdictions
 * @property {number} deadEndCount - Number of untraceable paths
 * @property {string} overallComplexity - 'low' | 'medium' | 'high'
 * @property {string} llmNarrative - LLM's written assessment
 * @property {Object[]} riskFlags - Specific risk indicators with severity
 */

/**
 * Opaque jurisdictions — commonly flagged in KYC/AML contexts.
 */
const OPAQUE_JURISDICTIONS = new Set([
  'KY', 'VG', 'BM', 'PA', 'BZ', 'SC', 'MU', 'MH', 'WS', 'VU',
  // Cayman Islands, BVI, Bermuda, Panama, Belize, Seychelles,
  // Mauritius, Marshall Islands, Samoa, Vanuatu
]);

/**
 * Assess ownership structure complexity using a combination of
 * deterministic checks and LLM reasoning.
 *
 * @param {Object} data
 * @param {Object[]} data.directShareholders
 * @param {Object[]} data.chains
 * @param {Object[]} data.deadEnds
 * @param {Object[]} data.ubos
 * @param {Object[]} data.indirectOwnerships
 * @param {string} data.targetJurisdiction
 * @param {Object} deps
 * @param {import('../../llm/llm-service').LLMService} deps.llmService
 * @returns {Promise<{ assessment: ComplexityAssessment, fragments: Object[], llmCalls: Object[] }>}
 */
async function assessStructureComplexity(data, deps) {
  const { directShareholders, chains, deadEnds, ubos, indirectOwnerships, targetJurisdiction } = data;
  const { llmService } = deps;

  // ─── Deterministic checks ──────────────────────

  const layerCount = _calculateLayerCount(chains);
  const allJurisdictions = _collectJurisdictions(chains, directShareholders);
  const foreignJurisdictions = allJurisdictions.filter((j) => j !== targetJurisdiction);
  const hasCrossBorder = foreignJurisdictions.length > 0;
  const opaqueJurisdictions = foreignJurisdictions.filter((j) => OPAQUE_JURISDICTIONS.has(j));
  const hasCircular = chains.some((c) => _hasCircularNode(c));

  const deterministicFlags = {
    layerCount,
    hasCrossBorderElements: hasCrossBorder,
    crossBorderJurisdictions: foreignJurisdictions,
    hasCircularOwnership: hasCircular,
    hasOpaqueJurisdictions: opaqueJurisdictions.length > 0,
    opaqueJurisdictions,
    deadEndCount: deadEnds.length,
  };

  // ─── LLM assessment ────────────────────────────

  const structureSummary = _buildStructureSummary(data, deterministicFlags);

  const llmResponse = await llmService.complete({
    taskType: 'reasoning',
    prompt: _buildComplexityPrompt(structureSummary),
    responseFormat: {
      type: 'json',
      schema: {
        type: 'object',
        properties: {
          overallComplexity: { type: 'string', enum: ['low', 'medium', 'high'] },
          hasNomineeIndicators: { type: 'boolean' },
          hasTrustStructures: { type: 'boolean' },
          hasBearerShareIndicators: { type: 'boolean' },
          riskFlags: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                flag: { type: 'string' },
                severity: { type: 'string', enum: ['low', 'medium', 'high'] },
                explanation: { type: 'string' },
              },
              required: ['flag', 'severity', 'explanation'],
            },
          },
          narrative: { type: 'string' },
        },
        required: ['overallComplexity', 'hasNomineeIndicators', 'hasTrustStructures', 'hasBearerShareIndicators', 'riskFlags', 'narrative'],
      },
    },
  });

  const llmResult = JSON.parse(llmResponse.text);

  // ─── Combine deterministic + LLM ───────────────

  const assessment = {
    ...deterministicFlags,
    hasNomineeIndicators: llmResult.hasNomineeIndicators,
    hasTrustStructures: llmResult.hasTrustStructures,
    hasBearerShareIndicators: llmResult.hasBearerShareIndicators,
    overallComplexity: llmResult.overallComplexity,
    llmNarrative: llmResult.narrative,
    riskFlags: llmResult.riskFlags,
  };

  // ─── Decision fragments ────────────────────────

  const fragments = [];

  for (const flag of llmResult.riskFlags) {
    if (flag.severity === 'high' || flag.severity === 'medium') {
      fragments.push({
        type: FragmentType.RISK_FACTOR_IDENTIFIED,
        decision: `Ownership complexity: ${flag.flag} — ${flag.explanation}`,
        confidence: flag.severity === 'high' ? 85 : 75,
        evidence: {
          dataSources: ['ownership-tracing'],
          dataPoints: [
            { source: 'ownership-tracing', field: 'risk_flag', value: flag.flag, fetchedAt: new Date().toISOString() },
            { source: 'ownership-tracing', field: 'severity', value: flag.severity, fetchedAt: new Date().toISOString() },
          ],
          llmReasoning: flag.explanation,
          llmModel: llmResponse.model,
          llmCallId: llmResponse.callId,
        },
        status: flag.severity === 'high' ? 'pending_review' : 'auto_approved',
      });
    }
  }

  return {
    assessment,
    fragments,
    llmCalls: [llmResponse.callLog],
  };
}

function _calculateLayerCount(chains) {
  if (chains.length === 0) return 1;
  return 1 + Math.max(...chains.map((c) => _getMaxDepth(c)));
}

function _getMaxDepth(node) {
  if (!node.children || node.children.length === 0) return 0;
  return 1 + Math.max(...node.children.map(_getMaxDepth));
}

function _collectJurisdictions(chains, directShareholders) {
  const jurisdictions = new Set();
  for (const sh of directShareholders) {
    if (sh.jurisdiction) jurisdictions.add(sh.jurisdiction);
  }
  for (const chain of chains) {
    _walkForJurisdictions(chain, jurisdictions);
  }
  return Array.from(jurisdictions);
}

function _walkForJurisdictions(node, jurisdictions) {
  if (node.jurisdiction) jurisdictions.add(node.jurisdiction);
  for (const child of node.children || []) {
    _walkForJurisdictions(child, jurisdictions);
  }
}

function _hasCircularNode(node) {
  if (node.isCircular) return true;
  return (node.children || []).some(_hasCircularNode);
}

function _buildStructureSummary(data, flags) {
  return {
    targetEntity: data.targetJurisdiction,
    directShareholderCount: data.directShareholders.length,
    corporateShareholderCount: data.directShareholders.filter((s) => s.entityType === 'corporate').length,
    uboCount: data.ubos.length,
    layerCount: flags.layerCount,
    crossBorderJurisdictions: flags.crossBorderJurisdictions,
    opaqueJurisdictions: flags.opaqueJurisdictions,
    hasCircularOwnership: flags.hasCircularOwnership,
    deadEndCount: flags.deadEndCount,
    shareholders: data.directShareholders.map((s) => ({
      name: s.name,
      type: s.entityType,
      percentage: s.ownershipPercentage,
      jurisdiction: s.jurisdiction,
    })),
    ubos: data.ubos.map((u) => ({
      name: u.name,
      totalPercentage: u.totalIndirectPercentage,
      pathCount: u.paths.length,
    })),
  };
}

function _buildComplexityPrompt(summary) {
  return `You are a KYC compliance analyst assessing an ownership structure for complexity and risk indicators.

## Ownership Structure Summary

- Target entity jurisdiction: ${summary.targetEntity}
- Direct shareholders: ${summary.directShareholderCount} (${summary.corporateShareholderCount} corporate)
- Identified UBOs: ${summary.uboCount}
- Ownership layers: ${summary.layerCount}
- Cross-border jurisdictions: ${summary.crossBorderJurisdictions.join(', ') || 'none'}
- Opaque jurisdictions: ${summary.opaqueJurisdictions.join(', ') || 'none'}
- Circular ownership detected: ${summary.hasCircularOwnership}
- Dead ends (untraceable paths): ${summary.deadEndCount}

## Direct Shareholders
${summary.shareholders.map((s) => `- ${s.name} (${s.type}, ${s.percentage}%, ${s.jurisdiction || 'unknown jurisdiction'})`).join('\n')}

## Identified UBOs
${summary.ubos.map((u) => `- ${u.name}: ${u.totalPercentage.toFixed(1)}% total via ${u.pathCount} path(s)`).join('\n') || 'None identified'}

## Assessment Task

Evaluate this ownership structure for the following complexity indicators:
1. **Nominee indicators**: Are any entities or individuals likely acting as nominees?
2. **Trust structures**: Are there trust entities or trust-like arrangements?
3. **Bearer share indicators**: Are there signs of bearer share instruments?
4. **Risk flags**: List specific risk concerns with severity (low/medium/high) and explanation.
5. **Overall complexity**: Rate as low, medium, or high.
6. **Narrative**: Write a 2-3 sentence summary of the structure's risk profile.

Respond with JSON matching the specified schema.`;
}

module.exports = { assessStructureComplexity, OPAQUE_JURISDICTIONS };
```

### File: `backend/src/agents/ownership-ubo/ownership-tree.js`

```javascript
/**
 * @typedef {Object} TreeNode
 * @property {string} id - Unique node ID
 * @property {string} label - Display name
 * @property {'individual'|'corporate'|'target'} type
 * @property {Object} data
 * @property {number} data.ownershipPercentage
 * @property {string} data.jurisdiction
 * @property {boolean} data.isUBO
 * @property {boolean} data.isDeadEnd
 * @property {string} [data.deadEndReason]
 * @property {string} data.status - 'verified' | 'partial' | 'dead_end' | 'below_threshold'
 */

/**
 * @typedef {Object} TreeEdge
 * @property {string} id
 * @property {string} source - Parent node ID
 * @property {string} target - Child node ID
 * @property {string} label - Ownership percentage
 */

/**
 * Generate ownership tree data for Vue Flow visualization.
 *
 * Converts the internal ownership chain structure into a flat
 * nodes + edges format compatible with Vue Flow / dagre layout.
 *
 * @param {Object} data
 * @param {string} data.targetEntityName
 * @param {Object[]} data.directShareholders
 * @param {Object[]} data.chains
 * @param {Object[]} data.ubos
 * @param {string} data.targetJurisdiction
 * @returns {{ nodes: TreeNode[], edges: TreeEdge[] }}
 */
function generateOwnershipTree(data) {
  const { targetEntityName, directShareholders, chains, ubos, targetJurisdiction } = data;

  const nodes = [];
  const edges = [];
  const uboNames = new Set(ubos.map((u) => u.name.toLowerCase().trim()));

  let nodeCounter = 0;
  function nextId() {
    return `node-${++nodeCounter}`;
  }

  // Root node: the target entity
  const rootId = nextId();
  nodes.push({
    id: rootId,
    label: targetEntityName,
    type: 'target',
    data: {
      ownershipPercentage: 100,
      jurisdiction: targetJurisdiction,
      isUBO: false,
      isDeadEnd: false,
      status: 'verified',
    },
  });

  // Map chain root names to their traced chain data
  const chainMap = new Map();
  for (const chain of chains) {
    chainMap.set(chain.name.toLowerCase().trim(), chain);
  }

  // Add direct shareholders
  for (const sh of directShareholders) {
    const chain = chainMap.get(sh.name.toLowerCase().trim());

    if (sh.entityType === 'individual') {
      // Individual direct shareholder
      const nodeId = nextId();
      nodes.push({
        id: nodeId,
        label: sh.name,
        type: 'individual',
        data: {
          ownershipPercentage: sh.ownershipPercentage,
          jurisdiction: sh.jurisdiction || sh.nationality,
          isUBO: uboNames.has(sh.name.toLowerCase().trim()),
          isDeadEnd: false,
          status: 'verified',
        },
      });
      edges.push({
        id: `edge-${rootId}-${nodeId}`,
        source: rootId,
        target: nodeId,
        label: `${sh.ownershipPercentage.toFixed(1)}%`,
      });
    } else if (chain) {
      // Corporate with traced chain
      _addChainToTree(chain, rootId, nodes, edges, uboNames, nextId);
    } else {
      // Corporate without chain (below threshold or not traced)
      const nodeId = nextId();
      nodes.push({
        id: nodeId,
        label: sh.name,
        type: 'corporate',
        data: {
          ownershipPercentage: sh.ownershipPercentage,
          jurisdiction: sh.jurisdiction,
          isUBO: false,
          isDeadEnd: !sh.requiresTracing,
          deadEndReason: sh.requiresTracing ? undefined : 'below_threshold',
          status: sh.requiresTracing ? 'partial' : 'below_threshold',
        },
      });
      edges.push({
        id: `edge-${rootId}-${nodeId}`,
        source: rootId,
        target: nodeId,
        label: `${sh.ownershipPercentage.toFixed(1)}%`,
      });
    }
  }

  return { nodes, edges };
}

/**
 * Recursively add a traced chain to the tree nodes and edges.
 */
function _addChainToTree(node, parentId, nodes, edges, uboNames, nextId) {
  const nodeId = nextId();
  const isIndividual = node.entityType === 'individual';

  nodes.push({
    id: nodeId,
    label: node.name,
    type: isIndividual ? 'individual' : 'corporate',
    data: {
      ownershipPercentage: node.directPercentage,
      jurisdiction: node.jurisdiction,
      isUBO: isIndividual && uboNames.has(node.name.toLowerCase().trim()),
      isDeadEnd: !!node.deadEndReason,
      deadEndReason: node.deadEndReason,
      status: node.deadEndReason
        ? 'dead_end'
        : isIndividual
          ? 'verified'
          : node.children?.length > 0
            ? 'verified'
            : 'partial',
    },
  });

  edges.push({
    id: `edge-${parentId}-${nodeId}`,
    source: parentId,
    target: nodeId,
    label: `${(node.directPercentage || 0).toFixed(1)}%`,
  });

  for (const child of node.children || []) {
    _addChainToTree(child, nodeId, nodes, edges, uboNames, nextId);
  }
}

module.exports = { generateOwnershipTree };
```

### Integration with Agent Steps

```javascript
// In OwnershipUBOAgent

async _assessStructureComplexity(context) {
  const result = await assessStructureComplexity(
    {
      directShareholders: this._directShareholders,
      chains: this._ownershipChains,
      deadEnds: this._deadEnds,
      ubos: this._ubos,
      indirectOwnerships: this._indirectOwnerships,
      targetJurisdiction: context.jurisdiction,
    },
    { llmService: this.llmService }
  );

  this._complexityAssessment = result.assessment;

  return {
    description: `Structure complexity: ${result.assessment.overallComplexity} (${result.assessment.riskFlags.length} risk flags, ${result.assessment.layerCount} layers)`,
    decisionFragments: result.fragments,
    llmCalls: result.llmCalls,
  };
}

async _generateOwnershipTree(context) {
  this._ownershipTree = generateOwnershipTree({
    targetEntityName: context.entityName,
    directShareholders: this._directShareholders,
    chains: this._ownershipChains,
    ubos: this._ubos,
    targetJurisdiction: context.jurisdiction,
  });

  return {
    description: `Generated ownership tree: ${this._ownershipTree.nodes.length} nodes, ${this._ownershipTree.edges.length} edges`,
    decisionFragments: [],
    llmCalls: [],
  };
}
```

### LLM Complexity Assessment — Structured Output Schema

```json
{
  "overallComplexity": "medium",
  "hasNomineeIndicators": false,
  "hasTrustStructures": false,
  "hasBearerShareIndicators": false,
  "riskFlags": [
    {
      "flag": "cross_border_opaque_jurisdiction",
      "severity": "high",
      "explanation": "Ownership chain passes through Cayman Islands (KY), a jurisdiction with limited transparency requirements"
    },
    {
      "flag": "multiple_layers",
      "severity": "medium",
      "explanation": "4 layers of corporate ownership creates distance between UBOs and the target entity"
    }
  ],
  "narrative": "The ownership structure involves a moderate level of complexity with 4 layers and cross-border elements through the Cayman Islands. While no nominee or trust indicators were detected, the opaque jurisdiction and dead-end path warrant enhanced review."
}
```

### Tree Output Shape (Vue Flow compatible)

```json
{
  "nodes": [
    { "id": "node-1", "label": "Acme Holdings Ltd", "type": "target", "data": { "ownershipPercentage": 100, "jurisdiction": "GB", "isUBO": false, "isDeadEnd": false, "status": "verified" } },
    { "id": "node-2", "label": "John Smith", "type": "individual", "data": { "ownershipPercentage": 25, "jurisdiction": "GB", "isUBO": true, "isDeadEnd": false, "status": "verified" } },
    { "id": "node-3", "label": "HoldCo Ltd", "type": "corporate", "data": { "ownershipPercentage": 75, "jurisdiction": "GB", "isUBO": false, "isDeadEnd": false, "status": "verified" } },
    { "id": "node-4", "label": "Offshore Ltd", "type": "corporate", "data": { "ownershipPercentage": 40, "jurisdiction": "KY", "isUBO": false, "isDeadEnd": true, "deadEndReason": "no_registry_access", "status": "dead_end" } }
  ],
  "edges": [
    { "id": "edge-node-1-node-2", "source": "node-1", "target": "node-2", "label": "25.0%" },
    { "id": "edge-node-1-node-3", "source": "node-1", "target": "node-3", "label": "75.0%" },
    { "id": "edge-node-3-node-4", "source": "node-3", "target": "node-4", "label": "40.0%" }
  ]
}
```

## Acceptance Criteria

- [ ] Step `assess_structure_complexity` sends ownership summary to LLM
- [ ] LLM evaluates: nominee indicators, trust structures, bearer shares
- [ ] Deterministic checks: layer count, cross-border, opaque jurisdictions, circular ownership
- [ ] Opaque jurisdiction list includes common tax havens (KY, VG, BM, PA, etc.)
- [ ] Structured complexity assessment with `overallComplexity` (low/medium/high)
- [ ] Risk flags produced as decision fragments (medium/high severity)
- [ ] High-severity flags get `pending_review` status
- [ ] LLM task type is `reasoning`
- [ ] Step `generate_ownership_tree` produces Vue Flow compatible `{ nodes, edges }` structure
- [ ] Tree nodes include: label, type, ownership %, jurisdiction, UBO flag, dead-end indicator
- [ ] Tree edges include ownership percentage labels
- [ ] Target entity is root node with type `target`
- [ ] UBO nodes marked with `isUBO: true`
- [ ] Dead-end nodes include `deadEndReason`

## Dependencies

- **Depends on**: #44 (Direct ownership data), #45 (Chains and dead ends), #46 (UBOs and indirect ownerships), #8 (LLM Service — reasoning task)
- **Blocks**: #48 (Frontend tree visualization — consumes tree output)

## Testing Strategy

1. **Simple structure — low complexity**: 2 individual shareholders, no corporate → overallComplexity: low
2. **Cross-border flag**: Chain includes foreign jurisdiction → `hasCrossBorderElements: true`
3. **Opaque jurisdiction detection**: Chain includes KY → `hasOpaqueJurisdictions: true`, KY in list
4. **Circular ownership flag**: Chain has circular node → `hasCircularOwnership: true`
5. **Layer count**: 4-level chain → `layerCount: 4`
6. **LLM structured output**: Verify response matches expected schema
7. **Risk flag fragments**: High-severity flag → `pending_review` fragment; medium → `auto_approved`
8. **Tree — root node**: Target entity is first node with type `target`
9. **Tree — individual leaf**: Individual shareholder has type `individual`
10. **Tree — UBO marker**: UBO individual has `isUBO: true`
11. **Tree — dead end**: Dead-end node has `isDeadEnd: true` and reason
12. **Tree — edges**: Each parent-child relationship has an edge with percentage label
13. **Tree — complex structure**: 5 shareholders, 3 corporate with chains → verify all nodes/edges correct
14. **No shareholders**: Empty ownership → minimal tree with just root node
