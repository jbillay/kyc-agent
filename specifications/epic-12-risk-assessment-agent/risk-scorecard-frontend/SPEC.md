# Risk Scorecard and Narrative Display — Frontend

> GitHub Issue: [#60](https://github.com/jbillay/kyc-agent/issues/60)
> Epic: Risk Assessment Agent (#56)
> Size: L (3-5 days) | Priority: Critical

## Context

The Risk Assessment tab in the case detail view displays the output of the Risk Assessment Agent: a visual scorecard with a color-coded gauge, a score breakdown by risk category, individual risk factors with explanations, and the generated risk narrative with clickable fragment references. This is the primary interface for KYC reviewers to understand the automated risk assessment before making their review decision.

Data comes from the `agent_results` table where `agent_type = 'risk-assessment'`, which contains the `RiskAssessment` JSONB output including score, rating, breakdown, factors, narrative, and review path.

## Requirements

### Functional

1. **Risk Assessment Tab** (`RiskAssessmentTab.vue`):
   - New tab in the case detail view, positioned after Screening and Documents tabs
   - Shows a loading state while the risk assessment agent is running
   - Shows an empty state if the risk assessment agent has not run yet
   - Shows an error state if the agent failed
   - Fetches risk assessment data from `GET /api/v1/cases/:id/agent-results?agent_type=risk-assessment`
   - Listens for WebSocket events `agent:step-completed` and `agent:completed` for `risk-assessment` agent type to update in real-time

2. **Risk Gauge** (`RiskGauge.vue`):
   - Displays the overall risk score (0-100) as a circular gauge or semi-circular meter
   - Color-coded by rating:
     - low (0-25): green
     - medium (26-50): amber/yellow
     - high (51-75): orange
     - very_high (76-100): red
   - Rating badge displayed prominently below the gauge (e.g., "medium" in an amber badge)
   - Confidence percentage shown as secondary text (e.g., "Confidence: 78%")
   - Recommended due diligence level displayed (e.g., "Recommended DD: Standard")

3. **Risk Breakdown** (`RiskBreakdown.vue`):
   - Horizontal bar chart or stacked bar showing score contribution per category:
     - Country Risk
     - Industry Risk
     - Ownership Risk
     - Screening Risk
   - Each bar labeled with the category name and its score contribution (e.g., "Country: 15")
   - Bars color-coded by category (consistent colors across the UI)
   - Total score shown at the bottom
   - Uses a chart library compatible with Vue.js (Chart.js via PrimeVue chart component, or a lightweight alternative)

4. **Risk Factors List** (`RiskFactorsList.vue`):
   - Lists all identified risk factors (both rule-engine and LLM-identified)
   - Each factor shows:
     - Category badge (country, industry, ownership, screening, llm_analysis)
     - Description text
     - Score contribution (e.g., "+30" for rule factors, "qualitative" for LLM factors)
     - Impact indicator for LLM factors: ↑ increase (red), ↓ decrease (green), — neutral (gray)
     - Severity badge for LLM factors: high/medium/low
   - Rule-engine factors and LLM factors visually distinguished (e.g., different background or icon)
   - Factors sorted by score contribution descending (rule factors first, then LLM factors)

5. **Risk Narrative** (`RiskNarrative.vue`):
   - Displays the generated narrative as formatted text
   - `[ref:fragment_id]` markers rendered as clickable inline links/chips
   - Clicking a fragment reference opens a `FragmentPopover` with the full decision fragment details:
     - Fragment type
     - Decision text
     - Confidence score
     - Evidence data sources and data points
     - Status (auto_approved, pending_review, overridden)
     - Created timestamp
   - If narrative is null (generation failed), shows a notice: "Risk narrative could not be generated. Please review the risk factors and score breakdown above."

6. **Fragment Popover** (`FragmentPopover.vue`):
   - Positioned relative to the clicked reference (popover or sidebar panel)
   - Shows full fragment details (type, decision, confidence, evidence, status)
   - Evidence data points displayed as a simple key-value table
   - Close button or click-outside-to-dismiss
   - Fetches fragment data from `GET /api/v1/cases/:id/fragments/:fragmentId` (or from locally cached fragments)

7. **Review Path Display**:
   - Prominent banner or card at the top of the Risk Assessment tab showing:
     - Assigned review path (QA Agent / Human Reviewer / Senior Analyst)
     - Color-coded by review path (green for QA, amber for human, red for senior)
   - If `review_path` is `qa_agent`, show a note: "This case qualifies for automated QA review"

### Non-Functional

- Risk data renders within 200ms after API response received
- Gauge animation is smooth (CSS transition or SVG animation)
- Chart renders without layout shift
- Fragment popover opens within 100ms of click
- Responsive: Risk gauge and breakdown stack vertically on narrow screens
- Accessible: gauge value and rating announced by screen readers, chart has alt text

## Technical Design

### File: `frontend/src/components/risk-assessment/RiskAssessmentTab.vue`

```vue
<template>
  <div class="risk-assessment-tab">
    <!-- Loading state -->
    <div v-if="loading" class="loading-state">
      <ProgressSpinner />
      <p>Risk assessment in progress...</p>
    </div>

    <!-- Empty state -->
    <div v-else-if="!riskData" class="empty-state">
      <p>Risk assessment has not been performed yet.</p>
      <p>The risk assessment agent runs after entity resolution, ownership, screening, and document analysis are complete.</p>
    </div>

    <!-- Error state -->
    <div v-else-if="error" class="error-state">
      <p>Risk assessment failed: {{ error }}</p>
    </div>

    <!-- Risk assessment results -->
    <div v-else class="risk-results">
      <!-- Review path banner -->
      <div :class="['review-path-banner', `review-path-${riskData.reviewPath}`]">
        <span class="review-path-label">Review Assignment:</span>
        <span class="review-path-value">{{ formatReviewPath(riskData.reviewPath) }}</span>
        <span v-if="riskData.reviewPath === 'qa_agent'" class="review-path-note">
          This case qualifies for automated QA review
        </span>
      </div>

      <!-- Top row: gauge + breakdown -->
      <div class="risk-overview">
        <RiskGauge
          :score="riskData.riskScore"
          :rating="riskData.riskRating"
          :confidence="riskData.confidence"
          :dd-level="riskData.recommendedDDLevel"
        />
        <RiskBreakdown :breakdown="riskData.scoreBreakdown" :total="riskData.riskScore" />
      </div>

      <!-- Risk factors -->
      <RiskFactorsList
        :rule-factors="ruleFactors"
        :llm-factors="riskData.llmFactors"
      />

      <!-- Narrative -->
      <RiskNarrative
        :narrative="riskData.narrative"
        :case-id="caseId"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import { useCaseStore } from '@/stores/case';
import { useSocket } from '@/composables/useSocket';
import RiskGauge from './RiskGauge.vue';
import RiskBreakdown from './RiskBreakdown.vue';
import RiskFactorsList from './RiskFactorsList.vue';
import RiskNarrative from './RiskNarrative.vue';

const route = useRoute();
const caseStore = useCaseStore();
const socket = useSocket();

const caseId = computed(() => route.params.id);
const loading = ref(true);
const error = ref(null);
const riskData = ref(null);

// Extract rule factors from decision fragments
const ruleFactors = computed(() => {
  if (!caseStore.fragments) return [];
  return caseStore.fragments
    .filter((f) => f.type === 'risk_factor_identified')
    .sort((a, b) => {
      // Parse score from decision text "+NN" pattern
      const scoreA = parseInt((a.decision.match(/\+(\d+)/) || [])[1]) || 0;
      const scoreB = parseInt((b.decision.match(/\+(\d+)/) || [])[1]) || 0;
      return scoreB - scoreA;
    });
});

function formatReviewPath(path) {
  const labels = {
    qa_agent: 'QA Agent (Automated)',
    human_reviewer: 'Human Reviewer',
    senior_analyst: 'Senior Analyst',
  };
  return labels[path] || path;
}

async function fetchRiskData() {
  try {
    loading.value = true;
    const result = await caseStore.fetchAgentResult(caseId.value, 'risk-assessment');
    if (result) {
      riskData.value = result.output;
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

function onAgentCompleted(data) {
  if (data.caseId === caseId.value && data.agentType === 'risk-assessment') {
    fetchRiskData();
  }
}

onMounted(() => {
  fetchRiskData();
  socket.on('agent:completed', onAgentCompleted);
});

onUnmounted(() => {
  socket.off('agent:completed', onAgentCompleted);
});
</script>
```

### File: `frontend/src/components/risk-assessment/RiskGauge.vue`

```vue
<template>
  <div class="risk-gauge">
    <svg viewBox="0 0 200 120" class="gauge-svg">
      <!-- Background arc -->
      <path
        d="M 20 100 A 80 80 0 0 1 180 100"
        fill="none"
        stroke="#e5e7eb"
        stroke-width="12"
        stroke-linecap="round"
      />
      <!-- Score arc -->
      <path
        :d="scoreArcPath"
        fill="none"
        :stroke="ratingColor"
        stroke-width="12"
        stroke-linecap="round"
        class="score-arc"
      />
      <!-- Score text -->
      <text x="100" y="85" text-anchor="middle" class="score-text">{{ score }}</text>
      <text x="100" y="100" text-anchor="middle" class="score-label">/100</text>
    </svg>

    <div :class="['rating-badge', `rating-${rating.toLowerCase()}`]">
      {{ rating }}
    </div>

    <div class="gauge-details">
      <span class="confidence">Confidence: {{ confidence }}%</span>
      <span class="dd-level">Recommended DD: {{ formatDDLevel(ddLevel) }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  score: { type: Number, required: true },
  rating: { type: String, required: true },
  confidence: { type: Number, required: true },
  ddLevel: { type: String, required: true },
});

const RATING_COLORS = {
  low: '#22c55e',
  medium: '#f59e0b',
  high: '#f97316',
  very_high: '#ef4444',
};

const ratingColor = computed(() => RATING_COLORS[props.rating] || '#6b7280');

const scoreArcPath = computed(() => {
  // Semi-circle arc from 180° to 0° (left to right), proportional to score
  const pct = Math.min(100, Math.max(0, props.score)) / 100;
  const angle = Math.PI * (1 - pct); // 180° to 0°
  const x = 100 + 80 * Math.cos(angle);
  const y = 100 - 80 * Math.sin(angle);
  const largeArc = pct > 0.5 ? 1 : 0;
  return `M 20 100 A 80 80 0 ${largeArc} 1 ${x} ${y}`;
});

function formatDDLevel(level) {
  return level ? level.charAt(0).toUpperCase() + level.slice(1) : '';
}
</script>
```

### File: `frontend/src/components/risk-assessment/RiskBreakdown.vue`

```vue
<template>
  <div class="risk-breakdown">
    <h3>Score Breakdown</h3>
    <div class="breakdown-bars">
      <div v-for="(value, category) in breakdown" :key="category" class="breakdown-row">
        <span class="category-label">{{ formatCategory(category) }}</span>
        <div class="bar-container">
          <div
            class="bar-fill"
            :style="{ width: barWidth(value), backgroundColor: categoryColor(category) }"
          />
        </div>
        <span class="category-score">{{ value }}</span>
      </div>
    </div>
    <div class="breakdown-total">
      <span>Total</span>
      <span class="total-score">{{ total }}/100</span>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  breakdown: { type: Object, required: true },
  total: { type: Number, required: true },
});

const CATEGORY_COLORS = {
  country: '#6366f1',
  industry: '#8b5cf6',
  ownership: '#ec4899',
  screening: '#ef4444',
};

const CATEGORY_LABELS = {
  country: 'Country Risk',
  industry: 'Industry Risk',
  ownership: 'Ownership Risk',
  screening: 'Screening Risk',
};

function formatCategory(cat) {
  return CATEGORY_LABELS[cat] || cat;
}

function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || '#6b7280';
}

function barWidth(value) {
  const maxBar = Math.max(100, props.total);
  return `${Math.min(100, (value / maxBar) * 100)}%`;
}
</script>
```

### File: `frontend/src/components/risk-assessment/RiskNarrative.vue`

```vue
<template>
  <div class="risk-narrative">
    <h3>Risk Assessment Narrative</h3>

    <div v-if="!narrative" class="narrative-missing">
      Risk narrative could not be generated. Please review the risk factors and score breakdown above.
    </div>

    <div v-else class="narrative-text">
      <template v-for="(segment, idx) in parsedNarrative" :key="idx">
        <span v-if="segment.type === 'text'">{{ segment.value }}</span>
        <button
          v-else-if="segment.type === 'ref'"
          class="fragment-ref"
          @click="openFragment(segment.fragmentId)"
        >
          [{{ segment.fragmentId.slice(0, 8) }}...]
        </button>
      </template>
    </div>

    <FragmentPopover
      v-if="activeFragment"
      :fragment="activeFragment"
      :position="popoverPosition"
      @close="activeFragment = null"
    />
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useCaseStore } from '@/stores/case';
import FragmentPopover from './FragmentPopover.vue';

const props = defineProps({
  narrative: { type: String, default: null },
  caseId: { type: String, required: true },
});

const caseStore = useCaseStore();
const activeFragment = ref(null);
const popoverPosition = ref({ x: 0, y: 0 });

/**
 * Parse narrative text into segments: plain text and [ref:id] references.
 */
const parsedNarrative = computed(() => {
  if (!props.narrative) return [];

  const segments = [];
  const refPattern = /\[ref:([a-f0-9-]+)\]/g;
  let lastIndex = 0;
  let match;

  while ((match = refPattern.exec(props.narrative)) !== null) {
    // Text before the reference
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: props.narrative.slice(lastIndex, match.index) });
    }
    // The reference itself
    segments.push({ type: 'ref', fragmentId: match[1] });
    lastIndex = match.index + match[0].length;
  }

  // Remaining text
  if (lastIndex < props.narrative.length) {
    segments.push({ type: 'text', value: props.narrative.slice(lastIndex) });
  }

  return segments;
});

async function openFragment(fragmentId) {
  // Try local cache first
  let fragment = caseStore.fragments?.find((f) => f.id === fragmentId);
  if (!fragment) {
    fragment = await caseStore.fetchFragment(props.caseId, fragmentId);
  }
  activeFragment.value = fragment;
}
</script>
```

### File: `frontend/src/components/risk-assessment/FragmentPopover.vue`

```vue
<template>
  <div class="fragment-popover" v-if="fragment" @click.stop>
    <div class="popover-header">
      <span class="fragment-type-badge">{{ fragment.type }}</span>
      <button class="close-btn" @click="$emit('close')">×</button>
    </div>

    <div class="popover-body">
      <div class="field">
        <label>Decision</label>
        <p>{{ fragment.decision }}</p>
      </div>

      <div class="field">
        <label>Confidence</label>
        <span :class="['confidence-badge', confidenceClass]">{{ fragment.confidence }}%</span>
      </div>

      <div class="field">
        <label>Status</label>
        <span :class="['status-badge', `status-${fragment.status}`]">{{ fragment.status }}</span>
      </div>

      <div v-if="fragment.evidence?.dataPoints?.length" class="field">
        <label>Evidence</label>
        <table class="evidence-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Field</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(dp, idx) in fragment.evidence.dataPoints" :key="idx">
              <td>{{ dp.source }}</td>
              <td>{{ dp.field }}</td>
              <td>{{ dp.value }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="field">
        <label>Created</label>
        <span>{{ formatDate(fragment.created_at) }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  fragment: { type: Object, default: null },
  position: { type: Object, default: () => ({ x: 0, y: 0 }) },
});

defineEmits(['close']);

const confidenceClass = computed(() => {
  if (props.fragment?.confidence >= 80) return 'confidence-high';
  if (props.fragment?.confidence >= 50) return 'confidence-medium';
  return 'confidence-low';
});

function formatDate(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleString();
}
</script>
```

## Acceptance Criteria

- [ ] Risk Assessment tab appears in case detail view after Screening and Documents tabs
- [ ] Tab shows loading state while risk assessment agent is running
- [ ] Tab shows empty state if risk assessment has not run
- [ ] Tab shows error state if agent failed
- [ ] Risk gauge displays score 0-100 with color-coded arc (green/amber/orange/red)
- [ ] Rating badge (low/medium/high/very_high) displayed below gauge
- [ ] Confidence percentage shown
- [ ] Recommended DD level shown (Simplified/Standard/Enhanced)
- [ ] Score breakdown chart shows per-category contributions (country, industry, ownership, screening)
- [ ] Category bars labeled with name and score
- [ ] Risk factors list shows all rule-engine and LLM-identified factors
- [ ] Each factor shows category, description, score contribution
- [ ] LLM factors show impact direction and severity
- [ ] Narrative displayed as formatted text
- [ ] `[ref:fragment_id]` markers rendered as clickable inline elements
- [ ] Clicking a fragment reference opens a popover with full fragment details
- [ ] Fragment popover shows type, decision, confidence, evidence table, status, timestamp
- [ ] Popover dismissed by close button or click-outside
- [ ] Review path banner at top of tab (QA Agent / Human Reviewer / Senior Analyst)
- [ ] Real-time updates via WebSocket when risk assessment agent completes
- [ ] Responsive layout on narrow screens
- [ ] Accessible: gauge value readable by screen readers

## Dependencies

- **Depends on**: #58 (Rule engine + LLM analysis — defines `RiskAssessment` output shape), #59 (Narrative generation — provides narrative text with fragment refs), #41 (Case Detail View — provides tab container), #36 (WebSocket events — for real-time updates), #35 (Decision Fragments API — for fetching individual fragments)
- **Blocks**: None (final frontend story in the epic)

## Testing Strategy

1. **Full render — medium risk**: RiskAssessment with score 42, medium → gauge shows amber arc at ~42%, medium badge, breakdown shows 4 categories
2. **Full render — very high risk**: Score 100, very_high → gauge shows full red arc, very_high badge, enhanced DD recommendation
3. **Score gauge — boundary values**: Score 0 → no arc; score 25 → green quarter arc; score 100 → full red arc
4. **Rating colors**: low → green, medium → amber, high → orange, very_high → red
5. **Breakdown chart**: Breakdown `{ country: 15, industry: 10, ownership: 5, screening: 0 }` → 3 visible bars, total 30
6. **Risk factors — rule engine**: 3 rule factors → listed with category badge and "+NN" score
7. **Risk factors — LLM**: 2 LLM factors (1 increase/high, 1 decrease/medium) → listed with impact arrows and severity
8. **Narrative rendering**: Text with `[ref:abc-123]` → rendered as clickable chip "[abc-123...]"
9. **Fragment popover — open**: Click fragment ref → popover shows fragment details with evidence table
10. **Fragment popover — close**: Click close button → popover dismissed
11. **Null narrative**: narrative is null → notice message displayed
12. **Review path — qa_agent**: Shows "QA Agent (Automated)" in green banner with automated review note
13. **Review path — senior_analyst**: Shows "Senior Analyst" in red banner
14. **Loading state**: Risk assessment agent running → spinner shown
15. **Empty state**: No risk assessment result → informational message shown
16. **WebSocket update**: `agent:completed` event for risk-assessment → tab refreshes data
17. **Responsive layout**: Narrow viewport → gauge and breakdown stack vertically
