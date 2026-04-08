# Review Queue Interface

> GitHub Issue: [#64](https://github.com/jbillay/kyc-agent/issues/64)
> Epic: Human Review Workflow (#61)
> Size: L (3-5 days) | Priority: Critical

## Context

The review queue is the entry point for human reviewers into the KYC case review workflow. It provides a dedicated page at `/review` showing all cases assigned to the current reviewer (or all pending cases for senior analysts). Cases are sorted by priority — highest risk first, oldest first as tiebreaker — so reviewers work the most urgent cases first.

The queue surfaces key metadata for triage: entity name, risk rating (color-coded), processing time, QA status, and fragment review progress. It also shows workload statistics so managers can monitor the review backlog. QA-passed cases are visually distinguished and can be opened in a streamlined review mode (just confirm or reject).

## Requirements

### Functional

1. Review page at `/review` accessible to `analyst+` roles
2. List of cases in `PENDING_HUMAN_REVIEW` state assigned to the current user
3. Each case card displays: entity name, jurisdiction, risk rating (color-coded), processing time, QA status, fragment count / reviewed count
4. Priority sorting: highest risk first, oldest first as tiebreaker
5. Filters: risk level (low/medium/high/very_high), QA status (passed/failed/not_applicable), case age
6. Workload statistics panel: total pending, by risk level, QA passed count
7. One-click to open case in review mode (navigates to case detail with review overlay)
8. QA-passed cases visually distinguished (e.g., badge or green indicator)
9. Streamlined view option for QA-passed cases (simplified confirm/reject)
10. Cursor-based pagination for large queues
11. Real-time updates via WebSocket: new assignments appear, completed reviews disappear

### Non-Functional

- Page loads within 500ms for up to 200 pending cases
- Real-time updates reflect within 2 seconds of event
- Responsive layout: works on 1280px+ screens (desktop-focused workflow)

## Technical Design

### File: `frontend/src/views/ReviewQueue.vue`

```vue
<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { useReviewStore } from '@/stores/review';
import { useSocketStore } from '@/stores/socket';
import ReviewCaseList from '@/components/review/ReviewCaseList.vue';
import ReviewFilters from '@/components/review/ReviewFilters.vue';
import WorkloadStats from '@/components/review/WorkloadStats.vue';

const router = useRouter();
const reviewStore = useReviewStore();
const socketStore = useSocketStore();

const filters = ref({
  riskRating: null,
  qaStatus: null,
  sortBy: 'risk_score',
  sortOrder: 'desc',
});

const loading = ref(false);

onMounted(async () => {
  loading.value = true;
  await reviewStore.fetchQueue(filters.value);
  loading.value = false;

  // Real-time: new assignments and completed reviews
  socketStore.on('case:review_assigned', handleNewAssignment);
  socketStore.on('case:state_changed', handleStateChanged);
});

onUnmounted(() => {
  socketStore.off('case:review_assigned', handleNewAssignment);
  socketStore.off('case:state_changed', handleStateChanged);
});

async function handleNewAssignment({ caseId }) {
  await reviewStore.fetchQueue(filters.value);
}

function handleStateChanged({ caseId, newState }) {
  if (newState !== 'PENDING_HUMAN_REVIEW') {
    reviewStore.removeCaseFromQueue(caseId);
  }
}

async function applyFilters(newFilters) {
  filters.value = { ...filters.value, ...newFilters };
  loading.value = true;
  await reviewStore.fetchQueue(filters.value);
  loading.value = false;
}

function openCase(caseId, qaStatus) {
  const mode = qaStatus === 'passed' ? 'streamlined' : 'full';
  router.push({ name: 'case-detail', params: { id: caseId }, query: { review: mode } });
}

async function loadMore() {
  await reviewStore.fetchNextPage(filters.value);
}
</script>
```

### File: `frontend/src/components/review/ReviewCaseList.vue`

```vue
<script setup>
/**
 * ReviewCaseList — displays the list of cases pending review.
 *
 * Props:
 *   cases: Array — review queue cases from the store
 *   loading: Boolean — loading state
 *
 * Emits:
 *   open-case(caseId, qaStatus) — when reviewer clicks a case
 *   load-more() — when user scrolls to bottom
 *
 * Each case row shows:
 *   - Entity name + jurisdiction flag
 *   - Risk rating badge (color-coded: green/yellow/orange/red)
 *   - Processing time (humanized: "2h 15m")
 *   - QA status badge (passed=green checkmark, failed=yellow warning, n/a=grey)
 *   - Fragment progress ("15/23 reviewed")
 *   - "Open Review" button
 */

defineProps({
  cases: { type: Array, required: true },
  loading: { type: Boolean, default: false },
});

defineEmits(['open-case', 'load-more']);

/**
 * Risk rating → color mapping for badges.
 */
function riskColor(rating) {
  const colors = {
    low: 'success',
    medium: 'warning',
    high: 'danger',
    very_high: 'danger',
  };
  return colors[rating] || 'info';
}

/**
 * Format milliseconds to human-readable duration.
 */
function formatDuration(ms) {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
</script>
```

### File: `frontend/src/components/review/ReviewFilters.vue`

```vue
<script setup>
/**
 * ReviewFilters — filter controls for the review queue.
 *
 * Props:
 *   modelValue: Object — current filter state
 *
 * Emits:
 *   update:modelValue(filters) — when filters change
 *
 * Filter options:
 *   - Risk level: dropdown (all, low, medium, high, very_high)
 *   - QA status: dropdown (all, passed, failed, not_applicable)
 *   - Sort: dropdown (risk_score desc, created_at asc)
 */

defineProps({
  modelValue: { type: Object, required: true },
});

defineEmits(['update:modelValue']);
</script>
```

### File: `frontend/src/components/review/WorkloadStats.vue`

```vue
<script setup>
/**
 * WorkloadStats — displays review queue workload statistics.
 *
 * Props:
 *   stats: Object — { totalPending, highRisk, mediumRisk, lowRisk, qaPassed }
 *
 * Renders:
 *   - Total pending count (large number)
 *   - Breakdown by risk level (colored badges with counts)
 *   - QA pre-validated count
 */

defineProps({
  stats: { type: Object, required: true },
});
</script>
```

### File: `frontend/src/components/review/StreamlinedReview.vue`

```vue
<script setup>
/**
 * StreamlinedReview — simplified review view for QA-passed cases.
 *
 * Displayed when a reviewer opens a QA-passed case.
 * Shows a condensed summary:
 *   - Entity name + risk score (should be low)
 *   - QA summary text (all checks passed)
 *   - Risk narrative (read-only)
 *   - Two buttons: "Confirm & Approve" (green) and "Reject / Full Review" (red)
 *
 * "Confirm & Approve" calls POST /api/v1/review/:caseId/approve
 * "Reject / Full Review" switches to the full review mode (fragment-level)
 *
 * Props:
 *   caseId: String — case ID
 *   caseData: Object — full case details
 *   qaReport: Object — QA report from qa-agent results
 */

import { ref } from 'vue';
import { useReviewStore } from '@/stores/review';

defineProps({
  caseId: { type: String, required: true },
  caseData: { type: Object, required: true },
  qaReport: { type: Object, required: true },
});

const emit = defineEmits(['switch-to-full-review', 'case-approved']);

const reviewStore = useReviewStore();
const confirming = ref(false);

async function confirmApprove() {
  confirming.value = true;
  await reviewStore.approveCase(props.caseId);
  emit('case-approved');
  confirming.value = false;
}

function switchToFullReview() {
  emit('switch-to-full-review');
}
</script>
```

### File: `frontend/src/stores/review.js`

```javascript
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import api from '@/services/api';

export const useReviewStore = defineStore('review', () => {
  const queue = ref([]);
  const stats = ref({ totalPending: 0, highRisk: 0, mediumRisk: 0, lowRisk: 0, qaPassed: 0 });
  const nextCursor = ref(null);
  const total = ref(0);

  async function fetchQueue(filters) {
    const params = {
      ...(filters.riskRating && { riskRating: filters.riskRating }),
      ...(filters.qaStatus && { qaStatus: filters.qaStatus }),
      sortBy: filters.sortBy || 'risk_score',
      sortOrder: filters.sortOrder || 'desc',
      limit: 50,
    };

    const response = await api.get('/review/queue', { params });
    queue.value = response.data.cases;
    stats.value = response.data.stats;
    nextCursor.value = response.data.nextCursor;
    total.value = response.data.total;
  }

  async function fetchNextPage(filters) {
    if (!nextCursor.value) return;

    const params = {
      ...(filters.riskRating && { riskRating: filters.riskRating }),
      ...(filters.qaStatus && { qaStatus: filters.qaStatus }),
      sortBy: filters.sortBy || 'risk_score',
      sortOrder: filters.sortOrder || 'desc',
      cursor: nextCursor.value,
      limit: 50,
    };

    const response = await api.get('/review/queue', { params });
    queue.value.push(...response.data.cases);
    nextCursor.value = response.data.nextCursor;
  }

  function removeCaseFromQueue(caseId) {
    queue.value = queue.value.filter((c) => c.id !== caseId);
    stats.value.totalPending = Math.max(0, stats.value.totalPending - 1);
  }

  async function approveCase(caseId, comment) {
    await api.post(`/review/${caseId}/approve`, { comment });
    removeCaseFromQueue(caseId);
  }

  async function rejectCase(caseId, { reasonCode, reason }) {
    await api.post(`/review/${caseId}/reject`, { reasonCode, reason });
    removeCaseFromQueue(caseId);
  }

  async function escalateCase(caseId, { notes, suggestedAction }) {
    await api.post(`/review/${caseId}/escalate`, { notes, suggestedAction });
    removeCaseFromQueue(caseId);
  }

  async function requestInfo(caseId, { requestedItems, notes }) {
    await api.post(`/review/${caseId}/request-info`, { requestedItems, notes });
    removeCaseFromQueue(caseId);
  }

  return {
    queue,
    stats,
    nextCursor,
    total,
    fetchQueue,
    fetchNextPage,
    removeCaseFromQueue,
    approveCase,
    rejectCase,
    escalateCase,
    requestInfo,
  };
});
```

### Vue Router Addition

```javascript
// In frontend/src/router/index.js
{
  path: '/review',
  name: 'review-queue',
  component: () => import('@/views/ReviewQueue.vue'),
  meta: { requiresAuth: true, roles: ['analyst', 'senior_analyst', 'compliance_officer', 'admin'] },
}
```

### Component Hierarchy

```
ReviewQueue.vue (page)
├── WorkloadStats
│   └── Risk level badges with counts
├── ReviewFilters
│   └── Risk / QA status / sort dropdowns
└── ReviewCaseList
    └── Case rows (entity, risk badge, QA badge, duration, fragment progress, open button)
        └── → navigates to CaseDetail with ?review=streamlined|full
            ├── StreamlinedReview (for QA-passed)
            └── Full review mode (fragment-level, see #65)
```

## Acceptance Criteria

- [ ] Review page at `/review` renders for authenticated analyst+ users
- [ ] Page displays list of cases in PENDING_HUMAN_REVIEW assigned to current user
- [ ] Senior analysts see all pending cases regardless of assignment
- [ ] Each case row shows: entity name, jurisdiction, risk rating (color-coded), processing time, QA status, fragment progress
- [ ] Cases sorted by risk score descending (highest risk first), created_at ascending as tiebreaker
- [ ] Filter by risk level works (dropdown: all/low/medium/high/very_high)
- [ ] Filter by QA status works (dropdown: all/passed/failed/not_applicable)
- [ ] Workload statistics panel shows: total pending, count by risk level, QA passed count
- [ ] Click "Open Review" navigates to case detail with `?review=streamlined` (QA passed) or `?review=full` (others)
- [ ] QA-passed cases have a visual indicator (green badge/checkmark)
- [ ] Streamlined review shows condensed summary with "Confirm & Approve" and "Reject / Full Review" buttons
- [ ] "Confirm & Approve" calls approve API and removes case from queue
- [ ] "Reject / Full Review" switches to full fragment-level review mode
- [ ] Cursor-based pagination loads more cases on scroll/button click
- [ ] WebSocket: new case:review_assigned adds case to queue in real-time
- [ ] WebSocket: case:state_changed (non-PENDING_HUMAN_REVIEW) removes case from queue
- [ ] Empty state: "No cases pending review" message when queue is empty

## Dependencies

- **Depends on**: Review API endpoints (GET /api/v1/review/queue), #36 (WebSocket events — case:review_assigned, case:state_changed), #5 (Frontend scaffold — Vue Router, Pinia), #69 (Auth — JWT, user role in store)
- **Blocks**: #65 (Fragment review — opened from queue), #66 (Review decision — final panel in review mode)

## Testing Strategy

1. **Page renders**: Mount ReviewQueue, verify it calls fetchQueue and renders case list
2. **Case list display**: Mock 3 cases with varying risk/QA status, verify all fields render correctly
3. **Risk color coding**: Verify low=green, medium=yellow, high/very_high=red badges
4. **QA badge**: Verify passed=green checkmark, failed=yellow warning, n/a=grey
5. **Sorting**: Verify cases ordered by risk_score desc, then created_at asc
6. **Filter — risk**: Select riskRating=high, verify fetchQueue called with filter
7. **Filter — QA**: Select qaStatus=passed, verify fetchQueue called with filter
8. **Workload stats**: Mock stats, verify all counters displayed correctly
9. **Open case — streamlined**: Click QA-passed case, verify navigation to `?review=streamlined`
10. **Open case — full**: Click non-QA case, verify navigation to `?review=full`
11. **Streamlined confirm**: Click "Confirm & Approve", verify approveCase called
12. **Streamlined reject**: Click "Reject / Full Review", verify switch-to-full-review emitted
13. **Pagination**: Mock nextCursor, click "Load More", verify next page appended
14. **WebSocket — new assignment**: Emit case:review_assigned, verify queue refreshes
15. **WebSocket — state change**: Emit case:state_changed with newState=APPROVED, verify case removed from list
16. **Empty state**: Mock empty queue, verify "No cases pending review" message
17. **Loading state**: Verify spinner shown while fetchQueue is pending
