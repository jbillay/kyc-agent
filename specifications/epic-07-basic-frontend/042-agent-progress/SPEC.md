# Basic Frontend — Agent Progress Indicator Component

> GitHub Issue: [#42](https://github.com/jbillay/kyc-agent/issues/42)
> Epic: Basic Frontend — Phase 1 (#38)
> Size: M (1-3 days) | Priority: High

## Context

When a case is being processed, analysts need to see which agents have completed, which are currently running, and which are still pending. The Agent Progress component renders the full pipeline as a horizontal step indicator — similar to a checkout progress bar — with real-time status updates via WebSocket. Each stage shows its status (pending, running, completed, failed), the current step name for running agents, and timestamps and confidence scores for completed agents.

## Requirements

### Functional

1. `AgentProgress` component showing pipeline stages: Entity Resolution → Ownership → Screening → Risk Assessment → Review
2. Each stage shows status: pending (grey), running (animated pulse), completed (green), failed (red)
3. Within a running agent, show current step name (e.g., "Evaluating candidates...")
4. Timestamps for completed stages
5. Confidence score badge for completed stages
6. Updates in real-time via WebSocket events
7. Placed in case detail header (visible across all tabs)

### Non-Functional

- Smooth CSS transitions between status changes
- No layout shift when step names appear/disappear

## Technical Design

### File: `frontend/src/components/common/AgentProgress.vue`

```vue
<template>
  <div class="agent-progress">
    <div
      v-for="(stage, index) in stages"
      :key="stage.agentType"
      class="progress-stage"
      :class="[`status-${stage.status}`, { parallel: stage.parallel }]"
    >
      <!-- Connector line (not on first) -->
      <div v-if="index > 0" class="connector" :class="`connector-${stage.status}`" />

      <!-- Stage circle -->
      <div class="stage-icon" :class="`icon-${stage.status}`">
        <span v-if="stage.status === 'completed'" class="icon-check">&#10003;</span>
        <span v-else-if="stage.status === 'failed'" class="icon-x">&#10007;</span>
        <span v-else-if="stage.status === 'running'" class="icon-spinner" />
        <span v-else class="icon-dot" />
      </div>

      <!-- Stage info -->
      <div class="stage-info">
        <span class="stage-label">{{ stage.label }}</span>

        <!-- Running: show current step -->
        <span v-if="stage.status === 'running' && stage.currentStep" class="stage-step">
          {{ stage.currentStep }}
        </span>

        <!-- Completed: show timestamp + confidence -->
        <div v-if="stage.status === 'completed'" class="stage-meta">
          <span v-if="stage.completedAt" class="stage-time">
            {{ formatTime(stage.completedAt) }}
          </span>
          <span
            v-if="stage.confidence != null"
            class="confidence-badge"
            :class="confidenceClass(stage.confidence)"
          >
            {{ stage.confidence }}%
          </span>
        </div>

        <!-- Failed: show error hint -->
        <span v-if="stage.status === 'failed'" class="stage-error">
          Failed
        </span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { useWebSocketStore } from '../../stores/websocket';

const props = defineProps({
  caseId: { type: String, required: true },
  caseState: { type: String, required: true },
  agentEvents: { type: Array, default: () => [] },
});

const wsStore = useWebSocketStore();

// ─── Pipeline definition ─────────────────────────

const PIPELINE_STAGES = [
  { agentType: 'entity-resolution', label: 'Entity Resolution', parallel: false },
  { agentType: 'ownership-ubo', label: 'Ownership & UBO', parallel: true },
  { agentType: 'screening', label: 'Screening', parallel: true },
  { agentType: 'risk-assessment', label: 'Risk Assessment', parallel: false },
  { agentType: 'qa-agent', label: 'QA / Review', parallel: false },
];

// ─── Agent status tracking ───────────────────────

/**
 * @type {import('vue').Ref<Map<string, Object>>}
 * agentType → { status, currentStep, completedAt, confidence }
 */
const agentStatuses = ref(new Map());

/**
 * Derive stage status from case state and WebSocket events.
 */
const stages = computed(() => {
  return PIPELINE_STAGES.map((stage) => {
    const tracked = agentStatuses.value.get(stage.agentType);
    const status = tracked?.status || _inferStatus(stage.agentType, props.caseState);

    return {
      ...stage,
      status,
      currentStep: tracked?.currentStep || null,
      completedAt: tracked?.completedAt || null,
      confidence: tracked?.confidence ?? null,
    };
  });
});

/**
 * Infer agent status from the case state when no WebSocket events received yet.
 *
 * @param {string} agentType
 * @param {string} caseState
 * @returns {'pending'|'running'|'completed'}
 */
function _inferStatus(agentType, caseState) {
  const STATE_ORDER = [
    'CREATED',
    'ENTITY_RESOLUTION',
    'PARALLEL_1',
    'RISK_ASSESSMENT',
    'QA_OR_REVIEW',
    'PENDING_HUMAN_REVIEW',
    'APPROVED',
    'REJECTED',
    'ESCALATED',
    'ADDITIONAL_INFO_REQUIRED',
  ];

  const AGENT_TO_STATE = {
    'entity-resolution': 'ENTITY_RESOLUTION',
    'ownership-ubo': 'PARALLEL_1',
    'screening': 'PARALLEL_1',
    'risk-assessment': 'RISK_ASSESSMENT',
    'qa-agent': 'QA_OR_REVIEW',
  };

  const agentState = AGENT_TO_STATE[agentType];
  const currentIdx = STATE_ORDER.indexOf(caseState);
  const agentIdx = STATE_ORDER.indexOf(agentState);

  if (currentIdx < 0 || agentIdx < 0) return 'pending';
  if (currentIdx > agentIdx) return 'completed';
  if (currentIdx === agentIdx) return 'running';
  return 'pending';
}

// ─── WebSocket event handlers ────────────────────

function onAgentStarted(event) {
  if (event.caseId !== props.caseId) return;
  agentStatuses.value.set(event.agentType, {
    status: 'running',
    currentStep: null,
    completedAt: null,
    confidence: null,
  });
}

function onStepCompleted(event) {
  if (event.caseId !== props.caseId) return;
  const existing = agentStatuses.value.get(event.agentType);
  if (existing) {
    agentStatuses.value.set(event.agentType, {
      ...existing,
      currentStep: event.stepName,
    });
  }
}

function onAgentCompleted(event) {
  if (event.caseId !== props.caseId) return;
  agentStatuses.value.set(event.agentType, {
    status: event.status === 'error' ? 'failed' : 'completed',
    currentStep: null,
    completedAt: new Date().toISOString(),
    confidence: event.confidence || null,
  });
}

onMounted(() => {
  const socket = wsStore.socket;
  if (socket) {
    socket.on('case:agent_started', onAgentStarted);
    socket.on('case:agent_step_completed', onStepCompleted);
    socket.on('case:agent_completed', onAgentCompleted);
  }
});

onUnmounted(() => {
  const socket = wsStore.socket;
  if (socket) {
    socket.off('case:agent_started', onAgentStarted);
    socket.off('case:agent_step_completed', onStepCompleted);
    socket.off('case:agent_completed', onAgentCompleted);
  }
});

// ─── Helpers ─────────────────────────────────────

function formatTime(dateStr) {
  return new Date(dateStr).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function confidenceClass(confidence) {
  if (confidence >= 90) return 'confidence-high';
  if (confidence >= 70) return 'confidence-medium';
  return 'confidence-low';
}
</script>
```

### Pipeline Visualization

```
 ●──────●──┬──●──┐──●──────●
 Entity    │ Own │  Risk    QA/
 Resol.    │ UBO │  Assess  Review
           │ Scr │
           └─────┘
         (parallel)
```

### WebSocket Events Consumed

| Event | Data | Effect |
|-------|------|--------|
| `case:agent_started` | `{ caseId, agentType }` | Stage transitions to `running` (animated) |
| `case:agent_step_completed` | `{ caseId, agentType, stepName }` | Current step label updates below stage |
| `case:agent_completed` | `{ caseId, agentType, status, confidence }` | Stage transitions to `completed` (green) or `failed` (red), shows confidence badge |

### Status Inference from Case State

When the component mounts (e.g., page refresh mid-processing), there may be no WebSocket history. The `_inferStatus()` function derives each agent's status from the current case state:

| Case State | Entity Resolution | Ownership | Screening | Risk Assessment | QA |
|-----------|-------------------|-----------|-----------|----------------|-----|
| `CREATED` | pending | pending | pending | pending | pending |
| `ENTITY_RESOLUTION` | running | pending | pending | pending | pending |
| `PARALLEL_1` | completed | running | running | pending | pending |
| `RISK_ASSESSMENT` | completed | completed | completed | running | pending |
| `QA_OR_REVIEW` | completed | completed | completed | completed | running |
| `PENDING_HUMAN_REVIEW` | completed | completed | completed | completed | completed |

## Acceptance Criteria

- [ ] `AgentProgress` component renders 5 pipeline stages
- [ ] Each stage shows status: pending (grey), running (animated), completed (green), failed (red)
- [ ] Running agent shows current step name (e.g., "Evaluating candidates...")
- [ ] Completed agent shows timestamp
- [ ] Completed agent shows confidence score badge (color-coded: high ≥90, medium ≥70, low <70)
- [ ] Parallel stages (Ownership + Screening) visually indicated
- [ ] Real-time updates via WebSocket: `case:agent_started`, `case:agent_step_completed`, `case:agent_completed`
- [ ] Status inferred from case state on initial load (no WebSocket history needed)
- [ ] Component listens only to events for its own `caseId`
- [ ] Socket listeners cleaned up on unmount
- [ ] Smooth CSS transitions between status changes

## Dependencies

- **Depends on**: #39 (Dashboard — WebSocket store), #41 (Case Detail — mounts this component in header)
- **Blocks**: None (consumed by Case Detail View)

## Testing Strategy

1. **Initial render — pending**: Mount with `caseState='CREATED'`, verify all stages show "pending"
2. **Status inference — mid-processing**: Mount with `caseState='PARALLEL_1'`, verify Entity Resolution=completed, Ownership=running, Screening=running, rest=pending
3. **Status inference — completed**: Mount with `caseState='PENDING_HUMAN_REVIEW'`, verify all stages completed
4. **WebSocket — agent started**: Emit `case:agent_started`, verify stage transitions to running
5. **WebSocket — step completed**: Emit `case:agent_step_completed` with stepName, verify step label shown
6. **WebSocket — agent completed**: Emit `case:agent_completed` with confidence, verify stage=completed, badge shown
7. **WebSocket — agent failed**: Emit `case:agent_completed` with status='error', verify stage=failed (red)
8. **Event filtering**: Emit events for different caseId, verify no status change
9. **Confidence badge colors**: Test confidence 95 (high/green), 75 (medium/yellow), 50 (low/red)
10. **Cleanup**: Unmount component, verify socket.off called for all three events
11. **Smooth transitions**: Toggle status, verify CSS transition classes applied
