# Basic Frontend — Screening Results Display

> GitHub Issue: [#43](https://github.com/jbillay/kyc-agent/issues/43)
> Epic: Basic Frontend — Phase 1 (#38)
> Size: M (1-3 days) | Priority: High

## Context

After the Screening Agent completes, the Screening tab in the case detail view needs to display per-subject results: who was screened, against which lists, whether they were cleared or had hits, and the LLM's reasoning for confirming or dismissing each hit. This is critical for analyst review — they need to understand why the system flagged or cleared each person, and they may need to override a decision. Phase 1 focuses on display; fragment-level override capability comes in the Review Workflow epic.

## Requirements

### Functional

1. Screening tab in case detail view (mounted by Story #41)
2. Summary statistics bar: total screened, total clear, total with hits, total dismissed
3. Per-subject expandable panel: each screened person or entity has an accordion section
4. Subject header shows: name, type (individual/entity), role(s), overall status (clear / hits found)
5. For clear subjects: green indicator, list of providers checked
6. For subjects with hits: expandable hit cards, one per screening hit
7. Each hit card shows: source list (OFAC SDN / UK HMT), match score, matched name on list, verdict (confirmed/dismissed), LLM reasoning
8. Color coding: green (all clear), yellow (dismissed hits), red (confirmed hits)
9. Real-time: screening results appear as the Screening Agent completes

### Non-Functional

- Renders up to 15 subjects with up to 5 hits each without performance issues
- Accordions are collapsed by default; analyst opens only what they need

## Technical Design

### File: `frontend/src/components/screening/ScreeningResults.vue`

```vue
<template>
  <div class="screening-results">
    <!-- No data yet -->
    <div v-if="!screeningReport" class="screening-pending">
      <p>Screening results are being processed by the agent...</p>
    </div>

    <template v-else>
      <!-- Summary Statistics -->
      <div class="screening-summary">
        <div class="stat">
          <span class="stat-value">{{ screeningReport.summary.totalScreened }}</span>
          <span class="stat-label">Screened</span>
        </div>
        <div class="stat stat-clear">
          <span class="stat-value">{{ screeningReport.summary.totalClear }}</span>
          <span class="stat-label">Clear</span>
        </div>
        <div class="stat stat-hits">
          <span class="stat-value">{{ screeningReport.summary.totalWithHits }}</span>
          <span class="stat-label">With Hits</span>
        </div>
        <div class="stat stat-dismissed">
          <span class="stat-value">{{ screeningReport.summary.totalDismissed }}</span>
          <span class="stat-label">Dismissed</span>
        </div>
      </div>

      <!-- Overall Risk Indicator -->
      <div class="screening-risk" :class="`risk-${screeningReport.overallRisk}`">
        Overall Screening Risk: <strong>{{ screeningReport.overallRisk }}</strong>
      </div>

      <!-- Per-Subject Panels -->
      <div class="subject-list">
        <div
          v-for="subject in screeningReport.subjects"
          :key="subject.id"
          class="subject-panel"
          :class="`subject-${subjectStatus(subject)}`"
        >
          <!-- Subject Header (always visible) -->
          <button
            class="subject-header"
            @click="toggleSubject(subject.id)"
          >
            <div class="subject-info">
              <span class="status-indicator" :class="subjectStatus(subject)" />
              <span class="subject-name">{{ subject.name }}</span>
              <span class="subject-type badge" :class="subject.entityType">
                {{ subject.entityType }}
              </span>
              <span class="subject-roles">{{ subject.roles.join(', ') }}</span>
            </div>
            <div class="subject-summary">
              <span v-if="subjectStatus(subject) === 'clear'" class="status-text status-clear">
                All Clear
              </span>
              <span v-else-if="hasConfirmedHits(subject)" class="status-text status-confirmed">
                {{ confirmedCount(subject) }} Confirmed Hit{{ confirmedCount(subject) > 1 ? 's' : '' }}
              </span>
              <span v-else class="status-text status-dismissed">
                {{ subject.hits.length }} Hit{{ subject.hits.length > 1 ? 's' : '' }} (all dismissed)
              </span>
              <span class="expand-icon">{{ expandedSubjects.has(subject.id) ? '▾' : '▸' }}</span>
            </div>
          </button>

          <!-- Subject Detail (expanded) -->
          <div v-if="expandedSubjects.has(subject.id)" class="subject-detail">
            <!-- Clear subject -->
            <div v-if="subjectStatus(subject) === 'clear'" class="clear-detail">
              <p>No matches found across the following sanctions lists:</p>
              <ul>
                <li v-for="source in subject.sourcesChecked" :key="source">{{ source }}</li>
              </ul>
            </div>

            <!-- Subject with hits -->
            <div v-else class="hits-list">
              <ScreeningHitCard
                v-for="hit in subject.hits"
                :key="hit.listEntryId"
                :hit="hit"
              />
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import ScreeningHitCard from './ScreeningHitCard.vue';

defineProps({
  screeningReport: { type: Object, default: null },
});

/** @type {import('vue').Ref<Set<string>>} */
const expandedSubjects = ref(new Set());

function toggleSubject(subjectId) {
  if (expandedSubjects.value.has(subjectId)) {
    expandedSubjects.value.delete(subjectId);
  } else {
    expandedSubjects.value.add(subjectId);
  }
  // Trigger reactivity
  expandedSubjects.value = new Set(expandedSubjects.value);
}

function subjectStatus(subject) {
  if (!subject.hits || subject.hits.length === 0) return 'clear';
  if (subject.hits.some((h) => h.verdict === 'confirmed')) return 'confirmed';
  return 'dismissed';
}

function hasConfirmedHits(subject) {
  return subject.hits?.some((h) => h.verdict === 'confirmed');
}

function confirmedCount(subject) {
  return subject.hits?.filter((h) => h.verdict === 'confirmed').length || 0;
}
</script>
```

### File: `frontend/src/components/screening/ScreeningHitCard.vue`

```vue
<template>
  <div class="hit-card" :class="`hit-${hit.verdict}`">
    <div class="hit-header">
      <div class="hit-source">
        <span class="source-badge">{{ hit.source }}</span>
        <span class="match-score" :class="scoreClass">
          {{ hit.matchScore }}% match
        </span>
      </div>
      <span class="verdict-badge" :class="`verdict-${hit.verdict}`">
        {{ hit.verdict }}
      </span>
    </div>

    <div class="hit-details">
      <div class="hit-field">
        <span class="field-label">Matched Name</span>
        <span class="field-value">{{ hit.matchedName }}</span>
      </div>

      <div v-if="hit.matchedFields?.length" class="hit-matched-fields">
        <span class="field-label">Matched Fields</span>
        <div class="matched-fields-list">
          <span v-for="field in hit.matchedFields" :key="field" class="matched-field-tag">
            {{ field }}
          </span>
        </div>
      </div>

      <div v-if="hit.listEntry" class="hit-list-entry">
        <span class="field-label">List Entry Details</span>
        <table class="entry-table">
          <tr v-if="hit.listEntry.programs?.length">
            <td>Programs</td>
            <td>{{ hit.listEntry.programs.join(', ') }}</td>
          </tr>
          <tr v-if="hit.listEntry.dateOfBirth">
            <td>Date of Birth</td>
            <td>{{ hit.listEntry.dateOfBirth }}</td>
          </tr>
          <tr v-if="hit.listEntry.nationality">
            <td>Nationality</td>
            <td>{{ hit.listEntry.nationality }}</td>
          </tr>
          <tr v-if="hit.listEntry.remarks">
            <td>Remarks</td>
            <td>{{ hit.listEntry.remarks }}</td>
          </tr>
        </table>
      </div>
    </div>

    <!-- LLM Reasoning -->
    <details class="hit-reasoning">
      <summary>LLM Reasoning</summary>
      <div class="reasoning-text">{{ hit.reasoning }}</div>
      <div v-if="hit.dismissalReason" class="dismissal-reason">
        <strong>Dismissal reason:</strong> {{ hit.dismissalReason }}
      </div>
      <div v-if="hit.confidenceInVerdict" class="verdict-confidence">
        Confidence in verdict: {{ hit.confidenceInVerdict }}%
      </div>
    </details>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  hit: { type: Object, required: true },
});

const scoreClass = computed(() => {
  const score = props.hit.matchScore;
  if (score >= 95) return 'score-very-high';
  if (score >= 90) return 'score-high';
  if (score >= 85) return 'score-medium';
  return 'score-low';
});
</script>
```

### Screening Report Data Shape

The `screeningReport` object comes from the Screening Agent output stored in `agent_results`:

```javascript
{
  overallRisk: 'low',         // 'clear' | 'low' | 'critical'
  summary: {
    totalScreened: 5,
    totalClear: 4,
    totalWithHits: 1,
    totalDismissed: 1,
    totalConfirmed: 0,
  },
  subjects: [
    {
      id: 'uuid',
      name: 'John Smith',
      entityType: 'individual',
      roles: ['director', 'shareholder'],
      sourcesChecked: ['OFAC-SDN', 'UK-HMT'],
      hits: [
        {
          listEntryId: 'sdn-12345',
          source: 'OFAC-SDN',
          matchScore: 88,
          matchedName: 'JOHN SMITH',
          matchedFields: ['name', 'nationality'],
          verdict: 'dismissed',
          reasoning: 'While the name matches, the date of birth differs significantly (subject: 1975-03, list entry: 1960-11). Nationality match (British) but different address country. The list entry is associated with narcotics trafficking programs, inconsistent with the subject context.',
          dismissalReason: 'dob_mismatch',
          confidenceInVerdict: 92,
          listEntry: {
            programs: ['SDNT'],
            dateOfBirth: '1960-11',
            nationality: 'British',
            remarks: 'Linked to narcotics trafficking network',
          },
        },
      ],
    },
    {
      id: 'uuid',
      name: 'Acme Holdings Ltd',
      entityType: 'entity',
      roles: ['subject-entity'],
      sourcesChecked: ['OFAC-SDN', 'UK-HMT'],
      hits: [],
    },
  ],
}
```

### Color Coding Scheme

| Subject Status | Indicator Color | Background |
|---------------|----------------|------------|
| All clear (no hits) | Green | Light green |
| All hits dismissed | Yellow/Amber | Light yellow |
| One or more confirmed hits | Red | Light red |

| Verdict | Badge Color |
|---------|------------|
| `confirmed` | Red |
| `dismissed` | Grey/Yellow |

| Match Score | Badge Color |
|------------|------------|
| ≥ 95% | Red (very high) |
| ≥ 90% | Orange (high) |
| ≥ 85% | Yellow (medium) |
| < 85% | Grey (low) |

## Acceptance Criteria

- [ ] Screening tab in case detail view displays screening results
- [ ] Summary statistics: total screened, total clear, total with hits, total dismissed
- [ ] Overall screening risk indicator (clear/low/critical)
- [ ] Per-subject expandable accordion panel
- [ ] Subject header: name, type badge, role(s), overall status
- [ ] Clear subjects: green indicator, list of sources checked
- [ ] Subjects with hits: expandable hit cards per hit
- [ ] Hit card: source list, match score, matched name, verdict badge, matched fields
- [ ] Hit card: list entry details (programs, DOB, nationality, remarks)
- [ ] LLM reasoning expandable per hit (collapsible `<details>`)
- [ ] Dismissal reason shown for dismissed hits
- [ ] Color coding: green (clear), yellow (dismissed), red (confirmed)
- [ ] Accordions collapsed by default
- [ ] "Processing" message shown when screening report is not yet available
- [ ] Real-time: results appear when Screening Agent completes

## Dependencies

- **Depends on**: #41 (Case Detail View — mounts this component in Screening tab), #31-#33 (Screening Agent — produces the ScreeningReport data)
- **Blocks**: None

## Testing Strategy

1. **Pending state**: Mount with null screeningReport, verify "being processed" message
2. **Summary statistics**: Mount with report, verify all 4 stat values render correctly
3. **Overall risk**: Mount with `overallRisk: 'critical'`, verify red styling
4. **Clear subject**: Subject with 0 hits, verify green indicator and "All Clear" text
5. **Subject with dismissed hits**: Subject with 2 dismissed hits, verify yellow indicator and hit count
6. **Subject with confirmed hit**: Subject with 1 confirmed hit, verify red indicator
7. **Accordion toggle**: Click subject header, verify detail panel expands; click again, verify collapse
8. **Default collapsed**: Mount with multiple subjects, verify none expanded initially
9. **Clear subject detail**: Expand clear subject, verify sources checked list
10. **Hit card rendering**: Expand subject with hit, verify source, score, matched name, verdict
11. **Hit card — list entry**: Provide hit with listEntry details, verify programs, DOB, nationality render
12. **LLM reasoning**: Click "LLM Reasoning" summary, verify reasoning text shown
13. **Dismissal reason**: Hit with dismissalReason, verify displayed
14. **Score color coding**: Provide hits with scores 96, 91, 86, 80, verify correct color classes
15. **Multiple subjects**: Provide 5 subjects with mixed statuses, verify all render correctly
