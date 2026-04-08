# Fragment-Level Review and Override

> GitHub Issue: [#65](https://github.com/jbillay/kyc-agent/issues/65)
> Epic: Human Review Workflow (#61)
> Size: L (3-5 days) | Priority: Critical

## Context

KYC agents produce dozens of decision fragments per case — each one an atomic decision linking a conclusion to evidence and LLM reasoning. A human reviewer needs to inspect these fragments, agree with correct decisions, flag incorrect ones, and provide alternative decisions where needed. This is analogous to a code review: the reviewer works through each fragment (like a diff hunk), approving or requesting changes at a granular level.

Fragment-level review is the core interaction model for human oversight. It enables reviewers to correct specific agent errors without re-running the entire case. Modified fragments preserve the original agent decision alongside the human override for audit purposes. A progress indicator ("15 of 23 fragments reviewed") helps reviewers track completion and ensures no fragments are overlooked.

## Requirements

### Functional

1. Every decision fragment in the case detail view has a review action button
2. Click a fragment to open the fragment review panel showing:
   - Fragment type and agent that produced it
   - Full decision text
   - Evidence (data sources, matched entries)
   - LLM reasoning (if applicable)
   - Confidence score
3. Review actions per fragment:
   - **Approve**: agree with the agent's decision (marks as `approved`)
   - **Reject**: disagree with the agent's decision (marks as `rejected`, reason required)
   - **Modify**: provide an alternative decision (marks as `human_modified`, original preserved)
4. Modified fragments preserve original decision in `original_decision` field
5. Visual indicators for review status:
   - Unreviewed: neutral/grey
   - Approved: green checkmark
   - Rejected: red X
   - Modified: orange pencil icon
6. Batch approve: select multiple fragments and approve all at once
7. Review progress indicator: "15 of 23 fragments reviewed" with progress bar
8. Fragments grouped by agent/category for easier navigation
9. All fragment review actions call `PATCH /api/v1/review/:caseId/fragments/:fragmentId`

### Non-Functional

- Fragment panel opens within 200ms (data already loaded with case details)
- Batch approve handles up to 50 fragments in a single operation
- Review progress updates in real-time as fragments are reviewed

## Technical Design

### File: `frontend/src/components/review/FragmentReviewPanel.vue`

```vue
<script setup>
/**
 * FragmentReviewPanel — the per-fragment review interaction.
 *
 * Opened as a slide-out panel (or modal) when a reviewer clicks a fragment.
 * Displays the full fragment details and provides approve/reject/modify actions.
 *
 * Props:
 *   fragment: Object — the decision fragment to review
 *   caseId: String — parent case ID
 *
 * Emits:
 *   reviewed({ fragmentId, action, result }) — after a review action completes
 *   close() — when panel is dismissed
 */

import { ref, computed } from 'vue';
import api from '@/services/api';

const props = defineProps({
  fragment: { type: Object, required: true },
  caseId: { type: String, required: true },
});

const emit = defineEmits(['reviewed', 'close']);

const action = ref(null); // 'approve' | 'reject' | 'modify'
const rejectReason = ref('');
const modifiedDecision = ref('');
const modifiedConfidence = ref(null);
const submitting = ref(false);

const isReviewed = computed(() =>
  ['approved', 'rejected', 'human_modified'].includes(props.fragment.reviewStatus)
);

/**
 * Submit the review action to the API.
 *
 * Calls PATCH /api/v1/review/:caseId/fragments/:fragmentId
 */
async function submitReview() {
  submitting.value = true;

  const payload = { action: action.value };

  if (action.value === 'reject') {
    payload.reason = rejectReason.value;
  }
  if (action.value === 'modify') {
    payload.modifiedDecision = modifiedDecision.value;
    if (modifiedConfidence.value !== null) {
      payload.modifiedConfidence = modifiedConfidence.value;
    }
  }

  const response = await api.patch(
    `/review/${props.caseId}/fragments/${props.fragment.id}`,
    payload
  );

  emit('reviewed', {
    fragmentId: props.fragment.id,
    action: action.value,
    result: response.data,
  });

  submitting.value = false;
}

/**
 * Fragment type → human-readable label mapping.
 */
function fragmentTypeLabel(type) {
  const labels = {
    entity_resolved: 'Entity Resolution',
    entity_not_found: 'Entity Not Found',
    ubo_identified: 'UBO Identified',
    ownership_layer: 'Ownership Layer',
    sanctions_clear: 'Sanctions Clear',
    sanctions_hit: 'Sanctions Hit',
    pep_identified: 'PEP Identified',
    adverse_media_found: 'Adverse Media',
    risk_factor_identified: 'Risk Factor',
    risk_score_calculated: 'Risk Score',
    narrative_generated: 'Risk Narrative',
    qa_completeness: 'QA Completeness',
    qa_consistency: 'QA Consistency',
    qa_compliance: 'QA Compliance',
    qa_summary: 'QA Summary',
  };
  return labels[type] || type;
}
</script>
```

### File: `frontend/src/components/review/FragmentReviewProgress.vue`

```vue
<script setup>
/**
 * FragmentReviewProgress — progress indicator for fragment review.
 *
 * Shows "15 of 23 fragments reviewed" with a progress bar.
 * Updates reactively as fragments are reviewed.
 *
 * Props:
 *   fragments: Array — all decision fragments for the case
 */

import { computed } from 'vue';

const props = defineProps({
  fragments: { type: Array, required: true },
});

const totalFragments = computed(() => props.fragments.length);

const reviewedFragments = computed(() =>
  props.fragments.filter((f) =>
    ['approved', 'rejected', 'human_modified'].includes(f.reviewStatus)
  ).length
);

const progressPercent = computed(() =>
  totalFragments.value > 0
    ? Math.round((reviewedFragments.value / totalFragments.value) * 100)
    : 0
);

const allReviewed = computed(() =>
  reviewedFragments.value === totalFragments.value && totalFragments.value > 0
);
</script>
```

### File: `frontend/src/components/review/BatchApproveDialog.vue`

```vue
<script setup>
/**
 * BatchApproveDialog — batch approve multiple fragments at once.
 *
 * Reviewer selects fragments (via checkboxes in the fragment list),
 * then clicks "Batch Approve" to approve all selected fragments in one action.
 *
 * Props:
 *   caseId: String — parent case ID
 *   selectedFragments: Array — fragment IDs selected for batch approval
 *
 * Emits:
 *   approved(fragmentIds) — after batch approve completes
 *   cancel() — when dialog is dismissed
 *
 * Implementation:
 *   Sends parallel PATCH requests for each fragment.
 *   Shows progress ("Approving 3 of 12...") and handles partial failures.
 */

import { ref } from 'vue';
import api from '@/services/api';

const props = defineProps({
  caseId: { type: String, required: true },
  selectedFragments: { type: Array, required: true },
});

const emit = defineEmits(['approved', 'cancel']);

const approving = ref(false);
const progress = ref(0);
const errors = ref([]);

async function batchApprove() {
  approving.value = true;
  progress.value = 0;
  errors.value = [];

  const results = await Promise.allSettled(
    props.selectedFragments.map(async (fragmentId) => {
      const result = await api.patch(
        `/review/${props.caseId}/fragments/${fragmentId}`,
        { action: 'approve' }
      );
      progress.value++;
      return result;
    })
  );

  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length > 0) {
    errors.value = failed.map((f) => f.reason?.message || 'Unknown error');
  }

  approving.value = false;
  emit('approved', props.selectedFragments);
}
</script>
```

### Fragment List Integration in Case Detail

The fragment list in the case detail view (existing component from #41) is augmented with review capabilities when in review mode:

```vue
<!-- In CaseDetail.vue — conditional review mode overlay -->
<script setup>
/**
 * When the route has ?review=full or ?review=streamlined,
 * the case detail view enters "review mode":
 *
 * - Each fragment row gets a checkbox (for batch select) and a review action button
 * - Clicking the action button opens FragmentReviewPanel
 * - FragmentReviewProgress bar shown at the top
 * - Batch approve button shown when fragments are selected
 * - Review status icons shown on each fragment row
 *
 * Fragment grouping by agent:
 *   - Entity Resolution fragments
 *   - Ownership & UBO fragments
 *   - Screening fragments
 *   - Risk Assessment fragments
 *   - QA fragments (if applicable)
 */
</script>
```

### Fragment Review Status Lifecycle

```
Fragment created by agent
  │
  ▼
auto_approved (low-risk, auto-QA passed)
  │                                      ┐
  ▼                                      │
pending_review (default for human review)│
  │                                      │
  ├──► approved (reviewer agrees)        │
  ├──► rejected (reviewer disagrees)     ├── All statuses
  └──► human_modified (reviewer edits)   │
         │                               │
         ├── original_decision preserved │
         └── new decision + confidence   ┘
```

### Visual Status Indicators

| Status | Icon | Color | Meaning |
|--------|------|-------|---------|
| `pending_review` | Circle outline | Grey | Not yet reviewed |
| `auto_approved` | Checkmark | Light green | Auto-approved by QA |
| `approved` | Checkmark (filled) | Green | Reviewer approved |
| `rejected` | X mark | Red | Reviewer rejected |
| `human_modified` | Pencil | Orange | Reviewer provided alternative |

## Acceptance Criteria

- [ ] Every decision fragment in case detail view has a review action button (in review mode)
- [ ] Clicking opens FragmentReviewPanel showing: type, decision, evidence, LLM reasoning, confidence
- [ ] Approve action marks fragment as `approved`, calls PATCH API
- [ ] Reject action requires reason, marks as `rejected`, calls PATCH API
- [ ] Modify action requires alternative decision text, marks as `human_modified`
- [ ] Modified fragments preserve original decision in `original_decision`
- [ ] Visual indicators: grey (unreviewed), green (approved), red (rejected), orange (modified)
- [ ] Batch approve: select multiple fragments via checkboxes, approve all at once
- [ ] Batch approve shows progress ("Approving 3 of 12...") and handles partial failures
- [ ] Review progress indicator shows "15 of 23 fragments reviewed" with progress bar
- [ ] Progress updates in real-time as fragments are reviewed
- [ ] Fragments grouped by agent/category for navigation
- [ ] Already-reviewed fragments show their status and can be re-reviewed (overrides previous action)
- [ ] Fragment type labels are human-readable (not raw enum values)

## Dependencies

- **Depends on**: Review API endpoints (PATCH /fragments/:fragmentId), #35 (Fragments API — fragment data), #41 (Case detail view — host for review panel), #64 (Review queue — entry point)
- **Blocks**: #66 (Review decision — reviewers complete fragment review before final decision)

## Testing Strategy

1. **Panel opens**: Click fragment action button, verify FragmentReviewPanel mounts with correct fragment data
2. **Panel displays data**: Verify decision text, evidence, confidence, agent type all rendered
3. **Approve**: Click approve, verify PATCH called with action=approve, fragment status updates to green
4. **Reject — with reason**: Enter reason, click reject, verify PATCH called with action=reject + reason
5. **Reject — without reason**: Try to submit reject without reason, verify validation prevents submission
6. **Modify — with decision**: Enter new decision, click modify, verify PATCH called with modifiedDecision
7. **Modify — preserves original**: After modify, verify originalDecision field populated in response
8. **Modify — without decision**: Try to submit modify without text, verify validation prevents submission
9. **Visual indicators**: Review 3 fragments (1 approve, 1 reject, 1 modify), verify correct icons/colors
10. **Progress indicator**: 5 fragments total, review 3, verify "3 of 5 fragments reviewed" and 60% bar
11. **Batch approve**: Select 4 fragments, click batch approve, verify 4 PATCH calls made
12. **Batch approve progress**: During batch, verify progress text updates ("Approving 2 of 4...")
13. **Batch approve partial failure**: Mock 1 of 4 failing, verify error shown and 3 succeed
14. **Fragment grouping**: Verify fragments grouped by agent type with section headers
15. **Re-review**: Approve a fragment, then click again and reject it, verify status updates to rejected
16. **Fragment type labels**: Verify `sanctions_hit` displays as "Sanctions Hit", etc.
