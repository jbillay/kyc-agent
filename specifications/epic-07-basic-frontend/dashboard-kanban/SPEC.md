# Basic Frontend — Dashboard View with Case List and Kanban Board

> GitHub Issue: [#39](https://github.com/jbillay/kyc-agent/issues/39)
> Epic: Basic Frontend — Phase 1 (#38)
> Size: L (3-5 days) | Priority: Critical

## Context

The dashboard is the analyst's primary landing page. It presents all KYC cases as a kanban board organized by state, allowing analysts to see the full case pipeline at a glance. Cards update in real-time as agents complete work — moving between columns without page refresh. The dashboard also provides filtering, sorting, and search capabilities, plus a "New Case" button to trigger case creation.

This story establishes the foundational Pinia store, WebSocket connection, and Vue Router configuration that all other frontend stories build upon.

## Requirements

### Functional

1. Kanban board with columns: **In Progress**, **Pending Review**, **Approved**, **Escalated / Needs Info**
2. Case cards show: entity name, jurisdiction flag, risk rating badge (color-coded), time elapsed since creation, assigned reviewer
3. Cards update in real-time via WebSocket — move between columns as case state changes
4. Click a card to navigate to case detail view (`/cases/:id`)
5. Filter bar: filter by state, risk rating, date range, and search by entity name
6. Sort options: newest first, oldest first, highest risk first
7. Case count displayed per column
8. "New Case" button opens creation dialog (Story #40)
9. Responsive layout for desktop and tablet screen sizes

### Non-Functional

- Dashboard loads within 2 seconds for up to 200 cases
- WebSocket reconnects automatically on disconnection
- Filters persist across navigation (stored in URL query params or Pinia store)

## Technical Design

### File: `frontend/src/router/index.js`

```javascript
import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  {
    path: '/',
    redirect: '/dashboard',
  },
  {
    path: '/dashboard',
    name: 'dashboard',
    component: () => import('../views/DashboardView.vue'),
  },
  {
    path: '/cases/:id',
    name: 'case-detail',
    component: () => import('../views/CaseDetailView.vue'),
    props: true,
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
```

### File: `frontend/src/stores/cases.js`

```javascript
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

/**
 * @typedef {Object} CaseSummary
 * @property {string} id
 * @property {string} clientName
 * @property {'corporate'|'individual'} clientType
 * @property {string} jurisdiction
 * @property {string} state
 * @property {number} [riskScore]
 * @property {string} [riskRating]
 * @property {string} [assignedReviewer]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export const useCasesStore = defineStore('cases', () => {
  /** @type {import('vue').Ref<CaseSummary[]>} */
  const cases = ref([]);

  /** @type {import('vue').Ref<boolean>} */
  const loading = ref(false);

  /** @type {import('vue').Ref<string|null>} */
  const error = ref(null);

  /** @type {import('vue').Ref<Object>} */
  const filters = ref({
    state: null,
    riskRating: null,
    dateFrom: null,
    dateTo: null,
    search: '',
    sortBy: 'newest',
  });

  // ─── Kanban column definitions ──────────────────

  const KANBAN_COLUMNS = [
    {
      id: 'in_progress',
      label: 'In Progress',
      states: [
        'CREATED',
        'ENTITY_RESOLUTION',
        'PARALLEL_1',
        'RISK_ASSESSMENT',
        'QA_OR_REVIEW',
      ],
    },
    {
      id: 'pending_review',
      label: 'Pending Review',
      states: ['PENDING_HUMAN_REVIEW'],
    },
    {
      id: 'approved',
      label: 'Approved',
      states: ['APPROVED'],
    },
    {
      id: 'escalated',
      label: 'Escalated / Needs Info',
      states: ['REJECTED', 'ESCALATED', 'ADDITIONAL_INFO_REQUIRED'],
    },
  ];

  /**
   * Cases grouped by kanban column, with filters applied.
   */
  const columns = computed(() => {
    const filtered = _applyFilters(cases.value);
    const sorted = _applySort(filtered);

    return KANBAN_COLUMNS.map((col) => ({
      ...col,
      cases: sorted.filter((c) => col.states.includes(c.state)),
      count: sorted.filter((c) => col.states.includes(c.state)).length,
    }));
  });

  // ─── Actions ────────────────────────────────────

  /**
   * Fetch all cases from API.
   */
  async function fetchCases() {
    loading.value = true;
    error.value = null;
    try {
      const params = new URLSearchParams();
      if (filters.value.state) params.set('state', filters.value.state);
      if (filters.value.riskRating) params.set('riskRating', filters.value.riskRating);
      if (filters.value.dateFrom) params.set('dateFrom', filters.value.dateFrom);
      if (filters.value.dateTo) params.set('dateTo', filters.value.dateTo);
      if (filters.value.search) params.set('search', filters.value.search);

      const query = params.toString();
      const url = `${API_URL}/api/v1/cases${query ? `?${query}` : ''}`;
      const res = await fetch(url);

      if (!res.ok) throw new Error(`Failed to fetch cases: ${res.status}`);

      const data = await res.json();
      cases.value = data.cases;
    } catch (err) {
      error.value = err.message;
    } finally {
      loading.value = false;
    }
  }

  /**
   * Create a new case.
   *
   * @param {Object} payload
   * @param {string} payload.clientName
   * @param {'corporate'|'individual'} payload.clientType
   * @param {string} payload.jurisdiction
   * @param {string} [payload.registrationNumber]
   * @param {string} [payload.notes]
   * @returns {Promise<CaseSummary>}
   */
  async function createCase(payload) {
    const res = await fetch(`${API_URL}/api/v1/cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `Failed to create case: ${res.status}`);
    }

    const newCase = await res.json();
    // Optimistically add to local store; WebSocket will confirm
    cases.value.unshift(newCase);
    return newCase;
  }

  /**
   * Handle WebSocket state change — update a case in the store.
   *
   * @param {Object} event
   * @param {string} event.caseId
   * @param {string} event.newState
   */
  function onCaseStateChanged({ caseId, newState }) {
    const idx = cases.value.findIndex((c) => c.id === caseId);
    if (idx !== -1) {
      cases.value[idx] = { ...cases.value[idx], state: newState, updatedAt: new Date().toISOString() };
    }
  }

  /**
   * Handle WebSocket case completed — update risk data.
   *
   * @param {Object} event
   * @param {string} event.caseId
   * @param {string} event.riskRating
   * @param {number} event.riskScore
   */
  function onCaseCompleted({ caseId, riskRating, riskScore }) {
    const idx = cases.value.findIndex((c) => c.id === caseId);
    if (idx !== -1) {
      cases.value[idx] = { ...cases.value[idx], riskRating, riskScore };
    }
  }

  // ─── Internal helpers ───────────────────────────

  function _applyFilters(list) {
    return list.filter((c) => {
      if (filters.value.state && c.state !== filters.value.state) return false;
      if (filters.value.riskRating && c.riskRating !== filters.value.riskRating) return false;
      if (filters.value.dateFrom && c.createdAt < filters.value.dateFrom) return false;
      if (filters.value.dateTo && c.createdAt > filters.value.dateTo) return false;
      if (filters.value.search) {
        const q = filters.value.search.toLowerCase();
        if (!c.clientName.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }

  function _applySort(list) {
    const sorted = [...list];
    switch (filters.value.sortBy) {
      case 'oldest':
        return sorted.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      case 'highest_risk':
        return sorted.sort((a, b) => (b.riskScore || 0) - (a.riskScore || 0));
      case 'newest':
      default:
        return sorted.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
  }

  return {
    cases,
    loading,
    error,
    filters,
    columns,
    fetchCases,
    createCase,
    onCaseStateChanged,
    onCaseCompleted,
  };
});
```

### File: `frontend/src/stores/websocket.js`

```javascript
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { io } from 'socket.io-client';
import { useCasesStore } from './cases';

const WS_URL = import.meta.env.VITE_WS_URL || 'http://localhost:4000';

export const useWebSocketStore = defineStore('websocket', () => {
  /** @type {import('vue').Ref<import('socket.io-client').Socket|null>} */
  const socket = ref(null);

  /** @type {import('vue').Ref<boolean>} */
  const connected = ref(false);

  /**
   * Initialize Socket.io connection and bind event handlers.
   */
  function connect() {
    if (socket.value) return;

    socket.value = io(WS_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    socket.value.on('connect', () => {
      connected.value = true;
    });

    socket.value.on('disconnect', () => {
      connected.value = false;
    });

    // ─── Case events ──────────────────────────────
    const casesStore = useCasesStore();

    socket.value.on('case:state_changed', (event) => {
      casesStore.onCaseStateChanged(event);
    });

    socket.value.on('case:completed', (event) => {
      casesStore.onCaseCompleted(event);
    });

    // Agent progress events are handled by the AgentProgress component
    // via direct socket listeners (see Story #42)
  }

  /**
   * Disconnect and clean up.
   */
  function disconnect() {
    if (socket.value) {
      socket.value.disconnect();
      socket.value = null;
      connected.value = false;
    }
  }

  return { socket, connected, connect, disconnect };
});
```

### File: `frontend/src/views/DashboardView.vue`

```vue
<template>
  <div class="dashboard">
    <div class="dashboard-header">
      <h1>KYC Cases</h1>
      <button class="btn-primary" @click="showNewCaseDialog = true">
        + New Case
      </button>
    </div>

    <CaseFilters
      v-model:filters="casesStore.filters"
      @update:filters="casesStore.fetchCases()"
    />

    <CaseKanban
      :columns="casesStore.columns"
      :loading="casesStore.loading"
      @card-click="navigateToCase"
    />

    <NewCaseDialog
      v-model:visible="showNewCaseDialog"
      @created="onCaseCreated"
    />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useCasesStore } from '../stores/cases';
import { useWebSocketStore } from '../stores/websocket';
import CaseKanban from '../components/cases/CaseKanban.vue';
import CaseFilters from '../components/cases/CaseFilters.vue';
import NewCaseDialog from '../components/cases/NewCaseDialog.vue';

const router = useRouter();
const casesStore = useCasesStore();
const wsStore = useWebSocketStore();

const showNewCaseDialog = ref(false);

onMounted(() => {
  casesStore.fetchCases();
  wsStore.connect();
});

function navigateToCase(caseId) {
  router.push({ name: 'case-detail', params: { id: caseId } });
}

function onCaseCreated() {
  showNewCaseDialog.value = false;
}
</script>
```

### File: `frontend/src/components/cases/CaseKanban.vue`

```vue
<template>
  <div class="kanban-board">
    <div
      v-for="column in columns"
      :key="column.id"
      class="kanban-column"
    >
      <div class="kanban-column-header">
        <h3>{{ column.label }}</h3>
        <span class="case-count">{{ column.count }}</span>
      </div>

      <div v-if="loading" class="kanban-loading">Loading...</div>

      <div v-else class="kanban-cards">
        <CaseCard
          v-for="caseItem in column.cases"
          :key="caseItem.id"
          :case-data="caseItem"
          @click="$emit('card-click', caseItem.id)"
        />

        <div v-if="column.cases.length === 0" class="kanban-empty">
          No cases
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import CaseCard from './CaseCard.vue';

defineProps({
  columns: { type: Array, required: true },
  loading: { type: Boolean, default: false },
});

defineEmits(['card-click']);
</script>
```

### File: `frontend/src/components/cases/CaseCard.vue`

```vue
<template>
  <div class="case-card" @click="$emit('click')">
    <div class="case-card-header">
      <span class="entity-name">{{ caseData.clientName }}</span>
      <span
        v-if="caseData.riskRating"
        class="risk-badge"
        :class="`risk-${caseData.riskRating}`"
      >
        {{ caseData.riskRating }}
      </span>
    </div>

    <div class="case-card-meta">
      <span class="jurisdiction">{{ jurisdictionFlag }} {{ caseData.jurisdiction }}</span>
      <span class="time-elapsed">{{ timeElapsed }}</span>
    </div>

    <div v-if="caseData.assignedReviewer" class="case-card-reviewer">
      Reviewer: {{ caseData.assignedReviewer }}
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  caseData: { type: Object, required: true },
});

defineEmits(['click']);

/**
 * Map jurisdiction code to flag emoji.
 */
const jurisdictionFlag = computed(() => {
  const code = props.caseData.jurisdiction;
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(
    ...code.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
});

/**
 * Human-readable time elapsed since case creation.
 */
const timeElapsed = computed(() => {
  const created = new Date(props.caseData.createdAt);
  const now = new Date();
  const diffMs = now - created;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
});
</script>
```

### File: `frontend/src/components/cases/CaseFilters.vue`

```vue
<template>
  <div class="case-filters">
    <input
      type="text"
      placeholder="Search by entity name..."
      :value="filters.search"
      @input="updateFilter('search', $event.target.value)"
    />

    <select :value="filters.state" @change="updateFilter('state', $event.target.value || null)">
      <option value="">All States</option>
      <option value="CREATED">Created</option>
      <option value="ENTITY_RESOLUTION">Entity Resolution</option>
      <option value="PARALLEL_1">Screening / Ownership</option>
      <option value="RISK_ASSESSMENT">Risk Assessment</option>
      <option value="PENDING_HUMAN_REVIEW">Pending Review</option>
      <option value="APPROVED">Approved</option>
      <option value="ESCALATED">Escalated</option>
    </select>

    <select :value="filters.riskRating" @change="updateFilter('riskRating', $event.target.value || null)">
      <option value="">All Risk Levels</option>
      <option value="low">Low</option>
      <option value="medium">Medium</option>
      <option value="high">High</option>
      <option value="very_high">Very High</option>
    </select>

    <select :value="filters.sortBy" @change="updateFilter('sortBy', $event.target.value)">
      <option value="newest">Newest First</option>
      <option value="oldest">Oldest First</option>
      <option value="highest_risk">Highest Risk First</option>
    </select>
  </div>
</template>

<script setup>
const props = defineProps({
  filters: { type: Object, required: true },
});

const emit = defineEmits(['update:filters']);

function updateFilter(key, value) {
  emit('update:filters', { ...props.filters, [key]: value });
}
</script>
```

### Kanban Column Mapping

| Column | Label | Case States |
|--------|-------|-------------|
| `in_progress` | In Progress | `CREATED`, `ENTITY_RESOLUTION`, `PARALLEL_1`, `RISK_ASSESSMENT`, `QA_OR_REVIEW` |
| `pending_review` | Pending Review | `PENDING_HUMAN_REVIEW` |
| `approved` | Approved | `APPROVED` |
| `escalated` | Escalated / Needs Info | `REJECTED`, `ESCALATED`, `ADDITIONAL_INFO_REQUIRED` |

### WebSocket Integration

The dashboard listens to two key events for kanban updates:

| Event | Effect |
|-------|--------|
| `case:state_changed` | Updates the case's state in the Pinia store → computed `columns` re-evaluates → card moves to new column |
| `case:completed` | Updates risk rating and score → badge color changes on the card |

The WebSocket connection is established once in `DashboardView.onMounted()` via the WebSocket store and persists across route navigation.

## Acceptance Criteria

- [ ] Kanban board with 4 columns: In Progress, Pending Review, Approved, Escalated/Needs Info
- [ ] Case cards show: entity name, jurisdiction flag, risk rating badge (color-coded), time elapsed, assigned reviewer
- [ ] Cards update in real-time via WebSocket (move between columns as state changes)
- [ ] Click card navigates to `/cases/:id`
- [ ] Filter bar: state, risk rating, date range, search by name
- [ ] Sort options: newest first, oldest first, highest risk first
- [ ] Case count displayed per column
- [ ] "New Case" button present (opens dialog from Story #40)
- [ ] Pinia `cases` store fetches from `GET /api/v1/cases`
- [ ] WebSocket store with auto-reconnect
- [ ] Vue Router with lazy-loaded routes for dashboard and case detail
- [ ] Responsive layout for desktop and tablet

## Dependencies

- **Depends on**: #5 (Frontend scaffold), #4 (Fastify backend — Cases API endpoints)
- **Blocks**: #40 (New Case Dialog), #41 (Case Detail View)

## Testing Strategy

1. **Store — fetchCases**: Mock API response, verify cases populated in store
2. **Store — columns computed**: Provide cases with various states, verify correct column assignment
3. **Store — onCaseStateChanged**: Dispatch event, verify case moves to new column
4. **Store — filters**: Set filters, verify computed columns reflect filtered results
5. **Store — sort**: Set sortBy to each option, verify ordering
6. **CaseCard — display**: Mount with case data, verify entity name, jurisdiction, risk badge, time elapsed render
7. **CaseCard — click**: Click card, verify event emitted
8. **CaseKanban — columns**: Provide column data, verify column headers and case counts
9. **CaseKanban — empty**: Provide column with zero cases, verify "No cases" placeholder
10. **CaseFilters — search**: Type in search box, verify filter update emitted
11. **DashboardView — mount**: Verify `fetchCases()` and `connect()` called on mount
12. **WebSocket — reconnect**: Simulate disconnect, verify reconnection attempt
