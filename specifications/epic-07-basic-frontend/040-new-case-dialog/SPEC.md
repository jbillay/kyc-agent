# Basic Frontend — New Case Creation Dialog

> GitHub Issue: [#40](https://github.com/jbillay/kyc-agent/issues/40)
> Epic: Basic Frontend — Phase 1 (#38)
> Size: M (1-3 days) | Priority: Critical

## Context

Analysts need a quick way to kick off a new KYC case from the dashboard. The creation dialog collects the minimum information needed — company name, client type, jurisdiction, and optional registration number — then submits to the API. On success, the dialog closes and the new case appears on the kanban board in the "In Progress" column. The orchestrator picks up the case and begins agent execution automatically.

## Requirements

### Functional

1. "New Case" button on dashboard opens a modal dialog
2. Form fields: Company Name (required), Client Type (dropdown: corporate/individual), Jurisdiction (country selector, default UK), Registration Number (optional), Additional Notes (optional)
3. Inline form validation with error messages
4. Submit calls `POST /api/v1/cases`
5. Loading state while submitting (button disabled, spinner)
6. On success: dialog closes, new case card appears on dashboard
7. On error: display user-friendly error message in dialog
8. Escape key or backdrop click closes dialog (with confirmation if form is dirty)

### Non-Functional

- Form submission completes within 1 second (API side)
- Jurisdiction list is expandable (start with common jurisdictions, not exhaustive)

## Technical Design

### File: `frontend/src/components/cases/NewCaseDialog.vue`

```vue
<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="dialog-backdrop"
      @click.self="handleBackdropClick"
    >
      <div class="dialog" role="dialog" aria-labelledby="new-case-title">
        <div class="dialog-header">
          <h2 id="new-case-title">New KYC Case</h2>
          <button class="btn-close" @click="handleClose" aria-label="Close">&times;</button>
        </div>

        <form class="dialog-body" @submit.prevent="handleSubmit">
          <!-- Company Name -->
          <div class="form-field" :class="{ 'has-error': errors.clientName }">
            <label for="clientName">Company Name *</label>
            <input
              id="clientName"
              v-model="form.clientName"
              type="text"
              placeholder="e.g. Acme Holdings Ltd"
              @blur="validateField('clientName')"
            />
            <span v-if="errors.clientName" class="field-error">{{ errors.clientName }}</span>
          </div>

          <!-- Client Type -->
          <div class="form-field">
            <label for="clientType">Client Type *</label>
            <select id="clientType" v-model="form.clientType">
              <option value="corporate">Corporate</option>
              <option value="individual">Individual</option>
            </select>
          </div>

          <!-- Jurisdiction -->
          <div class="form-field">
            <label for="jurisdiction">Jurisdiction *</label>
            <select id="jurisdiction" v-model="form.jurisdiction">
              <option
                v-for="j in JURISDICTIONS"
                :key="j.code"
                :value="j.code"
              >
                {{ j.flag }} {{ j.name }}
              </option>
            </select>
          </div>

          <!-- Registration Number -->
          <div class="form-field">
            <label for="registrationNumber">Registration Number</label>
            <input
              id="registrationNumber"
              v-model="form.registrationNumber"
              type="text"
              placeholder="e.g. 12345678"
            />
          </div>

          <!-- Additional Notes -->
          <div class="form-field">
            <label for="notes">Additional Notes</label>
            <textarea
              id="notes"
              v-model="form.notes"
              rows="3"
              placeholder="Any additional context for this case..."
            />
          </div>

          <!-- Error banner -->
          <div v-if="submitError" class="form-error-banner">
            {{ submitError }}
          </div>

          <!-- Actions -->
          <div class="dialog-actions">
            <button type="button" class="btn-secondary" @click="handleClose">
              Cancel
            </button>
            <button
              type="submit"
              class="btn-primary"
              :disabled="submitting"
            >
              {{ submitting ? 'Creating...' : 'Create Case' }}
            </button>
          </div>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue';
import { useCasesStore } from '../../stores/cases';

const props = defineProps({
  visible: { type: Boolean, default: false },
});

const emit = defineEmits(['update:visible', 'created']);

const casesStore = useCasesStore();

// ─── Jurisdiction list ────────────────────────────

const JURISDICTIONS = [
  { code: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  { code: 'US', name: 'United States', flag: '🇺🇸' },
  { code: 'DE', name: 'Germany', flag: '🇩🇪' },
  { code: 'FR', name: 'France', flag: '🇫🇷' },
  { code: 'IE', name: 'Ireland', flag: '🇮🇪' },
  { code: 'SG', name: 'Singapore', flag: '🇸🇬' },
  { code: 'HK', name: 'Hong Kong', flag: '🇭🇰' },
  { code: 'AE', name: 'United Arab Emirates', flag: '🇦🇪' },
  { code: 'CH', name: 'Switzerland', flag: '🇨🇭' },
  { code: 'LU', name: 'Luxembourg', flag: '🇱🇺' },
  { code: 'JE', name: 'Jersey', flag: '🇯🇪' },
  { code: 'GG', name: 'Guernsey', flag: '🇬🇬' },
  { code: 'KY', name: 'Cayman Islands', flag: '🇰🇾' },
  { code: 'VG', name: 'British Virgin Islands', flag: '🇻🇬' },
];

// ─── Form state ──────────────────────────────────

const form = reactive({
  clientName: '',
  clientType: 'corporate',
  jurisdiction: 'GB',
  registrationNumber: '',
  notes: '',
});

const errors = reactive({
  clientName: null,
});

const submitting = ref(false);
const submitError = ref(null);

/**
 * True if any form field has been modified from defaults.
 */
const isDirty = computed(() => {
  return (
    form.clientName !== '' ||
    form.clientType !== 'corporate' ||
    form.jurisdiction !== 'GB' ||
    form.registrationNumber !== '' ||
    form.notes !== ''
  );
});

// Reset form when dialog opens
watch(() => props.visible, (val) => {
  if (val) {
    _resetForm();
  }
});

// ─── Validation ──────────────────────────────────

function validateField(field) {
  if (field === 'clientName') {
    if (!form.clientName.trim()) {
      errors.clientName = 'Company name is required';
      return false;
    }
    if (form.clientName.trim().length < 2) {
      errors.clientName = 'Company name must be at least 2 characters';
      return false;
    }
    errors.clientName = null;
    return true;
  }
  return true;
}

function validateAll() {
  return validateField('clientName');
}

// ─── Submit ──────────────────────────────────────

async function handleSubmit() {
  if (!validateAll()) return;

  submitting.value = true;
  submitError.value = null;

  try {
    const payload = {
      clientName: form.clientName.trim(),
      clientType: form.clientType,
      jurisdiction: form.jurisdiction,
    };

    if (form.registrationNumber.trim()) {
      payload.registrationNumber = form.registrationNumber.trim();
    }

    if (form.notes.trim()) {
      payload.additionalIdentifiers = { notes: form.notes.trim() };
    }

    await casesStore.createCase(payload);
    emit('created');
    emit('update:visible', false);
  } catch (err) {
    submitError.value = err.message || 'An unexpected error occurred. Please try again.';
  } finally {
    submitting.value = false;
  }
}

// ─── Close handling ──────────────────────────────

function handleClose() {
  if (isDirty.value && !window.confirm('You have unsaved changes. Discard?')) {
    return;
  }
  emit('update:visible', false);
}

function handleBackdropClick() {
  handleClose();
}

function _resetForm() {
  form.clientName = '';
  form.clientType = 'corporate';
  form.jurisdiction = 'GB';
  form.registrationNumber = '';
  form.notes = '';
  errors.clientName = null;
  submitError.value = null;
  submitting.value = false;
}
</script>
```

### Form → API Mapping

| Form Field | API Payload Field | Validation |
|-----------|------------------|------------|
| Company Name | `clientName` | Required, min 2 chars |
| Client Type | `clientType` | Required, `corporate` or `individual` |
| Jurisdiction | `jurisdiction` | Required, ISO 3166-1 alpha-2 |
| Registration Number | `registrationNumber` | Optional, passed if non-empty |
| Additional Notes | `additionalIdentifiers.notes` | Optional |

### API Contract

**Request**: `POST /api/v1/cases`
```json
{
  "clientName": "Acme Holdings Ltd",
  "clientType": "corporate",
  "jurisdiction": "GB",
  "registrationNumber": "12345678"
}
```

**Response** (201):
```json
{
  "id": "uuid",
  "clientName": "Acme Holdings Ltd",
  "clientType": "corporate",
  "jurisdiction": "GB",
  "registrationNumber": "12345678",
  "state": "CREATED",
  "createdAt": "2025-01-15T10:30:00Z",
  "updatedAt": "2025-01-15T10:30:00Z"
}
```

## Acceptance Criteria

- [ ] "New Case" button on dashboard opens a modal dialog
- [ ] Form fields: Company Name (required), Client Type (dropdown), Jurisdiction (country selector, default UK), Registration Number (optional), Additional Notes (optional)
- [ ] Inline validation: Company Name required with minimum 2 characters
- [ ] Submit calls `POST /api/v1/cases` with correct payload
- [ ] Loading state while submitting (button disabled, text changes to "Creating...")
- [ ] On success: dialog closes, new case appears on kanban board in "In Progress"
- [ ] On error: user-friendly error message displayed in dialog
- [ ] Escape key / backdrop click closes dialog (with confirmation if form is dirty)
- [ ] Form resets when dialog reopens
- [ ] Jurisdiction list includes at least UK, US, and common offshore jurisdictions

## Dependencies

- **Depends on**: #39 (Dashboard — provides the mounting point and cases store), #4 (Fastify backend — `POST /api/v1/cases` endpoint)
- **Blocks**: None (standalone dialog)

## Testing Strategy

1. **Render**: Mount dialog with `visible=true`, verify all form fields present
2. **Validation — empty name**: Submit with empty name, verify error message shown
3. **Validation — short name**: Submit with 1-char name, verify error message
4. **Validation — valid**: Fill all required fields, verify no errors
5. **Submit — success**: Mock API success, verify `createCase` called with correct payload, dialog emits `created` and closes
6. **Submit — error**: Mock API failure, verify error banner shown, dialog stays open
7. **Submit — loading**: Submit form, verify button disabled and shows "Creating..."
8. **Close — clean form**: Click close on empty form, verify dialog closes immediately
9. **Close — dirty form**: Modify form, click close, verify confirmation prompt
10. **Backdrop click**: Click backdrop, verify same close behavior as close button
11. **Form reset**: Open dialog, fill fields, close, reopen, verify fields are reset
12. **Jurisdiction default**: Open dialog, verify UK is pre-selected
