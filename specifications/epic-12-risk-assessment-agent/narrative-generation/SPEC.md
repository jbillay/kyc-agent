# Risk Assessment Agent — Narrative Generation

> GitHub Issue: [#59](https://github.com/jbillay/kyc-agent/issues/59)
> Epic: Risk Assessment Agent (#56)
> Size: L (3-5 days) | Priority: Critical

## Context

After the Risk Assessment Agent calculates the final risk score and rating (Story #58), it generates a comprehensive risk narrative using the LLM. The narrative is the primary deliverable read by human reviewers — it must be professional, suitable for regulatory review, and traceable. Every claim in the narrative links to a supporting decision fragment via `[ref:fragment_id]` markers, which the frontend (Story #60) renders as clickable links.

The narrative is generated in step 5 (`generate_narrative`) of the Risk Assessment Agent's 6-step pipeline. It uses the `summarization` LLM task type and receives all prior agent outputs, risk factors, and decision fragments as context. Narrative length scales with risk level: low-risk cases get a concise summary (1-2 paragraphs), while high-risk cases get a detailed report (4-6 paragraphs).

## Requirements

### Functional

1. Step `generate_narrative` in `RiskAssessmentAgent` (step 5 of 6):
   - Assembles a prompt containing: entity summary, ownership structure, screening findings, document verification status, risk factors from rule engine and LLM, final risk score and rating, all decision fragment IDs with their types and decisions
   - Sends to LLM with `summarization` task type
   - LLM produces a structured narrative with the following sections:
     - **Entity Overview**: company name, jurisdiction, incorporation date, business activity, registration details
     - **Ownership Structure**: ownership chain description, UBO identification, complexity assessment
     - **Screening Findings**: sanctions check results, PEP check results, adverse media summary
     - **Document Verification**: documents reviewed, verification status, any discrepancies
     - **Risk Factors**: identified risk factors with explanations
     - **Risk Assessment**: overall rating with justification, score breakdown by category
     - **Recommendation**: recommended due diligence level, specific areas requiring attention
   - Every factual claim includes a `[ref:fragment_id]` marker pointing to the supporting decision fragment
   - Narrative tone: professional, objective, suitable for regulatory submission
2. Narrative length is proportional to risk level:
   - low: concise (1-2 paragraphs, ~200-400 words)
   - medium: moderate (2-3 paragraphs, ~400-600 words)
   - high / very_high: detailed (4-6 paragraphs, ~600-1200 words)
3. Produces a `narrative_generated` decision fragment containing: a summary of the narrative, the full narrative text reference, and the fragment IDs referenced within
4. The narrative text is stored as part of the `RiskAssessment` output in `agent_results.output.narrative`

### Non-Functional

- LLM narrative generation call completes within configured LLM timeout
- If narrative generation fails, the agent still completes — the `narrative` field is set to null and a warning is logged (the risk score and review path are already determined)
- Narrative is returned as plain text with `[ref:uuid]` markers (not HTML or Markdown) — the frontend handles formatting
- Fragment references must use actual fragment IDs from the database (not fabricated IDs)

## Technical Design

### File: `backend/src/agents/risk-assessment/narrative-generator.js`

```javascript
const { prompts } = require('./prompts');

/**
 * @typedef {Object} NarrativeResult
 * @property {string} narrative - Generated narrative text with [ref:id] markers
 * @property {string[]} referencedFragments - Fragment IDs referenced in narrative
 * @property {Object} llmCall - LLM call metadata for audit
 */

/**
 * Generate a risk assessment narrative using LLM.
 *
 * @param {import('./risk-input-collector').RiskInputs} inputs
 * @param {import('./rule-engine').RuleResult} ruleResults
 * @param {import('./risk-calculator').FinalRisk} finalRisk
 * @param {import('./llm-risk-analyzer').LLMRiskAnalysis} llmAnalysis
 * @param {import('../../llm/llm-service').LLMService} llmService
 * @returns {Promise<NarrativeResult>}
 */
async function generateNarrative(inputs, ruleResults, finalRisk, llmAnalysis, llmService) {
  const fragmentMap = _buildFragmentMap(inputs.fragments);
  const lengthGuidance = _getLengthGuidance(finalRisk.rating);

  const response = await llmService.complete({
    taskType: 'summarization',
    messages: [
      { role: 'system', content: prompts.generateNarrative(lengthGuidance) },
      { role: 'user', content: _buildNarrativeContext(inputs, ruleResults, finalRisk, llmAnalysis, fragmentMap) },
    ],
  });

  const narrative = response.content;
  const referencedFragments = _extractFragmentReferences(narrative);

  // Validate referenced fragments exist
  const validRefs = referencedFragments.filter((id) => fragmentMap.has(id));
  if (validRefs.length < referencedFragments.length) {
    console.warn(
      `Narrative references ${referencedFragments.length - validRefs.length} non-existent fragment IDs — these may be LLM hallucinations`
    );
  }

  return {
    narrative,
    referencedFragments: validRefs,
    llmCall: {
      taskType: 'summarization',
      model: response.model,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      durationMs: response.durationMs,
    },
  };
}

/**
 * Build a map of fragment ID → fragment for reference validation.
 * @param {Object[]} fragments
 * @returns {Map<string, Object>}
 */
function _buildFragmentMap(fragments) {
  const map = new Map();
  for (const f of fragments) {
    map.set(f.id, f);
  }
  return map;
}

/**
 * Get length guidance string based on risk rating.
 * @param {string} rating
 * @returns {string}
 */
function _getLengthGuidance(rating) {
  switch (rating) {
    case 'low':
      return 'Keep the narrative concise: 1-2 paragraphs, approximately 200-400 words. Focus on confirming the low-risk status.';
    case 'medium':
      return 'Write a moderate narrative: 2-3 paragraphs, approximately 400-600 words. Highlight the factors that elevated risk above low.';
    case 'high':
    case 'very_high':
      return 'Write a detailed narrative: 4-6 paragraphs, approximately 600-1200 words. Thoroughly explain each risk factor and its implications.';
    default:
      return 'Write a moderate narrative: 2-3 paragraphs.';
  }
}

/**
 * Build context string for narrative generation.
 *
 * @param {Object} inputs
 * @param {Object} ruleResults
 * @param {Object} finalRisk
 * @param {Object} llmAnalysis
 * @param {Map<string, Object>} fragmentMap
 * @returns {string}
 */
function _buildNarrativeContext(inputs, ruleResults, finalRisk, llmAnalysis, fragmentMap) {
  const sections = [];

  // Risk assessment summary
  sections.push('## Risk Assessment Summary');
  sections.push(`Final Score: ${finalRisk.score}/100`);
  sections.push(`Rating: ${finalRisk.rating}`);
  sections.push(`Recommended Due Diligence: ${finalRisk.ddLevel}`);
  sections.push(`Confidence: ${finalRisk.confidence}%`);
  sections.push(`Score Breakdown: ${JSON.stringify(finalRisk.scoreBreakdown)}`);

  // Risk factors from rule engine
  sections.push('\n## Rule Engine Risk Factors');
  for (const factor of ruleResults.factors) {
    sections.push(`- [${factor.category}] ${factor.description} (+${factor.scoreAddition})`);
  }

  // LLM additional factors
  if (llmAnalysis.additionalFactors.length > 0) {
    sections.push('\n## Additional Qualitative Factors');
    for (const factor of llmAnalysis.additionalFactors) {
      sections.push(`- [${factor.impact}/${factor.severity}] ${factor.description}: ${factor.reasoning}`);
    }
  }

  // Entity profile
  if (inputs.entityProfile) {
    sections.push('\n## Entity Profile');
    sections.push(JSON.stringify(inputs.entityProfile, null, 2));
  }

  // Ownership
  if (inputs.ownershipData) {
    sections.push('\n## Ownership Structure');
    sections.push(JSON.stringify(inputs.ownershipData, null, 2));
  }

  // Screening
  if (inputs.screeningResults) {
    sections.push('\n## Screening Results');
    sections.push(JSON.stringify(inputs.screeningResults, null, 2));
  }

  // Documents
  if (inputs.documentAnalysis) {
    sections.push('\n## Document Analysis');
    sections.push(JSON.stringify(inputs.documentAnalysis, null, 2));
  }

  // Available fragment IDs for referencing
  sections.push('\n## Decision Fragments (use [ref:ID] to reference)');
  for (const [id, fragment] of fragmentMap) {
    sections.push(`- ${id}: [${fragment.type}] ${fragment.decision}`);
  }

  return sections.join('\n');
}

/**
 * Extract [ref:fragment_id] references from narrative text.
 * @param {string} narrative
 * @returns {string[]} Array of fragment IDs
 */
function _extractFragmentReferences(narrative) {
  const matches = narrative.match(/\[ref:([a-f0-9-]+)\]/g) || [];
  return matches.map((m) => m.replace('[ref:', '').replace(']', ''));
}

module.exports = {
  generateNarrative,
  _buildFragmentMap,
  _getLengthGuidance,
  _buildNarrativeContext,
  _extractFragmentReferences,
};
```

### Integration in `RiskAssessmentAgent.index.js` (Step 5)

```javascript
// ─── Step 5: Generate Narrative ──────────

async _generateNarrative(context) {
  try {
    const result = await generateNarrative(
      this._riskInputs,
      this._ruleResults,
      this._finalRisk,
      this._llmAnalysis,
      this.llmService
    );

    this._narrative = result.narrative;

    return {
      description: `Generated risk narrative (${result.narrative.length} chars, ${result.referencedFragments.length} fragment references)`,
      decisionFragments: [{
        type: FragmentType.NARRATIVE_GENERATED,
        decision: `Risk narrative generated for ${this._finalRisk.rating} case (${result.referencedFragments.length} evidence references)`,
        confidence: this._finalRisk.confidence,
        evidence: {
          dataSources: ['llm_summarization'],
          dataPoints: [
            { source: 'narrative', field: 'length', value: String(result.narrative.length), fetchedAt: new Date().toISOString() },
            { source: 'narrative', field: 'referenced_fragments', value: String(result.referencedFragments.length), fetchedAt: new Date().toISOString() },
          ],
        },
        status: 'pending_review',
      }],
      llmCalls: [result.llmCall],
    };
  } catch (err) {
    // Graceful degradation: narrative is not critical for scoring
    console.warn('Narrative generation failed:', err.message);
    this._narrative = null;

    return {
      description: 'Narrative generation failed — continuing without narrative',
      decisionFragments: [],
      llmCalls: [],
    };
  }
}
```

### Prompt Addition in `prompts.js`

```javascript
/**
 * Prompt for risk narrative generation.
 * @param {string} lengthGuidance - How long the narrative should be
 * @returns {string}
 */
generateNarrative(lengthGuidance) {
  return `You are a senior KYC compliance officer writing a risk assessment narrative. This narrative will be submitted as part of a regulatory review, so it must be professional, objective, and evidence-based.

Write a risk assessment narrative covering:
1. **Entity Overview** — company identity, jurisdiction, business activity
2. **Ownership Structure** — ownership chain, UBOs, complexity
3. **Screening Findings** — sanctions, PEP, adverse media results
4. **Document Verification** — documents reviewed, verification status, discrepancies
5. **Risk Factors** — each identified factor with explanation
6. **Risk Assessment** — overall rating, score breakdown, justification
7. **Recommendation** — due diligence level, areas requiring attention

${lengthGuidance}

IMPORTANT RULES:
- Every factual claim MUST reference a decision fragment using [ref:FRAGMENT_ID] format
- Use the exact fragment IDs provided in the "Decision Fragments" section
- Do NOT fabricate or guess fragment IDs — only use IDs from the list provided
- If a claim cannot be linked to a fragment, state it as a general observation
- Tone: professional, objective, suitable for regulatory submission
- Do not speculate beyond the evidence — state what is known and what requires further investigation
- Use plain text only — no Markdown headers, bold, or formatting. The frontend handles presentation`;
},
```

### Example Narrative Output

```
This risk assessment covers Example Corp Ltd (Company No. 12345678), incorporated in the United Kingdom on 22 March 2015 [ref:frag-001]. The company is registered for software development activities (SIC 62020) at 123 Business Park, London [ref:frag-001].

Ownership analysis identified a two-layer structure with one Ultimate Beneficial Owner, John Doe, holding 75% of shares [ref:frag-012]. The structure is straightforward with no cross-border elements or nominee arrangements [ref:frag-013].

Sanctions screening against OFAC SDN and UK HMT lists returned no confirmed matches [ref:frag-020]. No Politically Exposed Persons were identified among the UBOs or directors [ref:frag-021]. One low-severity adverse media item was identified relating to a minor regulatory notice in 2023 [ref:frag-025].

The submitted Certificate of Incorporation was verified against Companies House records with no discrepancies [ref:frag-030].

The rule engine assessed a total risk score of 18/100, with minor contributions from the adverse media finding (3 points). No additional qualitative risk factors were identified by the extended analysis.

Overall risk rating: low (18/100). Recommended due diligence level: simplified. This case is suitable for automated QA review given the low risk score and high confidence level (85%) of the underlying assessments.
```

## Acceptance Criteria

- [ ] Step `generate_narrative` sends all case data and fragments to LLM with `summarization` task type
- [ ] Narrative covers all 7 sections: entity overview, ownership, screening, documents, risk factors, assessment, recommendation
- [ ] Every factual claim includes a `[ref:fragment_id]` marker
- [ ] Referenced fragment IDs are validated against actual fragment IDs in database
- [ ] Non-existent fragment references logged as warnings
- [ ] Narrative length scales with risk level: low (~200-400 words), medium (~400-600), high/very_high (~600-1200)
- [ ] Narrative tone is professional and suitable for regulatory review
- [ ] `narrative_generated` decision fragment produced with reference count
- [ ] Narrative stored in `agent_results.output.narrative`
- [ ] LLM failure degrades gracefully — narrative set to null, agent continues
- [ ] LLM call recorded for audit trail

## Dependencies

- **Depends on**: #58 (Rule engine + LLM analysis — provides `_riskInputs`, `_ruleResults`, `_finalRisk`, `_llmAnalysis`), #8 (LLM Service — summarization task type), #22 (Decision Fragments — `narrative_generated` type)
- **Blocks**: #60 (Frontend — needs narrative text with `[ref:id]` markers for display)

## Testing Strategy

1. **Low-risk narrative**: low rating case → concise narrative (~200-400 words), confirms low risk
2. **High-risk narrative**: very_high rating case with sanctions hit → detailed narrative (~600-1200 words), explains all risk factors
3. **Fragment references**: Narrative contains `[ref:id]` markers → all referenced IDs exist in the fragment map
4. **Fragment reference extraction**: Text with `[ref:abc-123]` markers → `_extractFragmentReferences` returns `['abc-123']`
5. **Invalid fragment references**: LLM generates non-existent ID → warning logged, ID excluded from validRefs
6. **Length guidance — low**: `_getLengthGuidance('low')` → mentions "1-2 paragraphs"
7. **Length guidance — high**: `_getLengthGuidance('high')` → mentions "4-6 paragraphs"
8. **Narrative context building**: All inputs present → context string includes all 7 sections + fragment ID list
9. **Partial inputs**: Missing document analysis → context omits document section, narrative covers available data
10. **LLM failure**: LLM throws error → narrative set to null, agent step returns without fragments, warning logged
11. **Fragment map building**: 5 fragments → map has 5 entries keyed by ID
12. **LLM call audit**: Successful generation → llmCall includes model, tokens, duration
