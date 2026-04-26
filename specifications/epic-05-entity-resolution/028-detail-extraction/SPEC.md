# Entity Resolution Agent — Detail Extraction and Validation

> GitHub Issue: [#28](https://github.com/jbillay/kyc-agent/issues/28)
> Epic: Entity Resolution Agent (#26)
> Size: L (3-5 days) | Priority: Critical

## Context

The second half of the Entity Resolution Agent. After the best match is selected (Story #27), this story covers extracting full entity details from the registry (company profile, officers, shareholders), assembling the `EntityProfile`, and using an LLM to validate the entity for red flags. The assembled profile is the primary input for all downstream agents.

## Requirements

### Functional

1. Step `extract_entity_details`: pulls registration number, registered address, SIC codes, status, previous names, filing history from Companies House
2. Step `extract_officers`: pulls all current directors and officers with roles, appointment dates, nationalities, DOB
3. Step `extract_shareholders`: pulls PSC register entries with ownership percentages, nature of control
4. Step `validate_entity`: LLM checks for red flags — is entity active? Accounts overdue? Strike-off notices? Entity type mismatch?
5. Decision fragments: `entity_detail_extracted`, `officer_identified`, `shareholder_identified`, and risk-relevant fragments from validation
6. Complete `EntityProfile` output assembled for downstream agents
7. All data source responses cached in `data_source_cache`

### Non-Functional

- All 4 steps complete in under 60 seconds (including LLM validation call)
- Data extraction steps can run with partial data (missing officers doesn't block shareholders)
- Validation prompt is model-agnostic

## Technical Design

### File: `backend/src/agents/entity-resolution/index.js` (continued from Story #27)

The following step implementations are added to the `EntityResolutionAgent` class:

```javascript
  // ─── Steps 4-7 (Detail Extraction & Validation) ────

  /**
   * Step 4: Extract full entity details from the registry.
   */
  async _extractEntityDetails(context) {
    if (!this._selectedMatch) {
      return {
        description: 'No entity selected — skipping detail extraction',
        decisionFragments: [],
        llmCalls: [],
      };
    }

    const provider = this.registryFactory.getProvider(context.jurisdiction);
    const entityId = this._selectedMatch.registrationNumber;

    const details = await provider.getEntityDetails(entityId);

    // Initialize the entity profile
    this._entityProfile = {
      registrationNumber: details.registrationNumber,
      name: details.name,
      jurisdiction: details.jurisdiction,
      incorporationDate: details.incorporationDate,
      entityType: details.entityType,
      status: details.status,
      registeredAddress: details.registeredAddress,
      sicCodes: details.sicCodes || [],
      previousNames: details.previousNames || [],
      officers: [],
      shareholders: [],
      recentFilings: [],
      statusDetail: null,
      validationFindings: [],
      matchConfidence: this._selectedMatch.confidence,
      matchReasoning: this._selectedMatch.reasoning,
      rawData: { entityDetails: details.rawData },
    };

    return {
      description: `Extracted details for "${details.name}" (${details.registrationNumber}) — ${details.status}, ${details.sicCodes?.length || 0} SIC codes`,
      decisionFragments: [{
        type: FragmentType.ENTITY_DETAIL_EXTRACTED,
        decision: `Extracted entity profile: ${details.name} (${details.registrationNumber}), status: ${details.status}, incorporated: ${details.incorporationDate}`,
        confidence: 95,
        evidence: {
          dataSources: [provider.name],
          dataPoints: [
            { source: provider.name, field: 'company_name', value: details.name, fetchedAt: new Date().toISOString() },
            { source: provider.name, field: 'status', value: details.status, fetchedAt: new Date().toISOString() },
            { source: provider.name, field: 'incorporation_date', value: details.incorporationDate, fetchedAt: new Date().toISOString() },
            { source: provider.name, field: 'registered_address', value: details.registeredAddress, fetchedAt: new Date().toISOString() },
            { source: provider.name, field: 'sic_codes', value: details.sicCodes, fetchedAt: new Date().toISOString() },
          ],
        },
        status: 'auto_approved',
      }],
      llmCalls: [],
    };
  }

  /**
   * Step 5: Extract officers (directors, secretaries).
   */
  async _extractOfficers(context) {
    if (!this._selectedMatch) {
      return { description: 'No entity selected — skipping officers', decisionFragments: [], llmCalls: [] };
    }

    const provider = this.registryFactory.getProvider(context.jurisdiction);
    const officers = await provider.getOfficers(this._selectedMatch.registrationNumber);

    this._entityProfile.officers = officers;
    this._entityProfile.rawData.officers = officers.map((o) => o.rawData);

    // Separate current and resigned officers
    const current = officers.filter((o) => !o.resignedDate);
    const resigned = officers.filter((o) => o.resignedDate);

    const fragments = current.map((officer) => ({
      type: FragmentType.OFFICER_IDENTIFIED,
      decision: `Identified ${officer.role}: ${officer.name} (appointed ${officer.appointedDate}${officer.nationality ? ', ' + officer.nationality : ''})`,
      confidence: 95,
      evidence: {
        dataSources: [provider.name],
        dataPoints: [
          { source: provider.name, field: 'officer_name', value: officer.name, fetchedAt: new Date().toISOString() },
          { source: provider.name, field: 'officer_role', value: officer.role, fetchedAt: new Date().toISOString() },
          { source: provider.name, field: 'appointed_date', value: officer.appointedDate, fetchedAt: new Date().toISOString() },
          { source: provider.name, field: 'nationality', value: officer.nationality, fetchedAt: new Date().toISOString() },
        ],
      },
      status: 'auto_approved',
    }));

    return {
      description: `Extracted ${current.length} current officers, ${resigned.length} resigned`,
      decisionFragments: fragments,
      llmCalls: [],
    };
  }

  /**
   * Step 6: Extract shareholders (PSC register).
   */
  async _extractShareholders(context) {
    if (!this._selectedMatch) {
      return { description: 'No entity selected — skipping shareholders', decisionFragments: [], llmCalls: [] };
    }

    const provider = this.registryFactory.getProvider(context.jurisdiction);
    const shareholders = await provider.getShareholders(this._selectedMatch.registrationNumber);

    this._entityProfile.shareholders = shareholders;
    this._entityProfile.rawData.shareholders = shareholders.map((s) => s.rawData);

    // Only produce fragments for current (non-ceased) PSCs
    const current = shareholders.filter((s) => !s.ceasedDate);

    const fragments = current.map((sh) => ({
      type: FragmentType.SHAREHOLDER_IDENTIFIED,
      decision: `Identified ${sh.type} shareholder: ${sh.name} (${sh.ownershipPercentage || 'unknown'}% ownership, ${sh.naturesOfControl?.length || 0} nature(s) of control)`,
      confidence: 95,
      evidence: {
        dataSources: [provider.name],
        dataPoints: [
          { source: provider.name, field: 'shareholder_name', value: sh.name, fetchedAt: new Date().toISOString() },
          { source: provider.name, field: 'shareholder_type', value: sh.type, fetchedAt: new Date().toISOString() },
          { source: provider.name, field: 'ownership_percentage', value: sh.ownershipPercentage, fetchedAt: new Date().toISOString() },
          { source: provider.name, field: 'natures_of_control', value: sh.naturesOfControl, fetchedAt: new Date().toISOString() },
        ],
      },
      status: 'auto_approved',
    }));

    return {
      description: `Extracted ${current.length} current shareholders (${current.filter((s) => s.type === 'individual').length} individuals, ${current.filter((s) => s.type === 'corporate').length} corporate)`,
      decisionFragments: fragments,
      llmCalls: [],
    };
  }

  /**
   * Step 7: LLM validates entity for red flags.
   */
  async _validateEntity(context) {
    if (!this._selectedMatch || !this._entityProfile) {
      return { description: 'No entity to validate', decisionFragments: [], llmCalls: [] };
    }

    const provider = this.registryFactory.getProvider(context.jurisdiction);
    const entityId = this._selectedMatch.registrationNumber;

    // Fetch additional status and filing data for validation
    const [entityStatus, filingHistory] = await Promise.all([
      provider.getEntityStatus(entityId),
      provider.getFilingHistory(entityId),
    ]);

    this._entityProfile.statusDetail = {
      status: entityStatus.status,
      accountsOverdue: entityStatus.accountsOverdue,
      annualReturnOverdue: entityStatus.annualReturnOverdue,
      activeNotices: entityStatus.activeNotices,
      dissolvedDate: entityStatus.dissolvedDate,
    };
    this._entityProfile.recentFilings = filingHistory;
    this._entityProfile.rawData.entityStatus = entityStatus.rawData;
    this._entityProfile.rawData.filingHistory = filingHistory.map((f) => f.rawData);

    // LLM validation
    const prompt = prompts.validateEntity({
      entityDetails: this._entityProfile,
      entityStatus,
      filingHistory,
      declaredEntityType: context.existingData?.declaredEntityType,
    });

    const response = await this.llmService.complete({
      messages: prompt.messages,
      taskType: 'reasoning',
      structuredOutput: {
        name: 'entity_validation',
        schema: {
          type: 'object',
          properties: {
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  finding: { type: 'string' },
                  severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                  recommendation: { type: 'string' },
                },
                required: ['finding', 'severity', 'recommendation'],
              },
            },
          },
          required: ['findings'],
        },
      },
      temperature: 0.1,
      callContext: {
        caseId: context.caseId,
        agentType: 'entity-resolution',
        stepName: 'validate_entity',
      },
    });

    const findings = response.structured?.findings || [];
    this._entityProfile.validationFindings = findings;

    // Convert each finding to a decision fragment
    const fragments = findings.map((finding) => ({
      type: FragmentType.RISK_FACTOR_IDENTIFIED,
      decision: finding.finding,
      confidence: finding.severity === 'high' ? 90 : finding.severity === 'medium' ? 75 : 60,
      evidence: {
        dataSources: [provider.name],
        dataPoints: [
          { source: provider.name, field: 'accounts_overdue', value: entityStatus.accountsOverdue, fetchedAt: new Date().toISOString() },
          { source: provider.name, field: 'annual_return_overdue', value: entityStatus.annualReturnOverdue, fetchedAt: new Date().toISOString() },
          { source: provider.name, field: 'active_notices', value: entityStatus.activeNotices, fetchedAt: new Date().toISOString() },
        ],
        llmReasoning: `${finding.finding} — Severity: ${finding.severity}. Recommendation: ${finding.recommendation}`,
      },
      status: finding.severity === 'high' ? 'pending_review' : 'auto_approved',
    }));

    // If no findings, produce a "clean" fragment
    if (fragments.length === 0) {
      fragments.push({
        type: FragmentType.ENTITY_DETAIL_EXTRACTED,
        decision: `Entity validation passed — no red flags identified for "${this._entityProfile.name}"`,
        confidence: 95,
        evidence: {
          dataSources: [provider.name],
          dataPoints: [],
          llmReasoning: 'No red flags found during entity validation.',
        },
        status: 'auto_approved',
      });
    }

    return {
      description: `Validation complete — ${findings.length} finding(s): ${findings.filter((f) => f.severity === 'high').length} high, ${findings.filter((f) => f.severity === 'medium').length} medium, ${findings.filter((f) => f.severity === 'low').length} low`,
      decisionFragments: fragments,
      llmCalls: [{ model: response.model, provider: response.provider, latencyMs: response.latencyMs }],
    };
  }
```

### EntityProfile Output Shape

The `EntityProfile` assembled by `compileOutput()` contains everything downstream agents need:

```javascript
{
  // Identity
  registrationNumber: '01026167',
  name: 'Barclays Bank PLC',
  jurisdiction: 'GB',
  incorporationDate: '1981-02-09',
  entityType: 'plc',
  status: 'active',

  // Address
  registeredAddress: {
    addressLine1: '1 Churchill Place',
    locality: 'London',
    postalCode: 'E14 5HP',
    country: 'United Kingdom',
  },

  // Classification
  sicCodes: ['64191'],
  previousNames: [{ name: 'Barclays Bank Limited', effectiveFrom: '1917', effectiveTo: '1985' }],

  // People → Screening Agent, Ownership Agent
  officers: [
    { name: 'John Smith', role: 'director', appointedDate: '2020-01-15', nationality: 'British' },
    // ...
  ],
  shareholders: [
    { name: 'Barclays PLC', type: 'corporate', ownershipPercentage: '75-100', naturesOfControl: [...] },
    // ...
  ],

  // Filings & Status → Risk Assessment
  recentFilings: [{ filingType: 'AA', description: 'Annual accounts', date: '2025-12-01' }],
  statusDetail: {
    status: 'active',
    accountsOverdue: false,
    annualReturnOverdue: false,
    activeNotices: [],
  },

  // Validation → Risk Assessment
  validationFindings: [],

  // Match metadata
  matchConfidence: 98,
  matchReasoning: 'Exact registration number match, active PLC...',

  // Audit
  rawData: { entityDetails: {...}, officers: [...], shareholders: [...], entityStatus: {...}, filingHistory: [...] },
}
```

### Data Flow to Downstream Agents

| Downstream Agent | Uses From EntityProfile |
|-----------------|------------------------|
| Ownership/UBO Agent | `shareholders` (starting point for ownership tracing), `officers` |
| Screening Agent | `officers` (names to screen), `shareholders` (names to screen), `name` (entity screening) |
| Risk Assessment Agent | `sicCodes` (industry risk), `statusDetail` (overdue flags), `validationFindings`, `matchConfidence` |
| Document Analysis Agent | `registeredAddress` (cross-reference), `name`, `registrationNumber` |

### Validation Red Flags

| Check | Severity | Example Fragment |
|-------|----------|-----------------|
| Entity dissolved/liquidation | High | "Entity is dissolved — cannot proceed with active KYC" |
| Accounts overdue > 1 year | High | "Annual accounts overdue by 2 years — potential dormant/abandoned entity" |
| Compulsory strike-off notice | High | "Active gazette notice for compulsory strike-off" |
| Confirmation statement overdue | Medium | "Confirmation statement overdue" |
| Entity type mismatch | Medium | "Client declared 'limited-company' but registry shows 'plc'" |
| Recently incorporated (< 1 year) | Low | "Entity incorporated less than 1 year ago" |
| No filings in last 2 years | Medium | "No filings recorded in the last 2 years" |

## Acceptance Criteria

- [ ] Step `extract_entity_details`: pulls full company profile, produces `entity_detail_extracted` fragment
- [ ] Step `extract_officers`: pulls all officers, produces `officer_identified` fragment per current officer
- [ ] Step `extract_shareholders`: pulls PSC register, produces `shareholder_identified` fragment per current PSC
- [ ] Step `validate_entity`: LLM evaluates red flags with structured output (findings with severity + recommendation)
- [ ] High-severity validation findings produce `pending_review` fragments
- [ ] Clean validation produces "no red flags" fragment
- [ ] Complete `EntityProfile` assembled with all fields
- [ ] All API responses flow through data cache
- [ ] Profile includes `rawData` with all original API responses
- [ ] `compileOutput()` returns the EntityProfile for downstream agents
- [ ] Steps handle missing selected match gracefully (skip with description)
- [ ] Entity status and filing history fetched in parallel for validation step

## Dependencies

- **Depends on**: #27 (Search & evaluation — provides selected match), #14 (RegistryProvider), #15 (Companies House), #16 (Data caching), #8 (LLM service)
- **Blocks**: #45-#46 (Ownership Agent — needs shareholders), #30-#33 (Screening Agent — needs officers/shareholders), #56-#58 (Risk Assessment — needs full profile)

## Testing Strategy

1. **Extract details**: Mock `getEntityDetails`, verify fragment created with correct data points
2. **Extract officers**: Mock `getOfficers` with 3 current + 1 resigned, verify 3 fragments (current only)
3. **Extract shareholders**: Mock `getShareholders` with 2 current + 1 ceased, verify 2 fragments
4. **Shareholder types**: Verify individual and corporate shareholders produce correctly typed fragments
5. **Validate — clean entity**: Mock active entity with no overdue, verify "no red flags" fragment
6. **Validate — overdue accounts**: Mock overdue accounts, verify high-severity fragment with `pending_review`
7. **Validate — dissolved**: Mock dissolved entity, verify high-severity fragment
8. **Validate — entity type mismatch**: Declare "limited-company", registry shows "plc", verify medium-severity fragment
9. **Validate — multiple findings**: Mock entity with overdue + notice, verify multiple fragments
10. **EntityProfile assembly**: Run all steps, verify `compileOutput()` returns complete profile
11. **No selected match**: Skip match selection, verify steps 4-7 gracefully return empty
12. **Data caching**: Verify all `getEntityDetails`, `getOfficers`, `getShareholders`, `getEntityStatus`, `getFilingHistory` calls go through cache
13. **Integration**: Fetch real data for Barclays (01026167), verify profile populated correctly
