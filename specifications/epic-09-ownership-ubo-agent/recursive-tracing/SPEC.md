# Ownership & UBO Agent — Recursive Corporate Ownership Tracing

> GitHub Issue: [#45](https://github.com/jbillay/kyc-agent/issues/45)
> Epic: Ownership & UBO Mapping Agent (#43)
> Size: XL (1-2 weeks) | Priority: Critical

## Context

When a direct shareholder is a corporate entity, its own shareholders must be traced to uncover the real people behind the ownership. This step recursively queries corporate registries (Companies House for UK entities) to build the full ownership tree layer by layer. Recursion stops when an individual is reached, ownership falls below a threshold, maximum depth is hit, or a dead end is encountered (foreign jurisdiction without registry access, dissolved entity, no data). Circular ownership (Entity A owns Entity B owns Entity A) is detected and flagged. All registry queries are cached via the data caching layer.

This is the most complex step in the ownership agent — the core graph traversal algorithm.

## Requirements

### Functional

1. Step `trace_corporate_shareholders`: for each corporate shareholder from Step 1, query registries for their shareholders
2. Recursive tracing: if a shareholder's shareholder is also corporate, continue tracing
3. Stop conditions:
   - Individual reached (leaf node)
   - Ownership below tracing threshold (configurable, default 10%)
   - Maximum depth reached (configurable, default 10 levels)
   - Dead end: no data available, foreign jurisdiction without registry, dissolved entity
4. Circular ownership detection: Entity A → B → A detected and stopped
5. Cross-jurisdiction awareness: flag when ownership chain crosses borders
6. Decision fragments: `ubo_chain_traced` for successful traces, `ubo_dead_end` for dead ends with reason
7. All registry queries cached via data caching layer
8. Rate limiting awareness for Companies House API

### Non-Functional

- Tracing of 5 corporate shareholders with average depth 3 completes within 30 seconds
- Registry queries cached to avoid redundant calls across cases

## Technical Design

### File: `backend/src/agents/ownership-ubo/recursive-tracer.js`

```javascript
const { FragmentType } = require('../decision-fragment');

/**
 * @typedef {Object} OwnershipNode
 * @property {string} id - Unique node ID
 * @property {string} name
 * @property {'individual'|'corporate'} entityType
 * @property {number} directPercentage - Ownership percentage from parent
 * @property {string} [registrationNumber]
 * @property {string} jurisdiction
 * @property {string} [status] - Company status (active, dissolved, etc.)
 * @property {OwnershipNode[]} children - Shareholders of this entity
 * @property {string} [deadEndReason] - Why tracing stopped
 * @property {boolean} isCircular - True if circular ownership detected
 * @property {number} depth - Depth in the tree (0 = target entity)
 */

/**
 * @typedef {Object} TracingResult
 * @property {OwnershipNode[]} chains - Complete ownership chains
 * @property {Object[]} deadEnds - Dead-end entries with reasons
 * @property {Object[]} fragments - Decision fragments
 * @property {number} totalQueries - Number of registry lookups performed
 * @property {number} maxDepthReached - Deepest level traced
 */

/**
 * Recursively trace corporate ownership chains through registries.
 *
 * @param {Object[]} corporateToTrace - Corporate shareholders from Step 1
 * @param {Object} deps
 * @param {import('../../data-sources/registry').RegistryFactory} deps.registryFactory
 * @param {Object} deps.config
 * @param {number} deps.config.tracingThreshold - Min ownership % to continue tracing
 * @param {number} deps.config.maxDepth - Maximum recursion depth
 * @param {string} deps.targetJurisdiction - Jurisdiction of the target entity
 * @returns {Promise<TracingResult>}
 */
async function traceCorporateShareholders(corporateToTrace, deps) {
  const { registryFactory, config, targetJurisdiction } = deps;

  const chains = [];
  const deadEnds = [];
  const fragments = [];
  let totalQueries = 0;
  let maxDepthReached = 0;

  for (const corporate of corporateToTrace) {
    const visited = new Set(); // For circular detection
    const chain = await _traceEntity(
      corporate,
      1, // depth (0 is the target entity itself)
      visited,
      { registryFactory, config, targetJurisdiction },
      { deadEnds, fragments, queryCounter: { count: 0 } }
    );

    chains.push(chain);
    totalQueries += chain._queryCount || 0;
    maxDepthReached = Math.max(maxDepthReached, chain._maxDepth || 1);
  }

  // Produce chain-traced fragments for successful traces
  for (const chain of chains) {
    const depth = _getMaxDepth(chain);
    if (depth > 0) {
      fragments.push({
        type: FragmentType.UBO_CHAIN_TRACED,
        decision: `Traced ownership of "${chain.name}" through ${depth} level(s)`,
        confidence: 85,
        evidence: {
          dataSources: _collectDataSources(chain),
          dataPoints: [
            { source: 'ownership-tracing', field: 'depth', value: depth, fetchedAt: new Date().toISOString() },
            { source: 'ownership-tracing', field: 'entity_name', value: chain.name, fetchedAt: new Date().toISOString() },
          ],
        },
        status: 'auto_approved',
      });
    }
  }

  return { chains, deadEnds, fragments, totalQueries, maxDepthReached };
}

/**
 * Trace a single corporate entity recursively.
 *
 * @param {Object} entity - The corporate entity to trace
 * @param {number} depth - Current depth in the ownership tree
 * @param {Set<string>} visited - Set of visited entity identifiers (for circular detection)
 * @param {Object} deps - Dependencies
 * @param {Object} acc - Accumulators (deadEnds, fragments, queryCounter)
 * @returns {Promise<OwnershipNode>}
 */
async function _traceEntity(entity, depth, visited, deps, acc) {
  const { registryFactory, config, targetJurisdiction } = deps;
  const entityKey = _entityKey(entity);

  const node = {
    id: entityKey,
    name: entity.name,
    entityType: 'corporate',
    directPercentage: entity.ownershipPercentage || 0,
    registrationNumber: entity.registrationNumber,
    jurisdiction: entity.jurisdiction || targetJurisdiction,
    status: null,
    children: [],
    deadEndReason: null,
    isCircular: false,
    depth,
    _queryCount: 0,
    _maxDepth: depth,
  };

  // ─── Stop condition: max depth ─────────────────

  if (depth > config.maxDepth) {
    node.deadEndReason = 'max_depth_reached';
    _addDeadEnd(acc, node, 'Maximum tracing depth reached');
    return node;
  }

  // ─── Stop condition: circular ownership ─────────

  if (visited.has(entityKey)) {
    node.isCircular = true;
    node.deadEndReason = 'circular_ownership';
    _addDeadEnd(acc, node, `Circular ownership detected: ${entity.name} already in chain`);
    return node;
  }

  visited.add(entityKey);

  // ─── Resolve registry provider for jurisdiction ─

  const jurisdiction = entity.jurisdiction || targetJurisdiction;
  const provider = registryFactory.getProvider(jurisdiction);

  if (!provider) {
    node.deadEndReason = 'no_registry_access';
    _addDeadEnd(acc, node, `No registry access for jurisdiction: ${jurisdiction}`);
    return node;
  }

  // ─── Query registry for shareholders ────────────

  try {
    let shareholders;

    if (entity.registrationNumber) {
      shareholders = await provider.getShareholders(entity.registrationNumber);
      acc.queryCounter.count++;
      node._queryCount++;
    } else {
      // Try to find by name search
      const searchResults = await provider.searchEntity({
        name: entity.name,
        jurisdiction,
      });
      acc.queryCounter.count++;
      node._queryCount++;

      if (searchResults.length === 0) {
        node.deadEndReason = 'entity_not_found';
        _addDeadEnd(acc, node, `Entity "${entity.name}" not found in ${jurisdiction} registry`);
        return node;
      }

      // Use first match
      const match = searchResults[0];
      node.registrationNumber = match.registrationNumber;

      // Check entity status
      const status = await provider.getEntityStatus(match.registrationNumber);
      node.status = status?.status;
      acc.queryCounter.count++;

      if (status?.status === 'dissolved' || status?.status === 'closed') {
        node.deadEndReason = 'entity_dissolved';
        _addDeadEnd(acc, node, `Entity "${entity.name}" is ${status.status}`);
        return node;
      }

      shareholders = await provider.getShareholders(match.registrationNumber);
      acc.queryCounter.count++;
    }

    if (!shareholders || shareholders.length === 0) {
      node.deadEndReason = 'no_shareholder_data';
      _addDeadEnd(acc, node, `No shareholder data available for "${entity.name}"`);
      return node;
    }

    // ─── Process shareholders ─────────────────────

    const currentShareholders = shareholders.filter((s) => !s.ceasedDate);

    for (const sh of currentShareholders) {
      const ownershipPct = _parsePercentage(sh.ownershipPercentage);
      const shEntityType = _isCorporate(sh) ? 'corporate' : 'individual';

      if (shEntityType === 'individual') {
        // Leaf node — individual reached
        node.children.push({
          id: `individual:${sh.name}`,
          name: sh.name,
          entityType: 'individual',
          directPercentage: ownershipPct,
          jurisdiction: sh.nationality || jurisdiction,
          children: [],
          deadEndReason: null,
          isCircular: false,
          depth: depth + 1,
        });
      } else if (ownershipPct < config.tracingThreshold) {
        // Below threshold — stop tracing but record
        node.children.push({
          id: _entityKey(sh),
          name: sh.name,
          entityType: 'corporate',
          directPercentage: ownershipPct,
          registrationNumber: sh.registrationNumber,
          jurisdiction: sh.jurisdiction || jurisdiction,
          children: [],
          deadEndReason: 'below_threshold',
          isCircular: false,
          depth: depth + 1,
        });
      } else {
        // Corporate above threshold — recurse
        const crossBorder = (sh.jurisdiction || jurisdiction) !== targetJurisdiction;
        if (crossBorder) {
          acc.fragments.push({
            type: FragmentType.UBO_CHAIN_TRACED,
            decision: `Ownership chain crosses border to ${sh.jurisdiction || 'unknown jurisdiction'} via "${sh.name}"`,
            confidence: 80,
            evidence: {
              dataSources: ['ownership-tracing'],
              dataPoints: [
                { source: 'ownership-tracing', field: 'cross_border', value: true, fetchedAt: new Date().toISOString() },
                { source: 'ownership-tracing', field: 'foreign_jurisdiction', value: sh.jurisdiction, fetchedAt: new Date().toISOString() },
              ],
            },
            status: 'pending_review',
          });
        }

        const childNode = await _traceEntity(
          { ...sh, ownershipPercentage: ownershipPct, jurisdiction: sh.jurisdiction || jurisdiction },
          depth + 1,
          new Set(visited), // Copy to allow branching
          deps,
          acc
        );

        node.children.push(childNode);
        node._queryCount += childNode._queryCount || 0;
        node._maxDepth = Math.max(node._maxDepth, childNode._maxDepth || depth + 1);
      }
    }
  } catch (err) {
    node.deadEndReason = 'registry_error';
    _addDeadEnd(acc, node, `Registry query failed for "${entity.name}": ${err.message}`);
  }

  return node;
}

/**
 * Generate a unique key for circular ownership detection.
 */
function _entityKey(entity) {
  if (entity.registrationNumber) {
    return `${entity.jurisdiction || 'unknown'}:${entity.registrationNumber}`;
  }
  return `name:${entity.name.toLowerCase().trim()}`;
}

/**
 * Record a dead end with a decision fragment.
 */
function _addDeadEnd(acc, node, reason) {
  acc.deadEnds.push({
    name: node.name,
    jurisdiction: node.jurisdiction,
    registrationNumber: node.registrationNumber,
    depth: node.depth,
    reason: node.deadEndReason,
    description: reason,
  });

  acc.fragments.push({
    type: FragmentType.UBO_DEAD_END,
    decision: reason,
    confidence: 90,
    evidence: {
      dataSources: ['ownership-tracing'],
      dataPoints: [
        { source: 'ownership-tracing', field: 'entity_name', value: node.name, fetchedAt: new Date().toISOString() },
        { source: 'ownership-tracing', field: 'dead_end_reason', value: node.deadEndReason, fetchedAt: new Date().toISOString() },
        { source: 'ownership-tracing', field: 'depth', value: node.depth, fetchedAt: new Date().toISOString() },
      ],
    },
    status: node.deadEndReason === 'circular_ownership' ? 'pending_review' : 'auto_approved',
  });
}

function _getMaxDepth(node) {
  if (!node.children || node.children.length === 0) return 0;
  return 1 + Math.max(...node.children.map(_getMaxDepth));
}

function _collectDataSources(node) {
  const sources = new Set();
  if (node.jurisdiction) sources.add(`registry:${node.jurisdiction}`);
  for (const child of node.children || []) {
    for (const source of _collectDataSources(child)) {
      sources.add(source);
    }
  }
  return Array.from(sources);
}

function _parsePercentage(pct) {
  if (typeof pct === 'number') return pct;
  if (!pct) return 0;
  const str = String(pct).toLowerCase().replace(/\s+/g, '');
  const rangeMatch = str.match(/(\d+)[^\d]+(\d+)/);
  if (rangeMatch) return (parseInt(rangeMatch[1], 10) + parseInt(rangeMatch[2], 10)) / 2;
  const orMore = str.match(/(\d+).*or\s*more/);
  if (orMore) return (parseInt(orMore[1], 10) + 100) / 2;
  const direct = str.match(/(\d+(?:\.\d+)?)/);
  if (direct) return parseFloat(direct[1]);
  return 0;
}

function _isCorporate(sh) {
  if (sh.type === 'corporate' || sh.type === 'legal-person') return true;
  if (sh.registrationNumber) return true;
  const suffixes = ['ltd', 'limited', 'plc', 'inc', 'corp', 'llc', 'llp', 'gmbh', 'ag', 'sa', 'bv', 'nv'];
  const name = (sh.name || '').toLowerCase();
  return suffixes.some((s) => name.endsWith(s) || name.includes(` ${s} `));
}

module.exports = { traceCorporateShareholders };
```

### Integration with Agent Step

```javascript
// In OwnershipUBOAgent._traceCorporateShareholders()
async _traceCorporateShareholders(context) {
  if (this._corporateToTrace.length === 0) {
    return {
      description: 'No corporate shareholders to trace — all direct shareholders are individuals',
      decisionFragments: [],
      llmCalls: [],
    };
  }

  const result = await traceCorporateShareholders(this._corporateToTrace, {
    registryFactory: this.registryFactory,
    config: {
      tracingThreshold: this.tracingThreshold,
      maxDepth: this.maxDepth,
    },
    targetJurisdiction: context.jurisdiction,
  });

  this._ownershipChains = result.chains;
  this._deadEnds = result.deadEnds;

  return {
    description: `Traced ${this._corporateToTrace.length} corporate shareholders — ${result.totalQueries} registry queries, max depth ${result.maxDepthReached}, ${result.deadEnds.length} dead ends`,
    decisionFragments: result.fragments,
    llmCalls: [],
  };
}
```

### Tracing Flow Example

```
Target: Acme Holdings Ltd (GB)
  │
  ├── John Smith (individual, 25%) → LEAF
  │
  └── HoldCo Ltd (corporate, 75%, GB:99887766)
      │
      ├── GET /company/99887766/persons-with-significant-control
      │
      ├── Jane Doe (individual, 60%) → LEAF
      │
      └── Offshore Ltd (corporate, 40%, KY)
          │
          ├── No registry access for KY → DEAD END
          │
          └── ubo_dead_end fragment: "No registry access for jurisdiction: KY"
```

### Stop Conditions

| Condition | Detection | Dead End Reason | Fragment Status |
|-----------|-----------|----------------|-----------------|
| Individual reached | `entityType === 'individual'` | — (leaf, not dead end) | — |
| Below threshold | `ownershipPct < tracingThreshold` | `below_threshold` | auto_approved |
| Max depth | `depth > config.maxDepth` | `max_depth_reached` | auto_approved |
| Circular ownership | Entity ID in `visited` set | `circular_ownership` | pending_review |
| No registry access | `registryFactory.getProvider()` returns null | `no_registry_access` | auto_approved |
| Entity not found | Search returns 0 results | `entity_not_found` | auto_approved |
| Entity dissolved | Status is dissolved/closed | `entity_dissolved` | auto_approved |
| No shareholder data | Empty shareholders list | `no_shareholder_data` | auto_approved |
| Registry error | Exception from provider | `registry_error` | auto_approved |

## Acceptance Criteria

- [ ] Step `trace_corporate_shareholders` queries registries for each corporate shareholder's owners
- [ ] Recursive tracing: corporate shareholders of corporate shareholders traced further
- [ ] Stop: individual reached (leaf node in tree)
- [ ] Stop: ownership below configurable threshold (default 10%)
- [ ] Stop: maximum depth reached (configurable, default 10)
- [ ] Stop: dead end — no registry access, entity not found, dissolved, no data
- [ ] Circular ownership detected via visited entity set, flagged with `pending_review`
- [ ] Cross-jurisdiction ownership flagged with `pending_review` fragment
- [ ] `ubo_chain_traced` fragment for each successfully traced chain
- [ ] `ubo_dead_end` fragment for each dead end with reason
- [ ] All registry queries go through data caching layer
- [ ] No corporate shareholders → step completes immediately with informational message
- [ ] Step description includes query count, max depth, and dead end count

## Dependencies

- **Depends on**: #44 (Direct ownership — `_corporateToTrace` list), #14 (Provider Interface — `getShareholders`, `searchEntity`), #15 (Companies House — UK registry), #16 (Data Caching — cached queries)
- **Blocks**: #46 (Indirect ownership — needs complete chain data)

## Testing Strategy

1. **Simple chain**: Corporate A → Individual B → verify leaf node, 1 query
2. **Two-level chain**: Corporate A → Corporate B → Individual C → verify 2 queries, depth 2
3. **Multiple branches**: Corporate A has 2 corporate shareholders → verify both traced
4. **Individual shareholder — no tracing**: All shareholders individual → verify empty chains
5. **Below threshold**: Corporate at 5% with threshold 10% → verify not traced
6. **Max depth**: Chain deeper than maxDepth → verify stopped with `max_depth_reached`
7. **Circular ownership**: Entity A → B → A → verify detected, `circular_ownership` dead end
8. **Foreign jurisdiction — no provider**: Corporate in KY, no provider → verify `no_registry_access`
9. **Entity not found**: Registry search returns 0 results → verify `entity_not_found`
10. **Dissolved entity**: Entity status is dissolved → verify `entity_dissolved`
11. **No shareholder data**: Entity found but no PSCs → verify `no_shareholder_data`
12. **Registry error**: Provider throws exception → verify `registry_error`, no crash
13. **Cross-border flag**: Chain crosses from GB to IE → verify `pending_review` fragment
14. **Caching**: Same entity queried twice in different chains → verify cache hit
15. **Fragment production**: 3 chains with 2 dead ends → verify 3 `ubo_chain_traced` + 2 `ubo_dead_end`
16. **Performance**: 5 corporate shareholders, depth 3 → verify < 30 seconds
