# Admin Configuration Views

> GitHub Issue: [#77](https://github.com/jbillay/kyc-agent/issues/77)
> Epic: Configuration UI (#75)
> Size: L (3-5 days) | Priority: High

## Context

The admin configuration views provide a web-based interface for platform administrators to manage risk rules, LLM providers, data sources, users, and monitor system health — eliminating the need to edit YAML files directly. The page lives at `/admin/config` with a tabbed layout, one tab per configuration domain.

This story depends entirely on the Configuration API endpoints (#76) for data fetching and persistence. The frontend reads configuration via GET endpoints, presents form-based editors, validates user input client-side, and submits changes via PUT/POST/PATCH endpoints. All sensitive fields (API keys) arrive redacted from the API and are handled carefully in the UI.

## Requirements

### Functional

1. Configuration page at `/admin/config` with tab navigation (5 tabs)
2. **Risk Rules tab**: form-based editor for country risk lists, industry risk codes/keywords, ownership risk thresholds, screening risk scores, risk rating thresholds, and review routing. Preview of rule changes before saving.
3. **LLM Configuration tab**: provider selection (dropdown), model assignment per task type (reasoning, extraction, screening, classification, summarization), connection settings (base URL, timeout). Test connection button that calls `isAvailable()` on the selected provider.
4. **Data Sources tab**: registry provider settings (API keys, URLs), screening list sync status and last update timestamps, manual sync trigger button.
5. **User Management tab**: user list with role badges, create new user form (email, name, role, initial password), edit user role, activate/deactivate users with confirmation.
6. **System Health tab**: service status indicators (PostgreSQL, Redis, MinIO, Ollama), queue statistics (waiting, active, completed, failed jobs), database statistics (cases, users, screening entries).
7. Admin-only access enforced via Vue Router navigation guard (redirect non-admin to `/dashboard`)
8. Success/error toast notifications on all save operations
9. Unsaved changes warning when navigating away from a tab with modifications
10. Loading states on all async operations

### Non-Functional

- Tab switching is instant (no full page reload)
- Form validation runs on blur and on submit (not on every keystroke)
- Preview mode does not modify any state — it is a client-side diff view
- Responsive layout: usable on tablet-width screens (1024px minimum)

## Technical Design

### File: `frontend/src/views/ConfigView.vue`

```vue
<script setup>
import { ref, onBeforeMount } from 'vue';
import { useRouter } from 'vue-router';
import { useAuth } from '@/composables/useAuth';
import RiskRulesEditor from '@/components/config/RiskRulesEditor.vue';
import LlmConfigEditor from '@/components/config/LlmConfigEditor.vue';
import DataSourcesEditor from '@/components/config/DataSourcesEditor.vue';
import UserManagement from '@/components/config/UserManagement.vue';
import SystemHealth from '@/components/config/SystemHealth.vue';

const router = useRouter();
const { user } = useAuth();

const activeTab = ref('risk-rules');
const tabs = [
  { key: 'risk-rules', label: 'Risk Rules', icon: 'pi-shield' },
  { key: 'llm', label: 'LLM Configuration', icon: 'pi-microchip-ai' },
  { key: 'data-sources', label: 'Data Sources', icon: 'pi-database' },
  { key: 'users', label: 'User Management', icon: 'pi-users' },
  { key: 'health', label: 'System Health', icon: 'pi-heart' },
];

onBeforeMount(() => {
  if (user.value?.role !== 'admin') {
    router.replace('/dashboard');
  }
});
</script>
```

### File: `frontend/src/stores/config.js`

```javascript
import { defineStore } from 'pinia';
import { ref } from 'vue';
import axios from 'axios';

/**
 * Pinia store for admin configuration state.
 *
 * Manages fetching, caching, and saving configuration for all five domains.
 */
export const useConfigStore = defineStore('config', () => {
  const riskRules = ref(null);
  const llmConfig = ref(null);
  const dataSources = ref(null);
  const users = ref([]);
  const systemHealth = ref(null);
  const systemStats = ref(null);
  const loading = ref(false);
  const error = ref(null);

  async function fetchRiskRules() {
    loading.value = true;
    try {
      const { data } = await axios.get('/api/v1/config/risk-rules');
      riskRules.value = data.config;
    } finally {
      loading.value = false;
    }
  }

  async function saveRiskRules(config) {
    await axios.put('/api/v1/config/risk-rules', config);
    riskRules.value = config;
  }

  async function fetchLlmConfig() {
    loading.value = true;
    try {
      const { data } = await axios.get('/api/v1/config/llm');
      llmConfig.value = data.config;
    } finally {
      loading.value = false;
    }
  }

  async function saveLlmConfig(config) {
    await axios.put('/api/v1/config/llm', config);
    llmConfig.value = config;
  }

  async function fetchDataSources() {
    loading.value = true;
    try {
      const { data } = await axios.get('/api/v1/config/data-sources');
      dataSources.value = data.config;
    } finally {
      loading.value = false;
    }
  }

  async function saveDataSources(config) {
    await axios.put('/api/v1/config/data-sources', config);
    dataSources.value = config;
  }

  async function fetchUsers() {
    loading.value = true;
    try {
      const { data } = await axios.get('/api/v1/admin/users');
      users.value = data.users;
    } finally {
      loading.value = false;
    }
  }

  async function createUser(userData) {
    const { data } = await axios.post('/api/v1/admin/users', userData);
    users.value.unshift(data.user);
    return data.user;
  }

  async function updateUser(id, updates) {
    const { data } = await axios.patch(`/api/v1/admin/users/${id}`, updates);
    const idx = users.value.findIndex((u) => u.id === id);
    if (idx !== -1) users.value[idx] = data.user;
    return data.user;
  }

  async function fetchSystemHealth() {
    const { data } = await axios.get('/api/v1/admin/system/health');
    systemHealth.value = data.services;
  }

  async function fetchSystemStats() {
    const { data } = await axios.get('/api/v1/admin/system/stats');
    systemStats.value = data;
  }

  return {
    riskRules, llmConfig, dataSources, users,
    systemHealth, systemStats, loading, error,
    fetchRiskRules, saveRiskRules,
    fetchLlmConfig, saveLlmConfig,
    fetchDataSources, saveDataSources,
    fetchUsers, createUser, updateUser,
    fetchSystemHealth, fetchSystemStats,
  };
});
```

### File: `frontend/src/components/config/RiskRulesEditor.vue`

```vue
<script setup>
import { ref, computed, onMounted } from 'vue';
import { useConfigStore } from '@/stores/config';

/**
 * Risk Rules Editor — form-based editor with preview.
 *
 * Sections:
 *   1. Country Risk — editable lists of high/medium risk countries with score additions
 *   2. Industry Risk — SIC codes and keywords with score additions
 *   3. Ownership Risk — threshold sliders/inputs (layers, cross-border, nominee, etc.)
 *   4. Screening Risk — score values for sanctions, PEP, adverse media
 *   5. Thresholds — min/max ranges for low/medium/high/very_high ratings
 *   6. Review Routing — QA agent eligibility thresholds, routing rules
 *
 * Preview mode:
 *   Shows diff between current saved config and pending changes.
 *   Does not submit — user must click Save to apply.
 */

const configStore = useConfigStore();
const editedRules = ref(null);
const showPreview = ref(false);
const saving = ref(false);

onMounted(async () => {
  await configStore.fetchRiskRules();
  editedRules.value = JSON.parse(JSON.stringify(configStore.riskRules));
});

const hasChanges = computed(() => {
  return JSON.stringify(editedRules.value) !== JSON.stringify(configStore.riskRules);
});

async function save() {
  saving.value = true;
  try {
    await configStore.saveRiskRules(editedRules.value);
    // toast success
  } catch (err) {
    // toast error
  } finally {
    saving.value = false;
  }
}
</script>
```

### File: `frontend/src/components/config/LlmConfigEditor.vue`

```vue
<script setup>
import { ref, onMounted } from 'vue';
import { useConfigStore } from '@/stores/config';
import axios from 'axios';

/**
 * LLM Configuration Editor.
 *
 * Sections:
 *   1. Default Provider — dropdown (ollama, vllm, openai-compatible, anthropic, openai)
 *   2. Provider Settings — per-provider collapsible panels:
 *        - Base URL (text input)
 *        - Timeout (number input, ms)
 *        - API Key (password input — shows '***' from API, clears on edit)
 *        - Retry settings (max attempts, backoff)
 *   3. Model Routing — table: task type × provider → model name
 *        - Rows: reasoning, extraction, screening, classification, summarization
 *        - Columns: one per configured provider
 *   4. Test Connection — button per provider, calls isAvailable() via API
 *
 * API key handling:
 *   GET returns '***' for existing keys.
 *   On PUT, if the field still contains '***', the backend preserves the existing key.
 *   If the field is cleared or changed, the new value is saved.
 */

const configStore = useConfigStore();
const editedConfig = ref(null);
const testResults = ref({});
const testing = ref({});

const PROVIDERS = ['ollama', 'vllm', 'openai-compatible', 'anthropic', 'openai'];
const TASK_TYPES = ['reasoning', 'extraction', 'screening', 'classification', 'summarization'];

onMounted(async () => {
  await configStore.fetchLlmConfig();
  editedConfig.value = JSON.parse(JSON.stringify(configStore.llmConfig));
});

async function testConnection(provider) {
  testing.value[provider] = true;
  try {
    // Call a dedicated test endpoint or use the health check
    const { data } = await axios.post('/api/v1/config/llm/test', { provider });
    testResults.value[provider] = { success: true, message: 'Connected' };
  } catch (err) {
    testResults.value[provider] = { success: false, message: err.response?.data?.error?.message || 'Connection failed' };
  } finally {
    testing.value[provider] = false;
  }
}
</script>
```

### File: `frontend/src/components/config/DataSourcesEditor.vue`

```vue
<script setup>
import { ref, onMounted } from 'vue';
import { useConfigStore } from '@/stores/config';

/**
 * Data Sources Editor.
 *
 * Sections:
 *   1. Registry Providers — Companies House, SEC EDGAR
 *        - API key (password input), base URL, enabled toggle
 *   2. Screening Sources — OFAC SDN, UK HMT, UN Consolidated, EU sanctions
 *        - Source URL, update schedule (cron expression)
 *        - Sync status: last updated timestamp, entry count
 *        - Manual sync trigger button (POST to screening sync endpoint)
 *   3. Screening List Status — table showing list name, entry count, last updated
 */

const configStore = useConfigStore();
const editedConfig = ref(null);
const syncing = ref({});

onMounted(async () => {
  await configStore.fetchDataSources();
  editedConfig.value = JSON.parse(JSON.stringify(configStore.dataSources));
});

async function triggerSync(listName) {
  syncing.value[listName] = true;
  try {
    // POST to trigger manual screening list sync
    // await axios.post(`/api/v1/admin/screening/sync/${listName}`);
    // toast success, refresh sync status
  } finally {
    syncing.value[listName] = false;
  }
}
</script>
```

### File: `frontend/src/components/config/UserManagement.vue`

```vue
<script setup>
import { ref, onMounted } from 'vue';
import { useConfigStore } from '@/stores/config';

/**
 * User Management — CRUD interface for platform users.
 *
 * Layout:
 *   1. User list table: email, name, role badge, active status, last login, actions
 *   2. Create user button → modal form (email, name, role dropdown, initial password)
 *   3. Inline role edit via dropdown
 *   4. Activate/deactivate toggle with confirmation dialog
 *
 * Role badges use color coding:
 *   - admin: red
 *   - compliance_officer: orange
 *   - senior_analyst: blue
 *   - analyst: green
 *
 * Constraints:
 *   - Cannot deactivate own account
 *   - Cannot change own role
 *   - Email uniqueness enforced by API (409 on duplicate)
 */

const ROLES = [
  { value: 'analyst', label: 'Analyst', severity: 'success' },
  { value: 'senior_analyst', label: 'Senior Analyst', severity: 'info' },
  { value: 'compliance_officer', label: 'Compliance Officer', severity: 'warning' },
  { value: 'admin', label: 'Admin', severity: 'danger' },
];

const configStore = useConfigStore();
const showCreateDialog = ref(false);
const newUser = ref({ email: '', name: '', role: 'analyst', password: '' });
const creating = ref(false);

onMounted(() => {
  configStore.fetchUsers();
});

async function createUser() {
  creating.value = true;
  try {
    await configStore.createUser(newUser.value);
    showCreateDialog.value = false;
    newUser.value = { email: '', name: '', role: 'analyst', password: '' };
    // toast success
  } catch (err) {
    // toast error (e.g., duplicate email)
  } finally {
    creating.value = false;
  }
}

async function toggleActive(user) {
  await configStore.updateUser(user.id, { is_active: !user.is_active });
}

async function changeRole(user, newRole) {
  await configStore.updateUser(user.id, { role: newRole });
}
</script>
```

### File: `frontend/src/components/config/SystemHealth.vue`

```vue
<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useConfigStore } from '@/stores/config';

/**
 * System Health dashboard.
 *
 * Layout:
 *   1. Service Status Cards — 4 cards (PostgreSQL, Redis, MinIO, Ollama)
 *        - Green/red indicator based on health check
 *        - Error message if unhealthy
 *   2. Queue Statistics — BullMQ job counts
 *        - Waiting, Active, Completed, Failed, Delayed
 *   3. Database Statistics
 *        - Total cases, users, screening entries
 *        - Screening list table: name, entry count, last updated
 *   4. Auto-refresh toggle (30s interval)
 */

const configStore = useConfigStore();
const autoRefresh = ref(true);
let refreshInterval = null;

async function refresh() {
  await Promise.all([
    configStore.fetchSystemHealth(),
    configStore.fetchSystemStats(),
  ]);
}

onMounted(() => {
  refresh();
  refreshInterval = setInterval(() => {
    if (autoRefresh.value) refresh();
  }, 30000);
});

onUnmounted(() => {
  clearInterval(refreshInterval);
});
</script>
```

### Router Configuration

```javascript
// In frontend/src/router/index.js — add config route

{
  path: '/admin/config',
  name: 'config',
  component: () => import('@/views/ConfigView.vue'),
  meta: {
    requiresAuth: true,
    requiredRole: 'admin',
  },
},
```

The existing navigation guard (from #69 Login Frontend) checks `meta.requiresAuth` and `meta.requiredRole`. Non-admin users are redirected to `/dashboard`.

### Component Layout

```
ConfigView.vue
├── Tab: Risk Rules
│   └── RiskRulesEditor.vue
│       ├── CountryRiskSection (high/medium risk country lists)
│       ├── IndustryRiskSection (SIC codes, keywords)
│       ├── OwnershipRiskSection (thresholds and score additions)
│       ├── ScreeningRiskSection (sanctions, PEP, media scores)
│       ├── ThresholdsSection (low/medium/high/very_high ranges)
│       ├── ReviewRoutingSection (QA eligibility, routing rules)
│       └── PreviewDialog (diff view of changes)
├── Tab: LLM Configuration
│   └── LlmConfigEditor.vue
│       ├── DefaultProviderSelect
│       ├── ProviderSettingsPanel (per provider: URL, timeout, key, retry)
│       ├── ModelRoutingTable (task type × provider matrix)
│       └── TestConnectionButton (per provider)
├── Tab: Data Sources
│   └── DataSourcesEditor.vue
│       ├── RegistryProvidersPanel (Companies House, SEC EDGAR)
│       ├── ScreeningSourcesPanel (OFAC, HMT, UN, EU)
│       └── SyncStatusTable (list name, count, last updated, sync button)
├── Tab: User Management
│   └── UserManagement.vue
│       ├── UserTable (email, name, role badge, active, last login, actions)
│       └── CreateUserDialog (email, name, role, password)
└── Tab: System Health
    └── SystemHealth.vue
        ├── ServiceStatusCards (4 service cards with health indicators)
        ├── QueueStatsPanel (waiting, active, completed, failed, delayed)
        └── DatabaseStatsPanel (cases, users, screening entries, list table)
```

## Acceptance Criteria

- [ ] Configuration page accessible at `/admin/config`
- [ ] Non-admin users redirected to `/dashboard` when accessing `/admin/config`
- [ ] Tab navigation between 5 tabs (Risk Rules, LLM, Data Sources, Users, Health)
- [ ] **Risk Rules tab**: displays current risk rules in form fields
- [ ] **Risk Rules tab**: editable country risk lists (add/remove countries)
- [ ] **Risk Rules tab**: editable industry risk SIC codes and keywords
- [ ] **Risk Rules tab**: editable ownership risk thresholds (numeric inputs)
- [ ] **Risk Rules tab**: editable screening risk scores
- [ ] **Risk Rules tab**: editable risk rating thresholds
- [ ] **Risk Rules tab**: editable review routing rules
- [ ] **Risk Rules tab**: Preview button shows diff of pending changes
- [ ] **Risk Rules tab**: Save button submits to PUT /config/risk-rules
- [ ] **LLM tab**: default provider dropdown with all 5 providers
- [ ] **LLM tab**: per-provider settings panel (base URL, timeout, API key, retry)
- [ ] **LLM tab**: model routing table (task types × providers)
- [ ] **LLM tab**: Test Connection button per provider with success/failure feedback
- [ ] **LLM tab**: API key fields show `'***'` for existing keys, allow override
- [ ] **Data Sources tab**: registry provider settings (API key, URL)
- [ ] **Data Sources tab**: screening list sync status table (name, count, last updated)
- [ ] **Data Sources tab**: manual sync trigger button per screening list
- [ ] **Users tab**: user list table with role badges and active status
- [ ] **Users tab**: Create User button opens modal with email, name, role, password fields
- [ ] **Users tab**: inline role change via dropdown
- [ ] **Users tab**: activate/deactivate toggle with confirmation
- [ ] **Users tab**: cannot deactivate own account or change own role
- [ ] **Users tab**: duplicate email shows error from API (409)
- [ ] **Health tab**: 4 service status cards (PostgreSQL, Redis, MinIO, Ollama) with green/red
- [ ] **Health tab**: queue statistics (waiting, active, completed, failed, delayed)
- [ ] **Health tab**: database statistics (cases, users, screening entries)
- [ ] **Health tab**: auto-refresh every 30 seconds (toggleable)
- [ ] Loading spinners on all async operations
- [ ] Toast notifications on save success and error
- [ ] Unsaved changes warning when navigating away from modified tab

## Dependencies

- **Depends on**: #76 (Configuration API endpoints — all data comes from these endpoints), #5 (Frontend scaffold), #69 (Login frontend — auth store, route guards)
- **Blocks**: None (this is a leaf story)

## Testing Strategy

1. **Route guard — admin access**: Login as admin, navigate to /admin/config, verify page loads
2. **Route guard — non-admin redirect**: Login as analyst, navigate to /admin/config, verify redirect to /dashboard
3. **Tab navigation**: Click each tab, verify correct component renders
4. **Risk rules — load**: Mount RiskRulesEditor, verify form populated from API response
5. **Risk rules — edit + save**: Modify a country list, click Save, verify PUT called with correct body
6. **Risk rules — preview**: Modify threshold, click Preview, verify diff displayed
7. **Risk rules — validation**: Submit invalid threshold (min > max), verify client-side error
8. **LLM — load**: Mount LlmConfigEditor, verify providers and routing table populated
9. **LLM — API key display**: Verify API key fields show `***` not plaintext
10. **LLM — test connection**: Click Test Connection for Ollama, verify success/failure feedback
11. **LLM — model routing edit**: Change a model assignment, save, verify PUT called
12. **Data sources — load**: Mount DataSourcesEditor, verify sync status table populated
13. **Data sources — manual sync**: Click sync button, verify POST called, loading state shown
14. **Users — list**: Mount UserManagement, verify user table shows all users with role badges
15. **Users — create**: Open dialog, fill form, submit, verify POST called, user added to list
16. **Users — duplicate email**: Attempt to create user with existing email, verify error toast
17. **Users — role change**: Change user role via dropdown, verify PATCH called
18. **Users — deactivate**: Toggle active off, verify confirmation dialog, verify PATCH called
19. **Users — self-protection**: Verify own account shows disabled deactivate/role controls
20. **Health — service cards**: Mount SystemHealth, verify 4 service cards rendered with status
21. **Health — auto-refresh**: Wait 30s, verify health/stats endpoints called again
22. **Health — unhealthy service**: Mock API to return unhealthy Redis, verify red indicator + error message
23. **Unsaved changes**: Edit risk rules, attempt tab switch, verify warning dialog
24. **Loading states**: Mock slow API, verify loading spinners shown during fetch/save
