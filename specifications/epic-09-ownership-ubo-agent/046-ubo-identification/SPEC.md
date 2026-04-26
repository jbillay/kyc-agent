# Ownership & UBO Agent — Indirect Ownership Calculation and UBO Identification

> GitHub Issue: [#46](https://github.com/jbillay/kyc-agent/issues/46)
> Epic: Ownership & UBO Mapping Agent (#43)
> Size: L (3-5 days) | Priority: Critical

## Context

With the full ownership tree traced (Step 2), the agent must now calculate how much of the target entity each individual ultimately owns. Indirect ownership is calculated by multiplying percentages through the chain: if Person X owns 50% of Entity A, which owns 40% of the target, Person X has 20% indirect ownership. An individual may appear via multiple ownership paths — their percentages are summed. Individuals above the UBO threshold (25% for UK/US, configurable) are flagged as Ultimate Beneficial Owners. If no UBO can be identified (dispersed ownership, dead ends), the case is flagged for enhanced due diligence.

## Requirements

### Functional

1. Step `calculate_indirect_ownership`: multiply ownership percentages through each chain path
2. Handle multiple ownership paths to the same individual (sum their indirect percentages)
3. Step `identify_ubos`: flag all individuals above the UBO threshold (default 25%)
4. Handle range-based percentages: use midpoint calculated in earlier steps
5. Handle dead ends: ownership paths that couldn't be fully traced
6. Decision fragment `ubo_identified` for each UBO with full ownership path and calculated percentage
7. If no UBO identified, produce fragment explaining why and recommending enhanced due diligence (EDD)

### Non-Functional

- Calculation completes in under 1 second (pure computation, no external calls)
- Handles ownership trees with up to 50 nodes

## Technical Design

### File: `backend/src/agents/ownership-ubo/ubo-calculator.js`

```javascript
const { FragmentType } = require('../decision-fragment');

/**
 * @typedef {Object} IndirectOwnership
 * @property {string} name
 * @property {'individual'|'corporate'} entityType
 * @property {number} totalIndirectPercentage - Sum of all paths
 * @property {OwnershipPath[]} paths - All paths from this person to the target
 * @property {boolean} isUBO - True if above UBO threshold
 * @property {string} [nationality]
 * @property {string} [jurisdiction]
 */

/**
 * @typedef {Object} OwnershipPath
 * @property {string[]} entities - Entity names in the chain (from individual to target)
 * @property {number[]} percentages - Ownership percentage at each step
 * @property {number} indirectPercentage - Product of all percentages in chain
 * @property {boolean} hasDeadEnd - True if chain includes a dead end
 * @property {string} [deadEndReason]
 */

/**
 * Calculate indirect ownership percentages for all individuals in the tree.
 *
 * Walks every path from the root (target entity) to each leaf (individual),
 * multiplying ownership percentages along the way. When the same individual
 * appears in multiple paths, their percentages are summed.
 *
 * @param {Object[]} directShareholders - Direct shareholders from Step 1
 * @param {Object[]} chains - Ownership chains from Step 2 (recursive tracing)
 * @param {Object[]} deadEnds - Dead ends from Step 2
 * @returns {IndirectOwnership[]}
 */
function calculateIndirectOwnership(directShareholders, chains, deadEnds) {
  /** @type {Map<string, IndirectOwnership>} name (lowercase) → ownership data */
  const ownershipMap = new Map();

  // 1. Direct individual shareholders — their indirect % equals their direct %
  for (const sh of directShareholders) {
    if (sh.entityType === 'individual') {
      _addOwnershipPath(ownershipMap, {
        name: sh.name,
        entityType: 'individual',
        nationality: sh.nationality,
        jurisdiction: sh.jurisdiction,
        path: {
          entities: [sh.name],
          percentages: [sh.ownershipPercentage],
          indirectPercentage: sh.ownershipPercentage,
          hasDeadEnd: false,
        },
      });
    }
  }

  // 2. Walk each traced chain and extract all individual leaf paths
  for (const chain of chains) {
    const directPct = chain.directPercentage || 0;
    _walkChain(chain, [chain.name], [directPct], ownershipMap);
  }

  return Array.from(ownershipMap.values());
}

/**
 * Recursively walk a chain node, collecting paths to individual leaves.
 *
 * @param {Object} node - Current node in the ownership tree
 * @param {string[]} pathEntities - Entity names accumulated so far
 * @param {number[]} pathPercentages - Percentages accumulated so far
 * @param {Map<string, IndirectOwnership>} ownershipMap - Accumulator
 */
function _walkChain(node, pathEntities, pathPercentages, ownershipMap) {
  if (!node.children || node.children.length === 0) {
    // Leaf node or dead end (but node itself is corporate)
    if (node.deadEndReason) {
      // Dead end — can't trace further, don't produce individual path
      return;
    }
    return;
  }

  for (const child of node.children) {
    const newEntities = [...pathEntities, child.name];
    const newPercentages = [...pathPercentages, child.directPercentage];

    if (child.entityType === 'individual') {
      // Leaf — calculate indirect percentage through the full chain
      const indirectPct = _multiplyChain(newPercentages);

      _addOwnershipPath(ownershipMap, {
        name: child.name,
        entityType: 'individual',
        nationality: child.nationality,
        jurisdiction: child.jurisdiction,
        path: {
          entities: newEntities,
          percentages: newPercentages,
          indirectPercentage: indirectPct,
          hasDeadEnd: false,
        },
      });
    } else if (child.deadEndReason) {
      // Dead-end corporate node — mark path as incomplete
      // Don't add as individual ownership, but track for reporting
    } else {
      // Corporate node with children — continue walking
      _walkChain(child, newEntities, newPercentages, ownershipMap);
    }
  }
}

/**
 * Multiply percentages through a chain.
 *
 * Example: [75, 60, 40] → 75% × 60% × 40% = 18%
 * (First percentage is the direct holding of the first corporate entity,
 *  subsequent are through the chain.)
 *
 * @param {number[]} percentages
 * @returns {number} Indirect ownership percentage (0-100)
 */
function _multiplyChain(percentages) {
  if (percentages.length === 0) return 0;
  return percentages.reduce((acc, pct) => (acc * pct) / 100, 100);
}

/**
 * Add an ownership path for an individual, merging with existing entries.
 */
function _addOwnershipPath(ownershipMap, data) {
  const key = data.name.toLowerCase().trim();
  const existing = ownershipMap.get(key);

  if (existing) {
    existing.paths.push(data.path);
    existing.totalIndirectPercentage += data.path.indirectPercentage;
    // Fill missing metadata
    if (!existing.nationality && data.nationality) existing.nationality = data.nationality;
    if (!existing.jurisdiction && data.jurisdiction) existing.jurisdiction = data.jurisdiction;
  } else {
    ownershipMap.set(key, {
      name: data.name,
      entityType: data.entityType,
      totalIndirectPercentage: data.path.indirectPercentage,
      paths: [data.path],
      isUBO: false, // Set later by identifyUBOs
      nationality: data.nationality,
      jurisdiction: data.jurisdiction,
    });
  }
}

/**
 * Identify Ultimate Beneficial Owners from the indirect ownership data.
 *
 * @param {IndirectOwnership[]} indirectOwnerships
 * @param {Object[]} deadEnds
 * @param {Object} config
 * @param {number} config.uboThreshold - Minimum indirect % to qualify as UBO (default 25)
 * @returns {{ ubos: IndirectOwnership[], fragments: Object[], noUboIdentified: boolean }}
 */
function identifyUBOs(indirectOwnerships, deadEnds, config) {
  const fragments = [];
  const ubos = [];

  for (const ownership of indirectOwnerships) {
    if (ownership.entityType !== 'individual') continue;

    if (ownership.totalIndirectPercentage >= config.uboThreshold) {
      ownership.isUBO = true;
      ubos.push(ownership);

      // Build path description for the fragment
      const pathDescriptions = ownership.paths.map((p) =>
        `${p.entities.join(' → ')} (${p.indirectPercentage.toFixed(1)}%)`
      );

      fragments.push({
        type: FragmentType.UBO_IDENTIFIED,
        decision: `Identified "${ownership.name}" as UBO with ${ownership.totalIndirectPercentage.toFixed(1)}% indirect ownership (threshold: ${config.uboThreshold}%)`,
        confidence: _calculateUBOConfidence(ownership, deadEnds),
        evidence: {
          dataSources: ['ownership-tracing', 'entity-resolution'],
          dataPoints: [
            { source: 'ownership-tracing', field: 'total_indirect_percentage', value: ownership.totalIndirectPercentage, fetchedAt: new Date().toISOString() },
            { source: 'ownership-tracing', field: 'ownership_paths', value: pathDescriptions, fetchedAt: new Date().toISOString() },
            { source: 'ownership-tracing', field: 'path_count', value: ownership.paths.length, fetchedAt: new Date().toISOString() },
          ],
        },
        status: 'pending_review',
      });
    }
  }

  // Handle no UBO identified
  const noUboIdentified = ubos.length === 0;
  if (noUboIdentified) {
    const reasons = [];
    if (indirectOwnerships.length === 0) {
      reasons.push('No individual shareholders identified in ownership structure');
    } else {
      const maxPct = Math.max(...indirectOwnerships.map((o) => o.totalIndirectPercentage));
      reasons.push(`Highest individual ownership is ${maxPct.toFixed(1)}% (below ${config.uboThreshold}% threshold)`);
    }
    if (deadEnds.length > 0) {
      reasons.push(`${deadEnds.length} ownership path(s) could not be fully traced`);
    }

    fragments.push({
      type: FragmentType.UBO_IDENTIFIED, // Using same type with different decision
      decision: `No UBO identified — enhanced due diligence recommended. ${reasons.join('. ')}`,
      confidence: 70,
      evidence: {
        dataSources: ['ownership-tracing'],
        dataPoints: [
          { source: 'ownership-tracing', field: 'no_ubo_reason', value: reasons, fetchedAt: new Date().toISOString() },
          { source: 'ownership-tracing', field: 'dead_ends', value: deadEnds.length, fetchedAt: new Date().toISOString() },
          { source: 'ownership-tracing', field: 'ubo_threshold', value: config.uboThreshold, fetchedAt: new Date().toISOString() },
        ],
      },
      status: 'pending_review',
    });
  }

  return { ubos, fragments, noUboIdentified };
}

/**
 * Calculate confidence for a UBO identification.
 *
 * Higher confidence when:
 * - All paths are fully traced (no dead ends)
 * - Ownership is direct (shorter chain)
 * - Single clear path
 *
 * Lower confidence when:
 * - Paths include dead ends nearby
 * - Range-based percentages used
 * - Multiple paths summed
 */
function _calculateUBOConfidence(ownership, deadEnds) {
  let confidence = 90;

  // Multiple paths → slightly less certain
  if (ownership.paths.length > 1) confidence -= 5;

  // Deep chains → slightly less certain
  const maxDepth = Math.max(...ownership.paths.map((p) => p.entities.length));
  if (maxDepth > 3) confidence -= 5;
  if (maxDepth > 5) confidence -= 5;

  // Dead ends in the broader tree reduce confidence
  if (deadEnds.length > 0) confidence -= 5;
  if (deadEnds.length > 3) confidence -= 5;

  return Math.max(confidence, 60);
}

module.exports = { calculateIndirectOwnership, identifyUBOs };
```

### Integration with Agent Steps

```javascript
// In OwnershipUBOAgent

async _calculateIndirectOwnership(context) {
  this._indirectOwnerships = calculateIndirectOwnership(
    this._directShareholders,
    this._ownershipChains,
    this._deadEnds
  );

  const individuals = this._indirectOwnerships.filter((o) => o.entityType === 'individual');
  const maxPct = individuals.length > 0
    ? Math.max(...individuals.map((o) => o.totalIndirectPercentage))
    : 0;

  return {
    description: `Calculated indirect ownership for ${individuals.length} individuals (max: ${maxPct.toFixed(1)}%)`,
    decisionFragments: [],
    llmCalls: [],
  };
}

async _identifyUBOs(context) {
  const result = identifyUBOs(this._indirectOwnerships, this._deadEnds, {
    uboThreshold: this.uboThreshold,
  });

  this._ubos = result.ubos;

  if (result.noUboIdentified) {
    return {
      description: `No UBO identified above ${this.uboThreshold}% threshold — enhanced due diligence recommended`,
      decisionFragments: result.fragments,
      llmCalls: [],
    };
  }

  const uboNames = result.ubos.map((u) => `${u.name} (${u.totalIndirectPercentage.toFixed(1)}%)`);
  return {
    description: `Identified ${result.ubos.length} UBO(s): ${uboNames.join(', ')}`,
    decisionFragments: result.fragments,
    llmCalls: [],
  };
}
```

### Indirect Ownership Calculation Example

```
Target: Acme Holdings Ltd
  │
  ├── John Smith (individual, 25% direct)
  │   → Indirect: 25%  ✓ UBO
  │
  └── HoldCo Ltd (corporate, 75% direct)
      │
      ├── Jane Doe (individual, 60% of HoldCo)
      │   → Indirect: 75% × 60% = 45%  ✓ UBO
      │
      └── SubCo Ltd (corporate, 40% of HoldCo)
          │
          └── Jane Doe (individual, 100% of SubCo)
              → Indirect via this path: 75% × 40% × 100% = 30%
              → Total for Jane Doe: 45% + 30% = 75%  ✓ UBO

Result:
  John Smith: 25% (1 path) → UBO
  Jane Doe: 75% (2 paths: 45% + 30%) → UBO
```

### Multiple-Path Aggregation

When the same individual appears via different paths, their indirect percentages are summed:

| Individual | Path 1 | Path 2 | Total | UBO? |
|-----------|--------|--------|-------|------|
| Jane Doe | 45% (via HoldCo) | 30% (via HoldCo → SubCo) | 75% | Yes |
| John Smith | 25% (direct) | — | 25% | Yes |
| Bob Jones | 15% (via HoldCo → SubCo) | 8% (direct) | 23% | No |

## Acceptance Criteria

- [ ] Step `calculate_indirect_ownership` multiplies percentages through each chain path
- [ ] Formula: `Product(percentages) / 100^(n-1)` for chain of n entities
- [ ] Same individual via multiple paths: percentages summed
- [ ] Direct individual shareholders included (indirect % = direct %)
- [ ] Step `identify_ubos` flags individuals ≥ UBO threshold (default 25%, configurable)
- [ ] `ubo_identified` fragment for each UBO with ownership paths and total percentage
- [ ] UBO fragments have `pending_review` status
- [ ] No UBO identified → fragment with EDD recommendation and reasons
- [ ] No UBO fragment includes: highest individual %, dead end count, threshold used
- [ ] Confidence calculation considers: path count, chain depth, dead ends
- [ ] Dead-end paths not incorrectly attributed to individuals
- [ ] Handles ownership trees with up to 50 nodes

## Dependencies

- **Depends on**: #44 (Direct ownership — `_directShareholders`), #45 (Recursive tracing — `_ownershipChains`, `_deadEnds`)
- **Blocks**: #47 (Complexity assessment — needs UBO list and complete ownership data)

## Testing Strategy

1. **Direct individual only**: 1 individual at 60% → indirect = 60%, UBO
2. **Single chain**: Target ← Corp(75%) ← Individual(80%) → indirect = 60%, UBO
3. **Two-level chain**: Target ← Corp(50%) ← Corp(40%) ← Individual(100%) → indirect = 20%, not UBO at 25% threshold
4. **Multiple paths same person**: Two paths summing to 35% → UBO
5. **Multiple UBOs**: Three individuals all above threshold → 3 UBO fragments
6. **No UBO — dispersed**: All individuals below threshold → EDD recommendation
7. **No UBO — dead ends**: All chains hit dead ends → EDD recommendation mentioning dead ends
8. **Mixed direct and indirect**: Individual with 10% direct + 20% indirect path → total 30%, UBO
9. **Dead-end path excluded**: Dead-end chain does not produce spurious individual ownership
10. **Percentage multiplication**: [75, 60, 40] → 18% verified
11. **Confidence — simple**: Direct UBO → confidence 90
12. **Confidence — complex**: Multiple paths + deep chain + dead ends → lower confidence
13. **Threshold configurable**: Set threshold to 10%, verify lower threshold works
14. **Large tree**: 50-node tree → verify completes in < 1 second
