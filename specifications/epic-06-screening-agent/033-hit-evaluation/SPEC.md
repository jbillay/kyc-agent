# Screening Agent — LLM-Based Hit Evaluation and Dismissal

> GitHub Issue: [#33](https://github.com/jbillay/kyc-agent/issues/33)
> Epic: Screening Agent — Phase 1 (#30)
> Size: L (3-5 days) | Priority: Critical

## Context

Fuzzy name matching produces potential hits, but many are false positives (common names, partial matches). This step uses an LLM to evaluate each potential hit by comparing: name similarity in detail, date of birth match/mismatch, nationality match/mismatch, entity type, and any other identifying information. The LLM produces a structured `confirmed` or `dismissed` verdict with detailed reasoning. The agent is deliberately conservative — when in doubt, the hit is confirmed for human review rather than dismissed. After evaluation, a `ScreeningReport` is compiled as the agent's output.

## Requirements

### Functional

1. Step `evaluate_sanctions_hits`: for each potential hit, LLM evaluates match quality
2. LLM produces structured output: `confirmed` or `dismissed` with reasoning
3. Decision fragments: `sanctions_hit` (confirmed) or `sanctions_dismissed` (with dismissal reason)
4. Step `compile_screening_report`: aggregates all results into `ScreeningReport`
5. Report includes: per-subject breakdown, confirmed hits, dismissed hits with reasoning, overall screening risk
6. Prompt handles edge cases: partial DOB, multiple matches on same list, common names

### Non-Functional

- LLM evaluation of all hits completes in under 30 seconds
- Conservative: ambiguous cases are confirmed (false negative is worse than false positive)
- LLM task type: `screening`
- Temperature: 0.1

## Technical Design

### File: `backend/src/agents/screening/index.js` (continued from Story #32)

```javascript
  // ─── Step 3: Evaluate Sanctions Hits with LLM ────

  /**
   * LLM evaluates each potential hit to confirm or dismiss.
   *
   * Groups hits by subject and evaluates each hit individually.
   * Conservative approach: ambiguous cases are confirmed for human review.
   */
  async _evaluateSanctionsHits(context) {
    const fragments = [];
    const llmCalls = [];

    // Collect subjects that have potential hits
    const subjectsWithHits = [];
    for (const [subjectId, entry] of this._screeningResults) {
      if (entry.hits.length > 0) {
        subjectsWithHits.push(entry);
      }
    }

    if (subjectsWithHits.length === 0) {
      return {
        description: 'No potential hits to evaluate',
        decisionFragments: [],
        llmCalls: [],
      };
    }

    for (const { subject, hits } of subjectsWithHits) {
      // Build prompt with all hits for this subject
      const prompt = prompts.evaluateSanctionsHits({
        subject: {
          name: subject.name,
          entityType: subject.entityType,
          roles: subject.roles,
          dateOfBirth: subject.dateOfBirth,
          nationality: subject.nationality,
          countryOfResidence: subject.countryOfResidence,
        },
        hits: hits.map((h) => ({
          source: h.source,
          matchedName: h.matchedName,
          matchScore: h.matchScore,
          matchedFields: h.matchedFields,
          listEntry: {
            id: h.listEntry.id,
            names: h.listEntry.names,
            dateOfBirth: h.listEntry.dateOfBirth,
            nationality: h.listEntry.nationality,
            programs: h.listEntry.programs,
            remarks: h.listEntry.remarks,
          },
        })),
      });

      const response = await this.llmService.complete({
        messages: prompt.messages,
        taskType: 'screening',
        structuredOutput: {
          name: 'hit_evaluation',
          schema: {
            type: 'object',
            properties: {
              evaluations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    listEntryId: { type: 'string' },
                    source: { type: 'string' },
                    verdict: { type: 'string', enum: ['confirmed', 'dismissed'] },
                    reasoning: { type: 'string' },
                    dismissalReason: {
                      type: 'string',
                      enum: ['dob_mismatch', 'nationality_mismatch', 'entity_type_mismatch',
                             'different_person', 'insufficient_data', 'other'],
                    },
                    confidenceInVerdict: { type: 'number' },
                  },
                  required: ['listEntryId', 'source', 'verdict', 'reasoning', 'confidenceInVerdict'],
                },
              },
            },
            required: ['evaluations'],
          },
        },
        temperature: 0.1,
        callContext: {
          caseId: context.caseId,
          agentType: 'screening',
          stepName: 'evaluate_sanctions_hits',
        },
      });

      llmCalls.push({
        model: response.model,
        provider: response.provider,
        latencyMs: response.latencyMs,
      });

      const evaluations = response.structured?.evaluations || [];

      for (const evaluation of evaluations) {
        // Find the original hit for evidence
        const originalHit = hits.find(
          (h) => h.listEntry.id === evaluation.listEntryId && h.source === evaluation.source
        );

        if (evaluation.verdict === 'confirmed') {
          fragments.push({
            type: FragmentType.SANCTIONS_HIT,
            decision: `Confirmed sanctions match: "${subject.name}" matches "${originalHit?.matchedName || 'unknown'}" on ${evaluation.source} (${originalHit?.listEntry.programs?.join(', ') || 'unknown program'})`,
            confidence: evaluation.confidenceInVerdict || 90,
            evidence: {
              dataSources: [evaluation.source.toLowerCase()],
              dataPoints: [
                { source: evaluation.source, field: 'matched_name', value: originalHit?.matchedName, fetchedAt: new Date().toISOString() },
                { source: evaluation.source, field: 'match_score', value: originalHit?.matchScore, fetchedAt: new Date().toISOString() },
                { source: evaluation.source, field: 'list_entry_id', value: evaluation.listEntryId, fetchedAt: new Date().toISOString() },
                { source: evaluation.source, field: 'programs', value: originalHit?.listEntry.programs, fetchedAt: new Date().toISOString() },
              ],
              llmReasoning: evaluation.reasoning,
            },
            status: 'pending_review', // Confirmed hits always need human review
          });
        } else {
          fragments.push({
            type: FragmentType.SANCTIONS_DISMISSED,
            decision: `Dismissed sanctions match: "${subject.name}" vs "${originalHit?.matchedName || 'unknown'}" on ${evaluation.source} — ${evaluation.dismissalReason || 'false positive'}`,
            confidence: evaluation.confidenceInVerdict || 80,
            evidence: {
              dataSources: [evaluation.source.toLowerCase()],
              dataPoints: [
                { source: evaluation.source, field: 'matched_name', value: originalHit?.matchedName, fetchedAt: new Date().toISOString() },
                { source: evaluation.source, field: 'match_score', value: originalHit?.matchScore, fetchedAt: new Date().toISOString() },
                { source: evaluation.source, field: 'list_entry_id', value: evaluation.listEntryId, fetchedAt: new Date().toISOString() },
                { source: evaluation.source, field: 'dismissal_reason', value: evaluation.dismissalReason, fetchedAt: new Date().toISOString() },
              ],
              llmReasoning: evaluation.reasoning,
            },
            status: 'auto_approved',
          });
        }
      }

      // Store evaluations back into results for report compilation
      const entry = this._screeningResults.get(subject.id);
      entry.evaluations = evaluations;
    }

    const confirmed = fragments.filter((f) => f.type === FragmentType.SANCTIONS_HIT).length;
    const dismissed = fragments.filter((f) => f.type === FragmentType.SANCTIONS_DISMISSED).length;

    return {
      description: `Evaluated ${fragments.length} potential hits — ${confirmed} confirmed, ${dismissed} dismissed`,
      decisionFragments: fragments,
      llmCalls,
    };
  }

  // ─── Step 4: Compile Screening Report ─────────────

  /**
   * Assemble the ScreeningReport output for downstream agents.
   */
  async _compileScreeningReport(context) {
    const subjects = [];
    let totalConfirmed = 0;
    let totalDismissed = 0;
    let totalClear = 0;

    for (const [subjectId, entry] of this._screeningResults) {
      const { subject, hits, evaluations } = entry;

      if (hits.length === 0) {
        totalClear++;
        subjects.push({
          id: subject.id,
          name: subject.name,
          entityType: subject.entityType,
          roles: subject.roles,
          screeningStatus: 'clear',
          hits: [],
        });
        continue;
      }

      const evaluatedHits = (evaluations || []).map((ev) => {
        const originalHit = hits.find(
          (h) => h.listEntry.id === ev.listEntryId && h.source === ev.source
        );
        return {
          source: ev.source,
          listEntryId: ev.listEntryId,
          matchedName: originalHit?.matchedName,
          matchScore: originalHit?.matchScore,
          verdict: ev.verdict,
          reasoning: ev.reasoning,
          dismissalReason: ev.dismissalReason,
          programs: originalHit?.listEntry.programs || [],
        };
      });

      const confirmed = evaluatedHits.filter((h) => h.verdict === 'confirmed');
      const dismissed = evaluatedHits.filter((h) => h.verdict === 'dismissed');
      totalConfirmed += confirmed.length;
      totalDismissed += dismissed.length;

      subjects.push({
        id: subject.id,
        name: subject.name,
        entityType: subject.entityType,
        roles: subject.roles,
        screeningStatus: confirmed.length > 0 ? 'hits_confirmed' : 'hits_dismissed',
        hits: evaluatedHits,
      });
    }

    // Determine overall screening risk
    let overallRisk = 'clear';
    if (totalConfirmed > 0) overallRisk = 'critical';
    else if (totalDismissed > 0) overallRisk = 'low';

    this._report = {
      totalSubjects: this._subjects.length,
      totalClear: totalClear,
      totalWithHits: this._subjects.length - totalClear,
      totalConfirmedHits: totalConfirmed,
      totalDismissedHits: totalDismissed,
      overallRisk,
      listsScreened: ['OFAC-SDN', 'UK-HMT'],
      subjects,
    };

    return {
      description: `Screening report compiled: ${totalClear} clear, ${totalConfirmed} confirmed hits, ${totalDismissed} dismissed — overall risk: ${overallRisk}`,
      decisionFragments: [],
      llmCalls: [],
    };
  }
```

### File: `backend/src/agents/screening/prompts.js`

```javascript
/**
 * Prompt templates for the Screening Agent.
 */

const prompts = {
  /**
   * Evaluate potential sanctions hits for a single subject.
   *
   * @param {Object} params
   * @param {Object} params.subject - The person/entity being screened
   * @param {Array} params.hits - Potential matches from fuzzy matching
   * @returns {{ messages: import('../../llm/types').LLMMessage[] }}
   */
  evaluateSanctionsHits({ subject, hits }) {
    const hitDetails = hits.map((h, i) =>
      `Hit ${i + 1}:
  Source: ${h.source}
  Matched Name: "${h.matchedName}"
  Match Score: ${h.matchScore}/100
  Matched Fields: ${h.matchedFields.join(', ')}
  List Entry ID: ${h.listEntry.id}
  All Names on List: ${h.listEntry.names.join('; ')}
  DOB on List: ${h.listEntry.dateOfBirth || 'Not available'}
  Nationality on List: ${h.listEntry.nationality?.join(', ') || 'Not available'}
  Programs: ${h.listEntry.programs?.join(', ') || 'Not specified'}
  Remarks: ${h.listEntry.remarks || 'None'}`
    ).join('\n\n');

    return {
      messages: [
        {
          role: 'system',
          content: `You are a sanctions compliance specialist evaluating potential sanctions screening matches.

For each potential hit, determine whether it is a TRUE MATCH or a FALSE POSITIVE.

Evaluation criteria:
1. **Name analysis**: How similar are the names? Consider spelling variations, transliterations, abbreviations, and common name patterns.
2. **Date of birth**: If both sides have a DOB, compare them. A DOB mismatch is strong evidence of a false positive. A DOB match significantly increases likelihood of a true match.
3. **Nationality**: Compare nationalities. A mismatch doesn't necessarily mean false positive (people change residency) but is a relevant factor.
4. **Entity type**: Is the subject an individual being matched against an entity entry (or vice versa)? This is usually a false positive.
5. **Context**: Consider the sanctions program, remarks, and other identifying information.

IMPORTANT — Be CONSERVATIVE:
- If you are UNCERTAIN, mark the hit as "confirmed". A false negative (missing a real sanctions hit) is far worse than a false positive.
- Only dismiss a hit if you have clear, specific reasons (e.g., definitive DOB mismatch, clearly different person/entity).
- A high fuzzy match score (>90) with no contradicting information should be confirmed.

For each hit, return:
- listEntryId: the list entry ID
- source: the source list (OFAC-SDN or UK-HMT)
- verdict: "confirmed" or "dismissed"
- reasoning: detailed explanation of your decision
- dismissalReason (if dismissed): one of: dob_mismatch, nationality_mismatch, entity_type_mismatch, different_person, insufficient_data, other
- confidenceInVerdict: 0-100 how confident you are in this verdict`,
        },
        {
          role: 'user',
          content: `Subject being screened:
  Name: "${subject.name}"
  Type: ${subject.entityType}
  Roles: ${subject.roles.join(', ')}
  DOB: ${subject.dateOfBirth || 'Not available'}
  Nationality: ${subject.nationality || 'Not available'}
  Country of Residence: ${subject.countryOfResidence || 'Not available'}

Potential sanctions matches to evaluate:

${hitDetails}

Evaluate each hit and return a JSON object with an "evaluations" array.`,
        },
      ],
    };
  },
};

module.exports = { prompts };
```

### File: `backend/src/agents/screening/screening-report.js`

```javascript
/**
 * ScreeningReport — structured output of the Screening Agent.
 *
 * Consumed by the Risk Assessment Agent for scoring.
 *
 * @typedef {Object} ScreeningReport
 * @property {number} totalSubjects - Total people/entities screened
 * @property {number} totalClear - Subjects with no matches
 * @property {number} totalWithHits - Subjects with at least one potential match
 * @property {number} totalConfirmedHits - Hits confirmed by LLM
 * @property {number} totalDismissedHits - Hits dismissed by LLM
 * @property {'clear'|'low'|'critical'} overallRisk - clear=no hits, low=all dismissed, critical=confirmed hits
 * @property {string[]} listsScreened - e.g., ['OFAC-SDN', 'UK-HMT']
 * @property {ScreeningSubjectResult[]} subjects
 */

/**
 * @typedef {Object} ScreeningSubjectResult
 * @property {string} id - Subject UUID
 * @property {string} name
 * @property {'individual'|'entity'} entityType
 * @property {string[]} roles
 * @property {'clear'|'hits_confirmed'|'hits_dismissed'} screeningStatus
 * @property {EvaluatedHit[]} hits
 */

/**
 * @typedef {Object} EvaluatedHit
 * @property {string} source - e.g., 'OFAC-SDN'
 * @property {string} listEntryId
 * @property {string} matchedName
 * @property {number} matchScore
 * @property {'confirmed'|'dismissed'} verdict
 * @property {string} reasoning
 * @property {string} [dismissalReason]
 * @property {string[]} programs
 */

module.exports = {};
```

### LLM Evaluation Flow

```
Subject "John Smith" has 3 potential hits
  │
  ├── Build prompt with subject metadata + all 3 hits
  │
  ├── LLM (screening task type, temperature 0.1)
  │     │
  │     ├── Hit 1: OFAC "JOHN A. SMITH" (score 92, DOB matches) → confirmed
  │     ├── Hit 2: OFAC "JONATHAN SMITH" (score 87, DOB mismatch) → dismissed (dob_mismatch)
  │     └── Hit 3: HMT "JOHN SMITH" (score 88, no DOB available) → confirmed (conservative)
  │
  ├── Hit 1 → sanctions_hit fragment (pending_review)
  ├── Hit 2 → sanctions_dismissed fragment (auto_approved)
  └── Hit 3 → sanctions_hit fragment (pending_review)
```

### Verdict Rules

| Scenario | Expected Verdict | Status |
|----------|-----------------|--------|
| High score + DOB match | Confirmed | `pending_review` |
| High score + no DOB data | Confirmed (conservative) | `pending_review` |
| High score + DOB mismatch | Dismissed | `auto_approved` |
| Medium score + nationality mismatch | Dismissed | `auto_approved` |
| Individual matched against entity entry | Dismissed | `auto_approved` |
| Ambiguous / uncertain | Confirmed (conservative) | `pending_review` |

### ScreeningReport Output Shape

```javascript
{
  totalSubjects: 12,
  totalClear: 10,
  totalWithHits: 2,
  totalConfirmedHits: 1,
  totalDismissedHits: 3,
  overallRisk: 'critical',
  listsScreened: ['OFAC-SDN', 'UK-HMT'],
  subjects: [
    {
      id: 'uuid',
      name: 'John Smith',
      entityType: 'individual',
      roles: ['director'],
      screeningStatus: 'hits_confirmed',
      hits: [
        {
          source: 'OFAC-SDN',
          listEntryId: '12345',
          matchedName: 'JOHN A. SMITH',
          matchScore: 92,
          verdict: 'confirmed',
          reasoning: 'Name closely matches, DOB matches (1975-03), same nationality...',
          programs: ['SDGT'],
        },
        {
          source: 'OFAC-SDN',
          listEntryId: '67890',
          matchedName: 'JONATHAN SMITH',
          matchScore: 87,
          verdict: 'dismissed',
          reasoning: 'DOB on list is 1952-06, subject DOB is 1975-03 — clear mismatch.',
          dismissalReason: 'dob_mismatch',
          programs: ['IRAN'],
        },
      ],
    },
    {
      id: 'uuid',
      name: 'Acme Holdings Ltd',
      entityType: 'entity',
      roles: ['subject-entity'],
      screeningStatus: 'clear',
      hits: [],
    },
    // ...
  ],
}
```

## Acceptance Criteria

- [ ] Step `evaluate_sanctions_hits`: LLM evaluates each potential hit with structured output
- [ ] LLM produces: verdict (confirmed/dismissed), reasoning, dismissalReason, confidenceInVerdict
- [ ] Confirmed hits → `sanctions_hit` fragment with `pending_review` status
- [ ] Dismissed hits → `sanctions_dismissed` fragment with `auto_approved` status and dismissal reason
- [ ] Conservative approach: ambiguous cases confirmed for human review
- [ ] Prompt instructs LLM to be conservative (false negative worse than false positive)
- [ ] Step `compile_screening_report` assembles complete `ScreeningReport`
- [ ] Report includes per-subject breakdown with screening status
- [ ] Report includes overall risk: `clear`, `low` (all dismissed), `critical` (confirmed hits)
- [ ] Report lists all lists screened
- [ ] Prompt handles: partial DOB, missing nationality, multiple hits on same list
- [ ] LLM task type: `screening`, temperature: 0.1
- [ ] No hits to evaluate → step completes with empty fragments

## Dependencies

- **Depends on**: #32 (Sanctions screening results), #8 (LLM service), #22 (Decision fragments)
- **Blocks**: #56-#58 (Risk Assessment Agent — uses ScreeningReport)

## Testing Strategy

1. **Confirmed hit**: Subject matches SDN entry with DOB match → verify `sanctions_hit` fragment with `pending_review`
2. **Dismissed hit — DOB mismatch**: Subject DOB ≠ list DOB → verify `sanctions_dismissed` with `dob_mismatch`
3. **Dismissed hit — nationality mismatch**: Clear nationality difference → verify `sanctions_dismissed`
4. **Dismissed hit — entity type mismatch**: Individual matched against entity entry → verify dismissed
5. **Conservative — ambiguous**: High score but no DOB available → verify confirmed (not dismissed)
6. **Multiple hits same subject**: Subject has 3 hits → verify all 3 evaluated individually
7. **No hits**: No subjects with hits → verify step completes with 0 fragments
8. **Report — all clear**: All subjects clear → verify `overallRisk: 'clear'`
9. **Report — all dismissed**: Hits found but all dismissed → verify `overallRisk: 'low'`
10. **Report — confirmed**: At least one confirmed → verify `overallRisk: 'critical'`
11. **Report — per-subject status**: Verify each subject has correct `screeningStatus`
12. **Prompt content**: Verify prompt includes subject name, DOB, nationality, and all hit details
13. **LLM structured output**: Mock LLM returns evaluations, verify correct fragment creation
14. **LLM failure**: LLM throws error → verify step retried via BaseAgent retry logic
15. **Integration**: Screen known SDN entry ("NORIEGA, Manuel"), evaluate hit, verify confirmed
