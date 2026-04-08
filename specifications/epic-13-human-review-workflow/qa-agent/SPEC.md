# QA Agent for Automated Low-Risk Case Review

> GitHub Issue: [#63](https://github.com/jbillay/kyc-agent/issues/63)
> Epic: Human Review Workflow (#61)
> Size: L (3-5 days) | Priority: High

## Context

Low-risk, high-confidence cases represent the bulk of KYC volume for most institutions. Having a human reviewer manually verify every field and fragment for cases the agents are confident about is wasteful. The QA Agent acts as an automated quality gate: it verifies completeness, checks internal consistency across agent outputs, confirms regulatory compliance for the assigned due diligence level, and produces a summary of findings.

The QA Agent is only triggered for cases where risk score <= 25 AND agent confidence >= 85 (thresholds from `config/risk-rules.yaml` `review_routing.low_risk_high_confidence`). If QA passes, the case routes to a streamlined human review (simplified UI with just confirm/reject). If QA fails, it routes to standard human review with the QA issues highlighted so the reviewer knows exactly what to investigate.

The QA Agent never auto-approves a case — it only pre-validates for faster human review.

## Requirements

### Functional

1. `QAAgent` extends `BaseAgent` with 4 sequential steps
2. Step `completeness_check`: verify all required data is present
   - Entity identified and resolved to a registry record
   - All UBOs identified (or explicitly flagged as unresolvable)
   - All persons and entities screened against sanctions/PEP lists
   - Risk score calculated and narrative generated
   - Document analysis complete (if documents were uploaded)
3. Step `consistency_check`: cross-validate agent outputs
   - UBOs match between ownership agent and screening agent (everyone discovered was screened)
   - Risk score aligns with underlying findings (e.g., no sanctions hits with low risk score)
   - No contradictions between agents (e.g., entity status active vs. dissolved discrepancy)
   - Screening covered all names, aliases, and UBOs
4. Step `rule_compliance_check`: verify regulatory compliance for the DD level
   - Simplified DD: minimum data points present for low-risk cases
   - Standard DD: full CDD requirements met
   - Enhanced DD: additional checks completed (source of wealth, senior management approval)
5. Step `generate_qa_summary`: produce summary of QA findings
6. Only triggered when risk score <= 25 AND confidence >= 85
7. QA pass → streamlined human review; QA fail → standard review with issues highlighted

### Non-Functional

- QA Agent completes within 30 seconds (primarily LLM call for consistency check)
- No external API calls — works entirely on existing agent outputs
- Fail-safe: if QA Agent errors, case routes to standard human review (never blocks the pipeline)

## Technical Design

### File: `backend/src/agents/qa/index.js`

```javascript
const BaseAgent = require('../base-agent');

/**
 * QA Agent — automated quality assurance for low-risk, high-confidence cases.
 *
 * Only triggered by the orchestrator when:
 *   risk_score <= 25 AND confidence >= 85
 * (thresholds from config/risk-rules.yaml review_routing.low_risk_high_confidence)
 *
 * Steps:
 *   1. completeness_check — verify all required data is present
 *   2. consistency_check — cross-validate agent outputs (uses LLM)
 *   3. rule_compliance_check — verify regulatory requirements met
 *   4. generate_qa_summary — produce QA findings summary
 *
 * Output: QAReport { status: 'passed'|'failed', issues: string[], summary: string }
 */
class QAAgent extends BaseAgent {
  constructor(deps) {
    super({
      agentType: 'qa-agent',
      steps: [
        'completeness_check',
        'consistency_check',
        'rule_compliance_check',
        'generate_qa_summary',
      ],
      ...deps,
    });
  }

  /**
   * Step 1: Verify all required data points are present.
   *
   * Checks that all upstream agents produced results and that
   * key fields are populated.
   *
   * @param {import('../base-agent').AgentContext} context
   * @returns {Promise<{ complete: boolean, missingItems: string[] }>}
   */
  async completeness_check(context) {
    const { existingData } = context;
    const missingItems = [];

    // Entity resolution must have produced a resolved entity
    const entityResult = existingData['entity-resolution'];
    if (!entityResult || entityResult.status !== 'completed') {
      missingItems.push('Entity resolution did not complete');
    } else if (!entityResult.output?.resolvedEntity) {
      missingItems.push('No resolved entity in entity resolution output');
    }

    // Ownership agent must have identified UBOs (or flagged inability)
    const ownershipResult = existingData['ownership-ubo'];
    if (!ownershipResult || ownershipResult.status !== 'completed') {
      missingItems.push('Ownership/UBO analysis did not complete');
    } else if (!ownershipResult.output?.ubos && !ownershipResult.output?.uboUnresolvable) {
      missingItems.push('No UBO identification or unresolvable flag');
    }

    // Screening must have completed
    const screeningResult = existingData['screening'];
    if (!screeningResult || screeningResult.status !== 'completed') {
      missingItems.push('Screening did not complete');
    }

    // Risk assessment must have score + narrative
    const riskResult = existingData['risk-assessment'];
    if (!riskResult || riskResult.status !== 'completed') {
      missingItems.push('Risk assessment did not complete');
    } else {
      if (riskResult.output?.riskScore == null) missingItems.push('No risk score calculated');
      if (!riskResult.output?.narrative) missingItems.push('No risk narrative generated');
    }

    const complete = missingItems.length === 0;

    this.addDecisionFragment({
      type: 'qa_completeness',
      decision: complete ? 'All required data present' : `Missing: ${missingItems.join('; ')}`,
      confidence: 100,
      evidence: { missingItems },
    });

    return { complete, missingItems };
  }

  /**
   * Step 2: Cross-validate agent outputs for internal consistency.
   *
   * Uses LLM (reasoning task type) to detect contradictions
   * and inconsistencies between agents.
   *
   * @param {import('../base-agent').AgentContext} context
   * @returns {Promise<{ consistent: boolean, inconsistencies: string[] }>}
   */
  async consistency_check(context) {
    const { existingData } = context;
    const inconsistencies = [];

    // Check: all UBOs were screened
    const ubos = existingData['ownership-ubo']?.output?.ubos || [];
    const screenedNames = existingData['screening']?.output?.screenedNames || [];
    for (const ubo of ubos) {
      const uboName = ubo.name?.toLowerCase();
      const wasScreened = screenedNames.some(
        (n) => n.toLowerCase() === uboName
      );
      if (!wasScreened) {
        inconsistencies.push(`UBO "${ubo.name}" was not screened`);
      }
    }

    // Check: no sanctions hits with low risk score
    const screeningHits = existingData['screening']?.output?.confirmedHits || [];
    const riskScore = existingData['risk-assessment']?.output?.riskScore;
    if (screeningHits.length > 0 && riskScore < 76) {
      inconsistencies.push(
        `Confirmed screening hit(s) present but risk score is ${riskScore} (expected >= 76)`
      );
    }

    // LLM-based deeper consistency check
    const llmResult = await this.llmService.complete({
      taskType: 'reasoning',
      messages: [
        {
          role: 'system',
          content: `You are a KYC quality assurance analyst. Review the following agent outputs for contradictions or inconsistencies. Return a JSON array of issues found, or an empty array if consistent.`,
        },
        {
          role: 'user',
          content: JSON.stringify({
            entityResolution: existingData['entity-resolution']?.output,
            ownership: existingData['ownership-ubo']?.output,
            screening: existingData['screening']?.output,
            riskAssessment: {
              riskScore: existingData['risk-assessment']?.output?.riskScore,
              riskRating: existingData['risk-assessment']?.output?.riskRating,
              riskFactors: existingData['risk-assessment']?.output?.riskFactors,
            },
          }),
        },
      ],
      structuredOutput: {
        schema: {
          type: 'object',
          properties: {
            issues: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['issues'],
        },
        strict: true,
      },
    });

    if (llmResult.structured?.issues) {
      inconsistencies.push(...llmResult.structured.issues);
    }

    const consistent = inconsistencies.length === 0;

    this.addDecisionFragment({
      type: 'qa_consistency',
      decision: consistent ? 'Agent outputs are internally consistent' : `Inconsistencies found: ${inconsistencies.length}`,
      confidence: consistent ? 95 : 70,
      evidence: { inconsistencies },
    });

    return { consistent, inconsistencies };
  }

  /**
   * Step 3: Verify case meets minimum regulatory requirements for the assigned DD level.
   *
   * @param {import('../base-agent').AgentContext} context
   * @returns {Promise<{ compliant: boolean, violations: string[] }>}
   */
  async rule_compliance_check(context) {
    const { existingData, config } = context;
    const ddLevel = existingData['risk-assessment']?.output?.recommendedDDLevel || 'standard';
    const violations = [];

    // Simplified DD requirements
    if (ddLevel === 'simplified') {
      if (!existingData['entity-resolution']?.output?.resolvedEntity) {
        violations.push('Simplified DD requires entity identification');
      }
      if (!existingData['screening']?.output) {
        violations.push('Simplified DD requires basic sanctions screening');
      }
    }

    // Standard DD requirements
    if (ddLevel === 'standard') {
      if (!existingData['ownership-ubo']?.output?.ubos?.length) {
        violations.push('Standard DD requires UBO identification');
      }
      if (!existingData['screening']?.output?.pepScreeningComplete) {
        violations.push('Standard DD requires PEP screening');
      }
    }

    // Enhanced DD requirements
    if (ddLevel === 'enhanced') {
      if (!existingData['ownership-ubo']?.output?.sourceOfWealth) {
        violations.push('Enhanced DD requires source of wealth analysis');
      }
      // Additional EDD checks can be added via config
    }

    const compliant = violations.length === 0;

    this.addDecisionFragment({
      type: 'qa_compliance',
      decision: compliant
        ? `Case meets ${ddLevel} DD requirements`
        : `${ddLevel} DD violations: ${violations.join('; ')}`,
      confidence: 100,
      evidence: { ddLevel, violations },
    });

    return { compliant, violations };
  }

  /**
   * Step 4: Generate QA summary with overall pass/fail and issues list.
   *
   * @param {import('../base-agent').AgentContext} context
   * @param {Object} stepResults - Results from previous steps
   * @returns {Promise<QAReport>}
   */
  async generate_qa_summary(context, stepResults) {
    const { completeness_check, consistency_check, rule_compliance_check } = stepResults;

    const allIssues = [
      ...completeness_check.missingItems.map((i) => `[Completeness] ${i}`),
      ...consistency_check.inconsistencies.map((i) => `[Consistency] ${i}`),
      ...rule_compliance_check.violations.map((i) => `[Compliance] ${i}`),
    ];

    const passed = allIssues.length === 0;

    const summary = passed
      ? 'QA passed. All required data present, agent outputs are internally consistent, and regulatory requirements are met for the assigned due diligence level.'
      : `QA failed with ${allIssues.length} issue(s). Human reviewer should investigate the flagged items.`;

    /** @type {QAReport} */
    const qaReport = {
      status: passed ? 'passed' : 'failed',
      issues: allIssues,
      summary,
      checks: {
        completeness: completeness_check.complete,
        consistency: consistency_check.consistent,
        compliance: rule_compliance_check.compliant,
      },
    };

    this.addDecisionFragment({
      type: 'qa_summary',
      decision: summary,
      confidence: passed ? 95 : 80,
      evidence: qaReport,
    });

    return qaReport;
  }
}

/**
 * @typedef {Object} QAReport
 * @property {'passed'|'failed'} status
 * @property {string[]} issues - All issues found across checks
 * @property {string} summary - Human-readable summary
 * @property {Object} checks
 * @property {boolean} checks.completeness
 * @property {boolean} checks.consistency
 * @property {boolean} checks.compliance
 */

module.exports = { QAAgent };
```

### Orchestrator Integration

The orchestrator triggers the QA Agent conditionally based on the risk assessment output:

```javascript
// In orchestrator.js — after RISK_ASSESSMENT completes

const riskOutput = riskResult.output;
const qaThresholds = config.review_routing.low_risk_high_confidence;

if (
  riskOutput.riskScore <= qaThresholds.max_risk_score &&
  riskResult.confidence >= qaThresholds.min_confidence
) {
  // Eligible for QA — dispatch QA agent
  await this.dispatchAgent(caseId, 'qa-agent', context);
} else {
  // Skip QA — go directly to human review
  await this.transitionState(caseId, 'PENDING_HUMAN_REVIEW');
  await this.assignReviewer(caseId, riskOutput);
}
```

After QA completes:

```javascript
// QA passed → streamlined human review
// QA failed → standard human review with issues
await this.transitionState(caseId, 'PENDING_HUMAN_REVIEW');
await this.assignReviewer(caseId, riskOutput);
// QA report stored in agent_results for frontend to display
```

### Agent Steps

| # | Step | LLM Task | Data Sources | Decision Fragments |
|---|------|----------|-------------|-------------------|
| 1 | `completeness_check` | — | agent_results (all prior agents) | `qa_completeness` |
| 2 | `consistency_check` | reasoning | agent_results + decision_fragments | `qa_consistency` |
| 3 | `rule_compliance_check` | — | agent_results, risk-rules.yaml | `qa_compliance` |
| 4 | `generate_qa_summary` | — | Results from steps 1-3 | `qa_summary` |

### QA Report Output Shape

```json
{
  "status": "passed",
  "issues": [],
  "summary": "QA passed. All required data present, agent outputs are internally consistent, and regulatory requirements are met for the assigned due diligence level.",
  "checks": {
    "completeness": true,
    "consistency": true,
    "compliance": true
  }
}
```

Failed example:

```json
{
  "status": "failed",
  "issues": [
    "[Consistency] UBO \"John Smith\" was not screened",
    "[Compliance] Standard DD requires PEP screening"
  ],
  "summary": "QA failed with 2 issue(s). Human reviewer should investigate the flagged items.",
  "checks": {
    "completeness": true,
    "consistency": false,
    "compliance": false
  }
}
```

## Acceptance Criteria

- [ ] `QAAgent` extends `BaseAgent` with 4 steps
- [ ] Step `completeness_check` verifies: entity identified, UBOs identified, all persons screened, risk score calculated, narrative generated
- [ ] Step `consistency_check` cross-validates: UBOs match between ownership and screening, risk score aligns with findings, no contradictions
- [ ] Step `consistency_check` uses LLM (reasoning task type) for deeper analysis
- [ ] Step `rule_compliance_check` verifies minimum regulatory requirements for the assigned DD level
- [ ] Step `generate_qa_summary` produces QAReport with pass/fail status and issues list
- [ ] Only triggered for cases with risk score <= 25 AND confidence >= 85
- [ ] If QA passes → case goes to streamlined human review
- [ ] If QA fails → case goes to standard human review with QA issues highlighted
- [ ] If QA Agent errors → case falls back to standard human review (never blocks pipeline)
- [ ] Decision fragments: `qa_completeness`, `qa_consistency`, `qa_compliance`, `qa_summary`
- [ ] QAReport stored as JSONB in `agent_results` table
- [ ] QA completes within 30 seconds

## Dependencies

- **Depends on**: #21 (BaseAgent — extends), #22 (Decision fragments — qa_* types), #23 (Orchestrator — conditional dispatch + state transition), #25 (Event Store — step events), #8 (LLM Service — reasoning task for consistency check), #58 (Risk Assessment — riskScore, confidence, and review routing thresholds)
- **Blocks**: #64 (Review queue — displays QA status), #65 (Fragment review — displays QA fragments)

## Testing Strategy

1. **QA passes — all checks green**: Mock agent outputs with complete, consistent, compliant data. Verify QAReport status=passed, issues=[]
2. **Completeness fails — missing entity**: Remove entity-resolution output. Verify completeness_check returns missingItems
3. **Completeness fails — missing screening**: Remove screening output. Verify missing item flagged
4. **Consistency fails — unscreened UBO**: Add UBO not in screenedNames. Verify inconsistency detected
5. **Consistency fails — sanctions with low score**: Add confirmed hit with riskScore=20. Verify inconsistency detected
6. **LLM consistency check**: Mock LLM returning issues array. Verify issues added to inconsistencies
7. **Compliance fails — standard DD without UBOs**: Set ddLevel=standard but no UBOs. Verify violation
8. **Compliance fails — enhanced DD without source of wealth**: Set ddLevel=enhanced. Verify violation
9. **QA summary — aggregation**: Trigger failures in 2 checks. Verify summary aggregates all issues with category prefixes
10. **Not triggered — high risk**: Set riskScore=60. Verify orchestrator skips QA and goes directly to PENDING_HUMAN_REVIEW
11. **Not triggered — low confidence**: Set confidence=70. Verify QA skipped
12. **Error handling — QA agent crashes**: Force error in step. Verify case routes to standard human review
13. **Decision fragments**: After QA run, verify 4 fragments created (one per step)
14. **Agent result stored**: Verify QAReport stored in agent_results with agent_type='qa-agent'
