# Review Decision Workflow (Approve / Reject / Escalate)

> GitHub Issue: [#66](https://github.com/jbillay/kyc-agent/issues/66)
> Epic: Human Review Workflow (#61)
> Size: M (1-3 days) | Priority: Critical

## Context

After a reviewer has inspected the case data and reviewed individual decision fragments, they render a final case-level decision. This is the terminal step of the human review workflow — it transitions the case out of `PENDING_HUMAN_REVIEW` into one of four outcomes: Approve (proceed with onboarding), Reject (do not onboard), Escalate (needs senior authority), or Request Additional Information (specify what's missing).

Each decision has its own UX requirements: approval requires a confirmation dialog (irreversible), rejection requires a reason from a predefined list plus free text, escalation allows notes for the senior reviewer, and requesting info specifies exactly what data is needed and who should provide it. All decisions are logged as immutable `review_action` events in the audit trail.

## Requirements

### Functional

1. Final decision panel rendered at the bottom of the case detail view when in review mode
2. Four decision options:
   - **Approve**: proceed with client onboarding
   - **Reject**: do not onboard — mandatory reason
   - **Escalate to Senior**: needs higher authority — notes for senior reviewer
   - **Request Additional Info**: specify what's needed
3. Approve requires a confirmation dialog ("Are you sure? This action cannot be undone.")
4. Reject requires:
   - Reason code from predefined list (dropdown)
   - Free text explanation (minimum 10 characters)
5. Escalate requires:
   - Notes for the senior reviewer (minimum 10 characters)
   - Optional suggested action
6. Request Info requires:
   - At least one requested item (description + category)
   - Optional general notes
7. Decision updates case state and emits WebSocket notification
8. All decisions logged in audit trail (`decision_events`)
9. Panel disabled until reviewer has reviewed at least the critical fragments (screening, risk)
10. After decision, reviewer is redirected back to the review queue

### Non-Functional

- Decision submission completes within 500ms (API call + event store write)
- Confirmation dialogs prevent accidental submissions
- Form validation prevents submission of incomplete data

## Technical Design

### File: `frontend/src/components/review/ReviewDecisionPanel.vue`

```vue
<script setup>
/**
 * ReviewDecisionPanel — final case decision interface.
 *
 * Rendered at the bottom of case detail view in review mode.
 * Shows 4 action buttons. Each opens a specific dialog for data collection.
 *
 * Props:
 *   caseId: String
 *   caseData: Object — full case details
 *   reviewProgress: Object — { reviewed: number, total: number }
 *   criticalFragmentsReviewed: Boolean — whether screening + risk fragments are reviewed
 *
 * Emits:
 *   decision-made(decision) — after successful decision submission
 */

import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useReviewStore } from '@/stores/review';

const props = defineProps({
  caseId: { type: String, required: true },
  caseData: { type: Object, required: true },
  reviewProgress: { type: Object, required: true },
  criticalFragmentsReviewed: { type: Boolean, required: true },
});

const emit = defineEmits(['decision-made']);
const router = useRouter();
const reviewStore = useReviewStore();

const activeDialog = ref(null); // 'approve' | 'reject' | 'escalate' | 'request-info'
const submitting = ref(false);

const canDecide = computed(() => props.criticalFragmentsReviewed);

async function handleApprove(comment) {
  submitting.value = true;
  await reviewStore.approveCase(props.caseId, comment);
  emit('decision-made', { decision: 'approved' });
  router.push({ name: 'review-queue' });
  submitting.value = false;
}

async function handleReject({ reasonCode, reason }) {
  submitting.value = true;
  await reviewStore.rejectCase(props.caseId, { reasonCode, reason });
  emit('decision-made', { decision: 'rejected' });
  router.push({ name: 'review-queue' });
  submitting.value = false;
}

async function handleEscalate({ notes, suggestedAction }) {
  submitting.value = true;
  await reviewStore.escalateCase(props.caseId, { notes, suggestedAction });
  emit('decision-made', { decision: 'escalated' });
  router.push({ name: 'review-queue' });
  submitting.value = false;
}

async function handleRequestInfo({ requestedItems, notes }) {
  submitting.value = true;
  await reviewStore.requestInfo(props.caseId, { requestedItems, notes });
  emit('decision-made', { decision: 'additional_info_required' });
  router.push({ name: 'review-queue' });
  submitting.value = false;
}
</script>
```

### File: `frontend/src/components/review/RejectReasonDialog.vue`

```vue
<script setup>
/**
 * RejectReasonDialog — collects rejection reason for a case.
 *
 * Displays a modal with:
 *   - Reason code dropdown (predefined list)
 *   - Free text explanation (textarea, min 10 chars)
 *   - Cancel and Submit buttons
 *
 * Reason codes:
 *   - sanctions_match: Confirmed sanctions list match
 *   - unacceptable_risk: Risk level exceeds appetite
 *   - insufficient_documentation: Missing required documents
 *   - fraudulent_entity: Evidence of fraud or shell company
 *   - regulatory_prohibition: Prohibited by regulation
 *   - adverse_media_concerns: Significant adverse media findings
 *   - ownership_opacity: Cannot determine beneficial ownership
 *   - other: Other reason (must explain in free text)
 *
 * Props:
 *   visible: Boolean
 *
 * Emits:
 *   submit({ reasonCode, reason })
 *   cancel()
 */

import { ref, computed } from 'vue';

defineProps({ visible: { type: Boolean, required: true } });
const emit = defineEmits(['submit', 'cancel']);

const reasonCode = ref(null);
const reason = ref('');

const reasonOptions = [
  { value: 'sanctions_match', label: 'Confirmed sanctions list match' },
  { value: 'unacceptable_risk', label: 'Risk level exceeds risk appetite' },
  { value: 'insufficient_documentation', label: 'Missing required documentation' },
  { value: 'fraudulent_entity', label: 'Evidence of fraud or shell company' },
  { value: 'regulatory_prohibition', label: 'Prohibited by regulation' },
  { value: 'adverse_media_concerns', label: 'Significant adverse media findings' },
  { value: 'ownership_opacity', label: 'Cannot determine beneficial ownership' },
  { value: 'other', label: 'Other (specify below)' },
];

const isValid = computed(() =>
  reasonCode.value && reason.value.trim().length >= 10
);

function submit() {
  if (!isValid.value) return;
  emit('submit', { reasonCode: reasonCode.value, reason: reason.value.trim() });
}
</script>
```

### File: `frontend/src/components/review/EscalateDialog.vue`

```vue
<script setup>
/**
 * EscalateDialog — collects escalation notes for senior reviewer.
 *
 * Displays a modal with:
 *   - Notes textarea (min 10 chars) — why this case needs escalation
 *   - Suggested action textarea (optional) — what the reviewer recommends
 *   - Cancel and Submit buttons
 *
 * Props:
 *   visible: Boolean
 *
 * Emits:
 *   submit({ notes, suggestedAction })
 *   cancel()
 */

import { ref, computed } from 'vue';

defineProps({ visible: { type: Boolean, required: true } });
const emit = defineEmits(['submit', 'cancel']);

const notes = ref('');
const suggestedAction = ref('');

const isValid = computed(() => notes.value.trim().length >= 10);

function submit() {
  if (!isValid.value) return;
  emit('submit', {
    notes: notes.value.trim(),
    suggestedAction: suggestedAction.value.trim() || undefined,
  });
}
</script>
```

### File: `frontend/src/components/review/RequestInfoDialog.vue`

```vue
<script setup>
/**
 * RequestInfoDialog — collects requested information items.
 *
 * Displays a modal with:
 *   - Dynamic list of requested items, each with:
 *     - Description (text input, min 5 chars)
 *     - Category dropdown (document, clarification, verification, other)
 *   - "Add another item" button
 *   - General notes textarea (optional)
 *   - Cancel and Submit buttons
 *
 * At least one item is required.
 *
 * Props:
 *   visible: Boolean
 *
 * Emits:
 *   submit({ requestedItems, notes })
 *   cancel()
 */

import { ref, computed } from 'vue';

defineProps({ visible: { type: Boolean, required: true } });
const emit = defineEmits(['submit', 'cancel']);

const requestedItems = ref([
  { description: '', category: 'document' },
]);
const notes = ref('');

const categoryOptions = [
  { value: 'document', label: 'Document required' },
  { value: 'clarification', label: 'Clarification needed' },
  { value: 'verification', label: 'Verification required' },
  { value: 'other', label: 'Other' },
];

function addItem() {
  requestedItems.value.push({ description: '', category: 'document' });
}

function removeItem(index) {
  if (requestedItems.value.length > 1) {
    requestedItems.value.splice(index, 1);
  }
}

const isValid = computed(() =>
  requestedItems.value.length > 0 &&
  requestedItems.value.every((item) => item.description.trim().length >= 5)
);

function submit() {
  if (!isValid.value) return;
  emit('submit', {
    requestedItems: requestedItems.value.map((item) => ({
      description: item.description.trim(),
      category: item.category,
    })),
    notes: notes.value.trim() || undefined,
  });
}
</script>
```

### State Transitions

```
PENDING_HUMAN_REVIEW
  │
  ├─── POST /review/:caseId/approve ───► APPROVED
  │      └── confirmation dialog required
  │
  ├─── POST /review/:caseId/reject ────► REJECTED
  │      └── reasonCode + reason required
  │
  ├─── POST /review/:caseId/escalate ──► ESCALATED
  │      └── notes required, suggestedAction optional
  │
  └─── POST /review/:caseId/request-info ► ADDITIONAL_INFO_REQUIRED
         └── requestedItems[] required, notes optional
```

### Critical Fragments Gate

Before a final decision can be submitted, the reviewer must have reviewed at least the following "critical" fragment types:

| Fragment Type | Why Critical |
|--------------|-------------|
| `sanctions_hit` / `sanctions_clear` | Sanctions status directly determines if onboarding is legally possible |
| `risk_score_calculated` | Risk score drives the due diligence level |
| `ubo_identified` | Beneficial ownership is a core CDD requirement |

If any critical fragments remain unreviewed, the decision buttons are disabled with a tooltip: "Review screening and risk fragments before making a final decision."

## Acceptance Criteria

- [ ] Final decision panel rendered at bottom of case detail in review mode
- [ ] Four buttons: Approve (green), Reject (red), Escalate (yellow), Request Info (blue)
- [ ] Buttons disabled until critical fragments (screening, risk) are reviewed
- [ ] Disabled buttons show tooltip explaining what's needed
- [ ] Approve opens confirmation dialog; confirming calls POST /approve
- [ ] Reject opens RejectReasonDialog with reason code dropdown + free text
- [ ] Reject validates: reasonCode selected and reason >= 10 characters
- [ ] Escalate opens EscalateDialog with notes field + optional suggested action
- [ ] Escalate validates: notes >= 10 characters
- [ ] Request Info opens RequestInfoDialog with dynamic item list + optional notes
- [ ] Request Info validates: at least one item with description >= 5 characters
- [ ] All decisions call the Review API and log a `review_action` event
- [ ] After successful decision, reviewer is redirected to `/review` queue
- [ ] WebSocket `case:state_changed` emitted after each decision
- [ ] Submitting state disables buttons and shows loading indicator to prevent double-submission

## Dependencies

- **Depends on**: Review API endpoints (POST approve/reject/escalate/request-info), #65 (Fragment review — critical fragments gate), #64 (Review queue — redirect target after decision), #36 (WebSocket — state change events)
- **Blocks**: None (terminal step in the review workflow)

## Testing Strategy

1. **Panel renders**: Mount ReviewDecisionPanel in review mode, verify 4 action buttons visible
2. **Buttons disabled**: Set criticalFragmentsReviewed=false, verify buttons disabled with tooltip
3. **Buttons enabled**: Set criticalFragmentsReviewed=true, verify buttons clickable
4. **Approve — dialog**: Click Approve, verify confirmation dialog appears
5. **Approve — confirm**: Click confirm in dialog, verify POST /approve called, redirect to /review
6. **Approve — cancel**: Click cancel in dialog, verify no API call, panel remains
7. **Reject — dialog**: Click Reject, verify RejectReasonDialog opens
8. **Reject — valid**: Select reasonCode, enter 10+ char reason, submit, verify POST /reject called
9. **Reject — invalid**: Try submit without reasonCode, verify validation prevents
10. **Reject — short reason**: Enter 5 chars, verify submit disabled
11. **Escalate — dialog**: Click Escalate, verify EscalateDialog opens
12. **Escalate — valid**: Enter 10+ char notes, submit, verify POST /escalate called
13. **Escalate — with suggestion**: Enter notes + suggestedAction, verify both sent in payload
14. **Request Info — dialog**: Click Request Info, verify RequestInfoDialog opens
15. **Request Info — valid**: Add 2 items with descriptions, submit, verify POST /request-info called
16. **Request Info — add/remove items**: Click "Add another", verify new row; click remove, verify row removed
17. **Request Info — invalid**: Leave description empty, verify submit disabled
18. **Double-submit prevention**: Click approve + confirm, verify buttons disabled during submission
19. **Redirect**: After any decision, verify router.push to review-queue
20. **Event store**: After each decision, verify review_action event exists in decision_events (integration test)
