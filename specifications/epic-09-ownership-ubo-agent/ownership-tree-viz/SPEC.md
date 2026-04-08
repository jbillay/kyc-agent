# Ownership & UBO Agent — Ownership Tree Visualization (Frontend)

> GitHub Issue: [#48](https://github.com/jbillay/kyc-agent/issues/48)
> Epic: Ownership & UBO Mapping Agent (#43)
> Size: L (3-5 days) | Priority: Critical

## Context

The Ownership tab in the case detail view needs to render the ownership structure as an interactive visual tree. Analysts use this to quickly understand who owns the company and through which entities. The tree data comes from the Ownership Agent's `generate_ownership_tree` step — a flat `{ nodes, edges }` structure compatible with Vue Flow. Nodes are color-coded by verification status, UBOs are highlighted with badges, and dead-end nodes show why tracing stopped. The tree uses an automatic dagre layout algorithm for clean hierarchical rendering.

## Requirements

### Functional

1. Ownership tab in case detail view renders an interactive tree using Vue Flow
2. Nodes display: entity/person name, ownership percentage, jurisdiction, entity type icon
3. Node color coding: green (verified individual), blue (verified company), yellow (partially verified), red (dead end / high risk), grey (below threshold)
4. UBO nodes highlighted with a special badge
5. Dead-end nodes show reason for stoppage
6. Edges display ownership percentage
7. Click any node to see its decision fragments and metadata
8. Zoom and pan controls
9. Auto-layout algorithm (dagre) for clean top-down hierarchy

### Non-Functional

- Renders trees with up to 50 nodes smoothly
- Initial layout computed within 500ms
- Responsive to container resizing

## Technical Design

### File: `frontend/src/components/ownership/OwnershipTree.vue`

```vue
<template>
  <div class="ownership-tree">
    <!-- No data yet -->
    <div v-if="!ownershipMap" class="ownership-pending">
      <p>Ownership data is being traced by the agent...</p>
    </div>

    <!-- No tree data -->
    <div v-else-if="!ownershipMap.tree || ownershipMap.tree.nodes.length === 0" class="ownership-empty">
      <p>No ownership data available for this case.</p>
    </div>

    <template v-else>
      <!-- Summary bar -->
      <div class="ownership-summary">
        <div class="summary-item">
          <span class="summary-value">{{ ownershipMap.ubos?.length || 0 }}</span>
          <span class="summary-label">UBOs Identified</span>
        </div>
        <div class="summary-item">
          <span class="summary-value">{{ ownershipMap.tree.nodes.length }}</span>
          <span class="summary-label">Entities in Structure</span>
        </div>
        <div class="summary-item">
          <span class="summary-value">{{ ownershipMap.deadEnds?.length || 0 }}</span>
          <span class="summary-label">Dead Ends</span>
        </div>
        <div
          v-if="ownershipMap.complexityAssessment"
          class="summary-item"
          :class="`complexity-${ownershipMap.complexityAssessment.overallComplexity}`"
        >
          <span class="summary-value">{{ ownershipMap.complexityAssessment.overallComplexity }}</span>
          <span class="summary-label">Structure Complexity</span>
        </div>
      </div>

      <!-- Vue Flow Tree -->
      <div class="tree-container" ref="treeContainer">
        <VueFlow
          :nodes="layoutNodes"
          :edges="layoutEdges"
          :default-viewport="{ zoom: 0.8, x: 0, y: 0 }"
          :min-zoom="0.2"
          :max-zoom="2"
          fit-view-on-init
          @node-click="onNodeClick"
        >
          <template #node-target="nodeProps">
            <OwnershipNode :node="nodeProps" variant="target" />
          </template>
          <template #node-corporate="nodeProps">
            <OwnershipNode :node="nodeProps" variant="corporate" />
          </template>
          <template #node-individual="nodeProps">
            <OwnershipNode :node="nodeProps" variant="individual" />
          </template>

          <Controls />
          <MiniMap />
        </VueFlow>
      </div>

      <!-- Node detail panel -->
      <div v-if="selectedNode" class="node-detail-panel">
        <div class="panel-header">
          <h3>{{ selectedNode.label }}</h3>
          <button class="btn-close" @click="selectedNode = null">&times;</button>
        </div>
        <div class="panel-body">
          <table class="detail-table">
            <tr>
              <td>Type</td>
              <td>{{ selectedNode.type }}</td>
            </tr>
            <tr>
              <td>Ownership</td>
              <td>{{ selectedNode.data.ownershipPercentage.toFixed(1) }}%</td>
            </tr>
            <tr>
              <td>Jurisdiction</td>
              <td>{{ selectedNode.data.jurisdiction || '—' }}</td>
            </tr>
            <tr v-if="selectedNode.data.isUBO">
              <td>UBO Status</td>
              <td class="ubo-confirmed">Confirmed UBO</td>
            </tr>
            <tr v-if="selectedNode.data.isDeadEnd">
              <td>Dead End Reason</td>
              <td class="dead-end-reason">{{ formatDeadEndReason(selectedNode.data.deadEndReason) }}</td>
            </tr>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { VueFlow, Controls, MiniMap } from '@vue-flow/core';
import dagre from 'dagre';
import OwnershipNode from './OwnershipNode.vue';

const props = defineProps({
  ownershipMap: { type: Object, default: null },
});

const selectedNode = ref(null);

/**
 * Apply dagre layout to position nodes in a top-down hierarchy.
 */
const layoutNodes = computed(() => {
  if (!props.ownershipMap?.tree?.nodes) return [];

  const { nodes, edges } = props.ownershipMap.tree;
  const positions = _calculateLayout(nodes, edges);

  return nodes.map((node) => ({
    ...node,
    position: positions.get(node.id) || { x: 0, y: 0 },
    type: node.type, // Vue Flow uses type to select template
  }));
});

const layoutEdges = computed(() => {
  if (!props.ownershipMap?.tree?.edges) return [];

  return props.ownershipMap.tree.edges.map((edge) => ({
    ...edge,
    type: 'smoothstep',
    animated: false,
    labelStyle: { fontSize: '11px', fontWeight: 'bold' },
    style: { strokeWidth: 2 },
  }));
});

/**
 * Calculate node positions using dagre layout algorithm.
 *
 * @param {Object[]} nodes
 * @param {Object[]} edges
 * @returns {Map<string, { x: number, y: number }>}
 */
function _calculateLayout(nodes, edges) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: 'TB',  // Top to bottom
    nodesep: 80,
    ranksep: 100,
    edgesep: 20,
    marginx: 20,
    marginy: 20,
  });

  for (const node of nodes) {
    g.setNode(node.id, { width: 220, height: 80 });
  }

  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const positions = new Map();
  for (const node of nodes) {
    const pos = g.node(node.id);
    positions.set(node.id, {
      x: pos.x - 110, // Center the node (half of width)
      y: pos.y - 40,   // Center the node (half of height)
    });
  }

  return positions;
}

function onNodeClick(event) {
  selectedNode.value = event.node;
}

function formatDeadEndReason(reason) {
  const labels = {
    max_depth_reached: 'Maximum tracing depth reached',
    circular_ownership: 'Circular ownership detected',
    no_registry_access: 'No registry access for this jurisdiction',
    entity_not_found: 'Entity not found in registry',
    entity_dissolved: 'Entity is dissolved/closed',
    no_shareholder_data: 'No shareholder data available',
    registry_error: 'Registry query failed',
    below_threshold: 'Ownership below tracing threshold',
  };
  return labels[reason] || reason || 'Unknown';
}
</script>
```

### File: `frontend/src/components/ownership/OwnershipNode.vue`

```vue
<template>
  <div
    class="ownership-node"
    :class="[
      `node-${variant}`,
      `status-${node.data.status}`,
      { 'node-ubo': node.data.isUBO },
      { 'node-dead-end': node.data.isDeadEnd },
    ]"
  >
    <!-- UBO badge -->
    <span v-if="node.data.isUBO" class="ubo-badge">UBO</span>

    <!-- Entity type icon -->
    <span class="node-icon">{{ typeIcon }}</span>

    <!-- Name -->
    <span class="node-name" :title="node.label">{{ truncatedName }}</span>

    <!-- Ownership percentage -->
    <span class="node-percentage">{{ node.data.ownershipPercentage.toFixed(1) }}%</span>

    <!-- Jurisdiction flag -->
    <span v-if="node.data.jurisdiction" class="node-jurisdiction">
      {{ jurisdictionFlag }}
    </span>

    <!-- Dead-end indicator -->
    <span v-if="node.data.isDeadEnd" class="dead-end-icon" :title="node.data.deadEndReason">
      &#9888;
    </span>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  node: { type: Object, required: true },
  variant: { type: String, required: true }, // 'target' | 'corporate' | 'individual'
});

const typeIcon = computed(() => {
  switch (props.variant) {
    case 'target': return '🏢';
    case 'corporate': return '🏛️';
    case 'individual': return '👤';
    default: return '❓';
  }
});

const truncatedName = computed(() => {
  const name = props.node.label || '';
  return name.length > 25 ? name.substring(0, 22) + '...' : name;
});

const jurisdictionFlag = computed(() => {
  const code = props.node.data.jurisdiction;
  if (!code || code.length !== 2) return code || '';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
});
</script>
```

### Node Color Coding

| Status | Node Color | When |
|--------|-----------|------|
| `verified` (individual) | Green | Individual with full data |
| `verified` (corporate) | Blue | Corporate entity with traced shareholders |
| `partial` | Yellow | Corporate entity only partially traced |
| `dead_end` | Red | Tracing stopped (no registry, dissolved, etc.) |
| `below_threshold` | Grey | Corporate below tracing threshold |

| Special Marker | Visual |
|---------------|--------|
| UBO | Gold badge with "UBO" text overlaid on node |
| Dead end | Warning icon (⚠️) with tooltip showing reason |
| Target entity | Distinct styling (larger node, bold border) |

### Dependencies (npm packages)

```json
{
  "@vue-flow/core": "^1.x",
  "dagre": "^0.8.x"
}
```

## Acceptance Criteria

- [ ] Ownership tab renders interactive tree using Vue Flow (`@vue-flow/core`)
- [ ] Auto-layout via dagre (top-down hierarchy)
- [ ] Nodes display: name, ownership %, jurisdiction flag, entity type icon
- [ ] Node color coding: green (verified individual), blue (verified corporate), yellow (partial), red (dead end), grey (below threshold)
- [ ] UBO nodes highlighted with special badge
- [ ] Dead-end nodes show warning icon with reason on tooltip
- [ ] Edges display ownership percentage as label
- [ ] Click node opens detail panel with metadata
- [ ] Zoom and pan controls present
- [ ] MiniMap for navigation on large trees
- [ ] Summary bar: UBO count, entity count, dead end count, complexity rating
- [ ] "Processing" message when ownership data not yet available
- [ ] "No data" message when tree is empty
- [ ] Handles trees with up to 50 nodes smoothly
- [ ] Responsive to container resizing

## Dependencies

- **Depends on**: #47 (Tree generation — produces `{ nodes, edges }` data), #41 (Case Detail View — Ownership tab), `@vue-flow/core` package, `dagre` package
- **Blocks**: None

## Testing Strategy

1. **Pending state**: Mount with null ownershipMap, verify "being traced" message
2. **Empty tree**: Mount with empty nodes array, verify "no data" message
3. **Summary bar**: Mount with ownershipMap, verify UBO count, entity count, dead end count
4. **Complexity rating**: Mount with complexityAssessment, verify rating displayed
5. **Node rendering — target**: Root node has "target" variant styling
6. **Node rendering — individual**: Individual node is green with person icon
7. **Node rendering — corporate**: Corporate node is blue with building icon
8. **Node rendering — dead end**: Dead-end node is red with warning icon
9. **Node rendering — UBO**: UBO node has gold badge
10. **Edge labels**: Verify ownership percentage shown on edges
11. **Node click**: Click a node, verify detail panel opens with correct metadata
12. **Detail panel close**: Click close button, verify panel hidden
13. **Dead-end reason**: Dead-end node detail shows human-readable reason
14. **Dagre layout**: Verify nodes are positioned top-to-bottom hierarchy
15. **Large tree**: 30-node tree, verify renders without performance issues
16. **Name truncation**: Node with name > 25 chars, verify truncated with ellipsis
