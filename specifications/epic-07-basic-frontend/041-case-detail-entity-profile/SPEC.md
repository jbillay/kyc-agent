# Basic Frontend — Case Detail View with Entity Profile Tab

> GitHub Issue: [#41](https://github.com/jbillay/kyc-agent/issues/41)
> Epic: Basic Frontend — Phase 1 (#38)
> Size: L (3-5 days) | Priority: Critical

## Context

The case detail view is the analyst's primary work surface. It displays all data the agents have gathered for a case, organized by tabs. In Phase 1, the Entity Profile tab is the most data-rich — it shows the company details, officers, shareholders, filing history, and previous names extracted by the Entity Resolution Agent. Other tabs (Screening, Audit Trail) are stubs that will be populated by Stories #43 and future work. The view updates in real-time as agents complete and push new data.

## Requirements

### Functional

1. Case detail page at route `/cases/:id`
2. Header: entity name, registration number, jurisdiction badge, current state badge, risk rating badge (when available)
3. Tab navigation: Entity Profile, Ownership (Phase 2 placeholder), Screening, Documents (Phase 2 placeholder), Risk Assessment (Phase 2 placeholder), Audit Trail
4. Entity Profile tab:
   - Company details table: name, registration number, incorporation date, status, SIC codes, registered address
   - Officers table: name, role, appointed date, nationality (only current officers)
   - Shareholders/PSC table: name, ownership %, nature of control, type (individual/corporate)
   - Filing history section (collapsible, most recent first)
   - Previous names section (if any)
5. Data freshness indicator (when data was last fetched from source)
6. Real-time updates: new data appears as agents populate it via WebSocket
7. Loading skeleton while case data is being fetched
8. 404 handling if case ID does not exist

### Non-Functional

- Case detail page loads within 1 second
- Tab switching is instant (no API re-fetch; data is loaded once)

## Technical Design

### File: `frontend/src/composables/useCase.js`

```javascript
import { ref, onMounted, onUnmounted } from 'vue';
import { useWebSocketStore } from '../stores/websocket';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000';

/**
 * @typedef {Object} CaseDetail
 * @property {string} id
 * @property {string} clientName
 * @property {'corporate'|'individual'} clientType
 * @property {string} jurisdiction
 * @property {string} [registrationNumber]
 * @property {string} state
 * @property {number} [riskScore]
 * @property {string} [riskRating]
 * @property {string} createdAt
 * @property {string} updatedAt
 * @property {Object} [entityProfile]
 * @property {Object} [screeningReport]
 * @property {Object} [agentResults] - Map of agentType → result
 */

/**
 * Composable for loading and watching a single case.
 *
 * @param {string} caseId
 * @returns {{ caseData: import('vue').Ref, loading: import('vue').Ref, error: import('vue').Ref, agentEvents: import('vue').Ref }}
 */
export function useCase(caseId) {
  /** @type {import('vue').Ref<CaseDetail|null>} */
  const caseData = ref(null);
  const loading = ref(true);
  const error = ref(null);

  /** @type {import('vue').Ref<Object[]>} */
  const agentEvents = ref([]);

  const wsStore = useWebSocketStore();

  async function fetchCase() {
    loading.value = true;
    error.value = null;
    try {
      const res = await fetch(`${API_URL}/api/v1/cases/${caseId}`);
      if (res.status === 404) {
        error.value = 'Case not found';
        return;
      }
      if (!res.ok) throw new Error(`Failed to fetch case: ${res.status}`);
      caseData.value = await res.json();
    } catch (err) {
      error.value = err.message;
    } finally {
      loading.value = false;
    }
  }

  // ─── WebSocket listeners for this case ─────────

  function onStateChanged(event) {
    if (event.caseId !== caseId) return;
    if (caseData.value) {
      caseData.value = { ...caseData.value, state: event.newState };
    }
  }

  function onAgentCompleted(event) {
    if (event.caseId !== caseId) return;
    agentEvents.value.push(event);
    // Re-fetch to get updated agent results
    fetchCase();
  }

  function onFragmentAdded(event) {
    if (event.caseId !== caseId) return;
    agentEvents.value.push(event);
  }

  onMounted(() => {
    fetchCase();
    wsStore.connect();

    const socket = wsStore.socket;
    if (socket) {
      socket.on('case:state_changed', onStateChanged);
      socket.on('case:agent_completed', onAgentCompleted);
      socket.on('case:fragment_added', onFragmentAdded);
    }
  });

  onUnmounted(() => {
    const socket = wsStore.socket;
    if (socket) {
      socket.off('case:state_changed', onStateChanged);
      socket.off('case:agent_completed', onAgentCompleted);
      socket.off('case:fragment_added', onFragmentAdded);
    }
  });

  return { caseData, loading, error, agentEvents, fetchCase };
}
```

### File: `frontend/src/views/CaseDetailView.vue`

```vue
<template>
  <div class="case-detail">
    <!-- Loading -->
    <div v-if="loading" class="case-detail-loading">
      <div class="skeleton skeleton-header" />
      <div class="skeleton skeleton-tabs" />
      <div class="skeleton skeleton-content" />
    </div>

    <!-- Error / Not Found -->
    <div v-else-if="error" class="case-detail-error">
      <h2>{{ error === 'Case not found' ? 'Case Not Found' : 'Error Loading Case' }}</h2>
      <p>{{ error }}</p>
      <router-link to="/dashboard" class="btn-secondary">Back to Dashboard</router-link>
    </div>

    <!-- Case loaded -->
    <template v-else-if="caseData">
      <!-- Header -->
      <div class="case-detail-header">
        <div class="header-main">
          <router-link to="/dashboard" class="back-link">&larr; Dashboard</router-link>
          <h1>{{ caseData.clientName }}</h1>
          <div class="header-badges">
            <span class="badge badge-jurisdiction">{{ caseData.jurisdiction }}</span>
            <span v-if="caseData.registrationNumber" class="badge badge-reg">
              {{ caseData.registrationNumber }}
            </span>
            <span class="badge badge-state" :class="`state-${caseData.state.toLowerCase()}`">
              {{ formatState(caseData.state) }}
            </span>
            <span
              v-if="caseData.riskRating"
              class="badge badge-risk"
              :class="`risk-${caseData.riskRating}`"
            >
              {{ caseData.riskRating }} risk
            </span>
          </div>
        </div>

        <!-- Agent Progress (Story #42) -->
        <AgentProgress
          :case-id="caseData.id"
          :case-state="caseData.state"
          :agent-events="agentEvents"
        />
      </div>

      <!-- Tabs -->
      <div class="case-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="tab-button"
          :class="{ active: activeTab === tab.id }"
          :disabled="tab.disabled"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <!-- Tab Content -->
      <div class="tab-content">
        <EntityProfile
          v-if="activeTab === 'entity'"
          :entity-profile="caseData.entityProfile"
          :case-data="caseData"
        />

        <div v-else-if="activeTab === 'ownership'" class="tab-placeholder">
          Ownership visualization available in Phase 2.
        </div>

        <ScreeningResults
          v-else-if="activeTab === 'screening'"
          :screening-report="caseData.screeningReport"
        />

        <div v-else-if="activeTab === 'documents'" class="tab-placeholder">
          Document analysis available in Phase 2.
        </div>

        <div v-else-if="activeTab === 'risk'" class="tab-placeholder">
          Risk assessment available in Phase 2.
        </div>

        <div v-else-if="activeTab === 'audit'" class="tab-placeholder">
          Audit trail available in Phase 2.
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useCase } from '../composables/useCase';
import EntityProfile from '../components/entity/EntityProfile.vue';
import ScreeningResults from '../components/screening/ScreeningResults.vue';
import AgentProgress from '../components/common/AgentProgress.vue';

const props = defineProps({
  id: { type: String, required: true },
});

const { caseData, loading, error, agentEvents } = useCase(props.id);

const activeTab = ref('entity');

const tabs = [
  { id: 'entity', label: 'Entity Profile', disabled: false },
  { id: 'ownership', label: 'Ownership', disabled: true },
  { id: 'screening', label: 'Screening', disabled: false },
  { id: 'documents', label: 'Documents', disabled: true },
  { id: 'risk', label: 'Risk Assessment', disabled: true },
  { id: 'audit', label: 'Audit Trail', disabled: true },
];

function formatState(state) {
  return state
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
</script>
```

### File: `frontend/src/components/entity/EntityProfile.vue`

```vue
<template>
  <div class="entity-profile">
    <!-- No data yet -->
    <div v-if="!entityProfile" class="entity-profile-pending">
      <p>Entity profile data is being resolved by the agent...</p>
    </div>

    <template v-else>
      <!-- Company Details -->
      <section class="profile-section">
        <h3>Company Details</h3>
        <table class="detail-table">
          <tbody>
            <tr>
              <td class="label">Name</td>
              <td>{{ entityProfile.name }}</td>
            </tr>
            <tr>
              <td class="label">Registration Number</td>
              <td>{{ entityProfile.registrationNumber || '—' }}</td>
            </tr>
            <tr>
              <td class="label">Incorporation Date</td>
              <td>{{ formatDate(entityProfile.incorporationDate) }}</td>
            </tr>
            <tr>
              <td class="label">Status</td>
              <td>
                <span class="status-badge" :class="statusClass">
                  {{ entityProfile.status }}
                </span>
              </td>
            </tr>
            <tr v-if="entityProfile.sicCodes?.length">
              <td class="label">SIC Codes</td>
              <td>
                <span v-for="sic in entityProfile.sicCodes" :key="sic.code" class="sic-tag">
                  {{ sic.code }} — {{ sic.description }}
                </span>
              </td>
            </tr>
            <tr v-if="entityProfile.registeredAddress">
              <td class="label">Registered Address</td>
              <td>{{ formatAddress(entityProfile.registeredAddress) }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="entityProfile.dataFetchedAt" class="data-freshness">
          Data fetched: {{ formatDateTime(entityProfile.dataFetchedAt) }}
        </div>
      </section>

      <!-- Previous Names -->
      <section v-if="entityProfile.previousNames?.length" class="profile-section">
        <h3>Previous Names</h3>
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Effective From</th>
              <th>Effective To</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(prev, i) in entityProfile.previousNames" :key="i">
              <td>{{ prev.name }}</td>
              <td>{{ formatDate(prev.effectiveFrom) }}</td>
              <td>{{ formatDate(prev.effectiveTo) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- Officers -->
      <section class="profile-section">
        <h3>Officers ({{ currentOfficers.length }})</h3>
        <OfficersTable
          v-if="currentOfficers.length > 0"
          :officers="currentOfficers"
        />
        <p v-else class="no-data">No current officers on record.</p>
      </section>

      <!-- Shareholders / PSCs -->
      <section class="profile-section">
        <h3>Shareholders / PSCs ({{ currentShareholders.length }})</h3>
        <table v-if="currentShareholders.length > 0" class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Ownership %</th>
              <th>Nature of Control</th>
              <th>Nationality</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sh in currentShareholders" :key="sh.name">
              <td>{{ sh.name }}</td>
              <td>
                <span class="type-badge" :class="sh.type">{{ sh.type }}</span>
              </td>
              <td>{{ sh.ownershipPercentage ? `${sh.ownershipPercentage}%` : '—' }}</td>
              <td>{{ (sh.naturesOfControl || []).join(', ') || '—' }}</td>
              <td>{{ sh.nationality || '—' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="no-data">No current shareholders/PSCs on record.</p>
      </section>

      <!-- Filing History -->
      <section v-if="entityProfile.filingHistory?.length" class="profile-section">
        <details class="filing-history">
          <summary>
            <h3>Filing History ({{ entityProfile.filingHistory.length }})</h3>
          </summary>
          <table class="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Category</th>
                <th>Description</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(filing, i) in entityProfile.filingHistory" :key="i">
                <td>{{ formatDate(filing.date) }}</td>
                <td>{{ filing.category }}</td>
                <td>{{ filing.description }}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </section>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import OfficersTable from './OfficersTable.vue';

const props = defineProps({
  entityProfile: { type: Object, default: null },
  caseData: { type: Object, required: true },
});

const currentOfficers = computed(() => {
  if (!props.entityProfile?.officers) return [];
  return props.entityProfile.officers.filter((o) => !o.resignedDate);
});

const currentShareholders = computed(() => {
  if (!props.entityProfile?.shareholders) return [];
  return props.entityProfile.shareholders.filter((s) => !s.ceasedDate);
});

const statusClass = computed(() => {
  const status = props.entityProfile?.status?.toLowerCase() || '';
  if (status.includes('active')) return 'status-active';
  if (status.includes('dissolved') || status.includes('closed')) return 'status-dissolved';
  return 'status-other';
});

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatAddress(addr) {
  if (!addr) return '—';
  if (typeof addr === 'string') return addr;
  return [addr.line1, addr.line2, addr.locality, addr.region, addr.postalCode, addr.country]
    .filter(Boolean)
    .join(', ');
}
</script>
```

### File: `frontend/src/components/entity/OfficersTable.vue`

```vue
<template>
  <table class="data-table officers-table">
    <thead>
      <tr>
        <th>Name</th>
        <th>Role</th>
        <th>Appointed</th>
        <th>Date of Birth</th>
        <th>Nationality</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="officer in officers" :key="officer.name + officer.role">
        <td>{{ officer.name }}</td>
        <td>{{ officer.role }}</td>
        <td>{{ formatDate(officer.appointedDate) }}</td>
        <td>{{ officer.dateOfBirth || '—' }}</td>
        <td>{{ officer.nationality || '—' }}</td>
      </tr>
    </tbody>
  </table>
</template>

<script setup>
defineProps({
  officers: { type: Array, required: true },
});

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
</script>
```

### Entity Profile Data Shape

The `entityProfile` object comes from the Entity Resolution Agent output stored in `agent_results`:

```javascript
{
  name: 'Acme Holdings Ltd',
  registrationNumber: '12345678',
  incorporationDate: '2010-03-15',
  status: 'Active',
  registeredAddress: {
    line1: '10 Downing Street',
    locality: 'London',
    postalCode: 'SW1A 2AA',
    country: 'United Kingdom',
  },
  sicCodes: [
    { code: '64209', description: 'Activities of other holding companies' },
  ],
  previousNames: [
    { name: 'Acme Ltd', effectiveFrom: '2010-03-15', effectiveTo: '2015-06-01' },
  ],
  officers: [
    {
      name: 'John Smith',
      role: 'director',
      appointedDate: '2010-03-15',
      resignedDate: null,
      dateOfBirth: '1975-03',
      nationality: 'British',
    },
  ],
  shareholders: [
    {
      name: 'John Smith',
      type: 'individual',
      ownershipPercentage: '75-100',
      naturesOfControl: ['ownership-of-shares-75-to-100-percent'],
      nationality: 'British',
      ceasedDate: null,
    },
  ],
  filingHistory: [
    { date: '2024-01-15', category: 'accounts', description: 'Total Exemption Full Accounts' },
  ],
  dataFetchedAt: '2025-01-15T10:35:00Z',
}
```

### Tab Navigation Design

| Tab | Phase 1 State | Component |
|-----|--------------|-----------|
| Entity Profile | Active — full implementation | `EntityProfile.vue` |
| Ownership | Disabled — placeholder text | — |
| Screening | Active — Story #43 | `ScreeningResults.vue` |
| Documents | Disabled — placeholder text | — |
| Risk Assessment | Disabled — placeholder text | — |
| Audit Trail | Disabled — placeholder text | — |

## Acceptance Criteria

- [ ] Case detail page at `/cases/:id`
- [ ] Header shows: entity name, registration number, jurisdiction badge, state badge, risk rating badge
- [ ] Tab navigation with Entity Profile, Ownership (disabled), Screening, Documents (disabled), Risk Assessment (disabled), Audit Trail (disabled)
- [ ] Entity Profile tab: company details table (name, reg number, incorporation date, status, SIC codes, address)
- [ ] Officers table showing current officers only (name, role, appointed date, DOB, nationality)
- [ ] Shareholders/PSC table (name, type, ownership %, nature of control, nationality)
- [ ] Filing history in a collapsible section, most recent first
- [ ] Previous names section displayed when available
- [ ] Data freshness indicator showing when data was fetched
- [ ] Loading skeleton while fetching case data
- [ ] 404 handling with "Case Not Found" message and back link
- [ ] Real-time updates via WebSocket: new data appears as agents complete
- [ ] `useCase` composable manages fetch, WebSocket listeners, and cleanup

## Dependencies

- **Depends on**: #39 (Dashboard — Vue Router, WebSocket store), #27-#28 (Entity Resolution Agent — EntityProfile data shape), #4 (Fastify backend — `GET /api/v1/cases/:id`)
- **Blocks**: #42 (Agent Progress — mounted in case detail header), #43 (Screening Results — Screening tab)

## Testing Strategy

1. **useCase — fetch success**: Mock API response, verify `caseData` populated
2. **useCase — 404**: Mock 404 response, verify error is "Case not found"
3. **useCase — WebSocket state change**: Emit `case:state_changed`, verify caseData.state updates
4. **useCase — WebSocket agent completed**: Emit `case:agent_completed`, verify re-fetch triggered
5. **useCase — cleanup**: Unmount, verify socket listeners removed
6. **CaseDetailView — loading**: Mount with no data, verify skeleton shown
7. **CaseDetailView — error**: Set error, verify error message and back link
8. **CaseDetailView — tabs**: Mount with data, verify all tab buttons render, disabled tabs are disabled
9. **CaseDetailView — tab switching**: Click Screening tab, verify ScreeningResults rendered
10. **EntityProfile — pending**: Mount with null entityProfile, verify "being resolved" message
11. **EntityProfile — full data**: Mount with complete entityProfile, verify all sections render
12. **EntityProfile — officers filter**: Provide officers with one resigned, verify only current shown
13. **EntityProfile — shareholders filter**: Provide shareholders with one ceased, verify only current shown
14. **EntityProfile — previous names**: Provide entity with previous names, verify section renders
15. **EntityProfile — no filing history**: Provide entity without filings, verify section hidden
16. **OfficersTable — render**: Mount with officers array, verify table rows match
