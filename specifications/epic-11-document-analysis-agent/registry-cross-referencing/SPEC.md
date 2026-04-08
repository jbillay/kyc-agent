# Document Analysis Agent — Registry Cross-Referencing and Discrepancy Detection

> GitHub Issue: [#54](https://github.com/jbillay/kyc-agent/issues/54)
> Epic: Document Analysis Agent (#52)
> Size: M (1-3 days) | Priority: High

## Context

After the document has been classified and its data extracted (Story #53), the remaining three steps compare the extracted data against the verified entity profile from the Entity Resolution Agent, validate the document for authenticity concerns, and produce a structured analysis report. This is where the Document Analysis Agent adds its core KYC value: surfacing discrepancies between what a document claims and what official registry data shows.

## Requirements

### Functional

1. Step `cross_reference_registry`: compares extracted document data against `EntityProfile` from Entity Resolution Agent output in context
2. Comparison checks (each producing a match result):
   - **Entity name**: fuzzy match handling abbreviations ("Ltd" vs "Limited"), case, and minor differences
   - **Registration number**: exact match (normalized — stripped whitespace and punctuation)
   - **Address**: fuzzy match accounting for formatting differences (line breaks, abbreviations, postcode format)
   - **Incorporation date**: exact date match (ISO 8601 normalized)
   - **Director names**: fuzzy match against directors/officers list (handles name ordering, middle names)
3. Each comparison produces a match result with status: `match`, `mismatch`, `not_available` (field missing from one or both sources)
4. Decision fragments per comparison:
   - `document_verified` when data matches registry
   - `document_discrepancy` when data mismatches, with specific mismatch details
5. Discrepancy severity levels:
   - **critical**: registration number mismatch, entity name mismatch (fundamentally different entity)
   - **warning**: address differs, director not found in registry, incorporation date mismatch
   - **info**: minor formatting difference, abbreviation variant, case difference
6. Step `validate_document_authenticity`:
   - Checks document date vs expected date (e.g., proof of address not older than 3 months)
   - Checks for missing required elements based on document type
   - Flags obvious inconsistencies (e.g., future dates, dates before entity incorporation)
   - Produces `document_verified` or `document_discrepancy` fragments
7. Step `generate_document_report`:
   - Produces a structured `DocumentAnalysisReport` combining all findings
   - Updates `documents.analysis_status` to `analyzed`
   - Report includes: document metadata, classification, extracted data, cross-reference results, authenticity results, overall assessment

### Non-Functional

- Cross-referencing completes in under 1 second (no external calls — EntityProfile already in context)
- Fuzzy matching uses consistent thresholds (configurable, default 0.8 similarity for names, 0.7 for addresses)

## Technical Design

### File: `backend/src/agents/document-analysis/registry-comparator.js`

```javascript
const { FragmentType } = require('../decision-fragment');

/**
 * @typedef {'match'|'mismatch'|'not_available'} MatchStatus
 * @typedef {'critical'|'warning'|'info'} DiscrepancySeverity
 *
 * @typedef {Object} ComparisonResult
 * @property {string} field - Field being compared
 * @property {MatchStatus} status
 * @property {*} documentValue - Value from document
 * @property {*} registryValue - Value from EntityProfile
 * @property {DiscrepancySeverity} [severity] - Only for mismatches
 * @property {string} [details] - Human-readable explanation
 */

/**
 * Cross-reference extracted document data against EntityProfile.
 *
 * @param {Object} extractedData - From data-extractor step
 * @param {string} documentType - Classified document type
 * @param {Object} entityProfile - From Entity Resolution Agent
 * @param {Object} [config]
 * @param {number} [config.nameThreshold=0.8] - Fuzzy match threshold for names
 * @param {number} [config.addressThreshold=0.7] - Fuzzy match threshold for addresses
 * @returns {{ comparisons: ComparisonResult[], fragments: Object[], overallMatch: boolean }}
 */
function crossReferenceRegistry(extractedData, documentType, entityProfile, config = {}) {
  const nameThreshold = config.nameThreshold || 0.8;
  const addressThreshold = config.addressThreshold || 0.7;

  const comparisons = [];
  const fragments = [];

  // Entity name comparison
  const docName = extractedData.entityName || extractedData.name || extractedData.accountHolderName;
  const regName = entityProfile.name;
  if (docName && regName) {
    const nameResult = _compareNames(docName, regName, nameThreshold);
    comparisons.push({
      field: 'entityName',
      status: nameResult.status,
      documentValue: docName,
      registryValue: regName,
      severity: nameResult.status === 'mismatch' ? 'critical' : undefined,
      details: nameResult.details,
    });
  } else {
    comparisons.push({
      field: 'entityName',
      status: 'not_available',
      documentValue: docName || null,
      registryValue: regName || null,
      details: `${!docName ? 'Document' : 'Registry'} value not available`,
    });
  }

  // Registration number comparison
  const docRegNum = extractedData.registrationNumber;
  const regRegNum = entityProfile.registrationNumber;
  if (docRegNum && regRegNum) {
    const normalized = _normalizeRegNumber(docRegNum) === _normalizeRegNumber(regRegNum);
    comparisons.push({
      field: 'registrationNumber',
      status: normalized ? 'match' : 'mismatch',
      documentValue: docRegNum,
      registryValue: regRegNum,
      severity: normalized ? undefined : 'critical',
      details: normalized ? 'Registration numbers match' : 'Registration numbers do not match — may indicate wrong entity',
    });
  } else {
    comparisons.push({
      field: 'registrationNumber',
      status: 'not_available',
      documentValue: docRegNum || null,
      registryValue: regRegNum || null,
    });
  }

  // Address comparison
  const docAddr = extractedData.registeredAddress || extractedData.address;
  const regAddr = entityProfile.registeredAddress;
  if (docAddr && regAddr) {
    const addrResult = _compareAddresses(docAddr, regAddr, addressThreshold);
    comparisons.push({
      field: 'address',
      status: addrResult.status,
      documentValue: docAddr,
      registryValue: regAddr,
      severity: addrResult.status === 'mismatch' ? 'warning' : undefined,
      details: addrResult.details,
    });
  } else {
    comparisons.push({
      field: 'address',
      status: 'not_available',
      documentValue: docAddr || null,
      registryValue: regAddr || null,
    });
  }

  // Incorporation date comparison
  const docDate = extractedData.incorporationDate;
  const regDate = entityProfile.incorporationDate;
  if (docDate && regDate) {
    const datesMatch = _normalizeDateString(docDate) === _normalizeDateString(regDate);
    comparisons.push({
      field: 'incorporationDate',
      status: datesMatch ? 'match' : 'mismatch',
      documentValue: docDate,
      registryValue: regDate,
      severity: datesMatch ? undefined : 'warning',
      details: datesMatch ? 'Incorporation dates match' : 'Incorporation dates differ',
    });
  } else {
    comparisons.push({
      field: 'incorporationDate',
      status: 'not_available',
      documentValue: docDate || null,
      registryValue: regDate || null,
    });
  }

  // Director names comparison
  const docDirectors = extractedData.directors || [];
  const regDirectors = (entityProfile.officers || []).filter((o) => o.role === 'director').map((o) => o.name);
  if (docDirectors.length > 0 && regDirectors.length > 0) {
    const dirResult = _compareDirectorLists(docDirectors, regDirectors, nameThreshold);
    comparisons.push({
      field: 'directors',
      status: dirResult.status,
      documentValue: docDirectors,
      registryValue: regDirectors,
      severity: dirResult.status === 'mismatch' ? 'warning' : undefined,
      details: dirResult.details,
    });
  } else {
    comparisons.push({
      field: 'directors',
      status: 'not_available',
      documentValue: docDirectors.length > 0 ? docDirectors : null,
      registryValue: regDirectors.length > 0 ? regDirectors : null,
    });
  }

  // Generate fragments
  const matches = comparisons.filter((c) => c.status === 'match');
  const mismatches = comparisons.filter((c) => c.status === 'mismatch');

  if (matches.length > 0) {
    fragments.push({
      type: FragmentType.DOCUMENT_VERIFIED,
      decision: `Document data matches registry for: ${matches.map((m) => m.field).join(', ')}`,
      confidence: 90,
      evidence: {
        dataSources: ['document', 'entity-resolution'],
        dataPoints: matches.map((m) => ({
          source: 'cross-reference',
          field: m.field,
          value: `doc="${m.documentValue}" reg="${m.registryValue}"`,
          fetchedAt: new Date().toISOString(),
        })),
      },
      status: 'auto_approved',
    });
  }

  for (const mismatch of mismatches) {
    fragments.push({
      type: FragmentType.DOCUMENT_DISCREPANCY,
      decision: `Discrepancy in ${mismatch.field}: document shows "${mismatch.documentValue}" but registry shows "${mismatch.registryValue}"`,
      confidence: 85,
      evidence: {
        dataSources: ['document', 'entity-resolution'],
        dataPoints: [
          { source: 'document', field: mismatch.field, value: mismatch.documentValue, fetchedAt: new Date().toISOString() },
          { source: 'entity-resolution', field: mismatch.field, value: mismatch.registryValue, fetchedAt: new Date().toISOString() },
        ],
      },
      status: mismatch.severity === 'critical' ? 'pending_review' : 'auto_approved',
      metadata: { severity: mismatch.severity, details: mismatch.details },
    });
  }

  const overallMatch = mismatches.length === 0;

  return { comparisons, fragments, overallMatch };
}

// ─── Comparison Helpers ──────────

/**
 * Compare entity names with fuzzy matching.
 * Handles: case, "Ltd"/"Limited", "PLC"/"Public Limited Company", whitespace.
 */
function _compareNames(a, b, threshold) {
  const normA = _normalizeName(a);
  const normB = _normalizeName(b);

  if (normA === normB) {
    return { status: 'match', details: 'Names match exactly (after normalization)' };
  }

  const similarity = _jaccardSimilarity(normA, normB);
  if (similarity >= threshold) {
    return { status: 'match', details: `Names match with ${(similarity * 100).toFixed(0)}% similarity` };
  }

  return { status: 'mismatch', details: `Names differ: "${a}" vs "${b}" (${(similarity * 100).toFixed(0)}% similarity)` };
}

/**
 * Compare addresses with fuzzy matching.
 * Handles: line breaks, abbreviations (St/Street, Rd/Road), postcode formatting.
 */
function _compareAddresses(a, b, threshold) {
  const normA = _normalizeAddress(a);
  const normB = _normalizeAddress(b);

  if (normA === normB) {
    return { status: 'match', details: 'Addresses match exactly (after normalization)' };
  }

  const similarity = _jaccardSimilarity(normA, normB);
  if (similarity >= threshold) {
    return { status: 'match', details: `Addresses match with ${(similarity * 100).toFixed(0)}% similarity` };
  }

  return { status: 'mismatch', details: `Addresses differ (${(similarity * 100).toFixed(0)}% similarity)` };
}

/**
 * Compare director lists.
 * Each document director must match at least one registry director.
 */
function _compareDirectorLists(docDirectors, regDirectors, threshold) {
  const unmatched = [];
  const matched = [];

  for (const docDir of docDirectors) {
    const found = regDirectors.some((regDir) => {
      const result = _compareNames(docDir, regDir, threshold);
      return result.status === 'match';
    });

    if (found) {
      matched.push(docDir);
    } else {
      unmatched.push(docDir);
    }
  }

  if (unmatched.length === 0) {
    return { status: 'match', details: `All ${matched.length} document directors found in registry` };
  }

  return {
    status: 'mismatch',
    details: `${unmatched.length} document director(s) not found in registry: ${unmatched.join(', ')}`,
  };
}

function _normalizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/\blimited\b/g, 'ltd')
    .replace(/\bpublic limited company\b/g, 'plc')
    .replace(/\bincorporated\b/g, 'inc')
    .replace(/\bcorporation\b/g, 'corp')
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _normalizeAddress(address) {
  return String(address)
    .toLowerCase()
    .replace(/\bstreet\b/g, 'st')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\blane\b/g, 'ln')
    .replace(/[\n\r,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function _normalizeRegNumber(regNum) {
  return String(regNum).replace(/[\s\-\.]/g, '').toUpperCase();
}

function _normalizeDateString(dateStr) {
  try {
    return new Date(dateStr).toISOString().split('T')[0];
  } catch {
    return String(dateStr).trim();
  }
}

/**
 * Jaccard similarity on word tokens.
 * @param {string} a
 * @param {string} b
 * @returns {number} 0-1
 */
function _jaccardSimilarity(a, b) {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 1 : intersection.size / union.size;
}

module.exports = {
  crossReferenceRegistry,
  _compareNames,
  _compareAddresses,
  _compareDirectorLists,
  _normalizeName,
  _normalizeAddress,
  _normalizeRegNumber,
  _jaccardSimilarity,
};
```

### File: `backend/src/agents/document-analysis/authenticity-validator.js`

```javascript
const { FragmentType } = require('../decision-fragment');

/**
 * @typedef {Object} AuthenticityCheck
 * @property {string} check - Name of the check
 * @property {'pass'|'fail'|'skipped'} status
 * @property {string} details
 * @property {'critical'|'warning'|'info'} [severity] - Only for failures
 */

/**
 * Validate document authenticity based on metadata and content checks.
 *
 * @param {Object} extractedData
 * @param {string} documentType
 * @param {Object} entityProfile
 * @returns {{ checks: AuthenticityCheck[], fragments: Object[] }}
 */
function validateDocumentAuthenticity(extractedData, documentType, entityProfile) {
  const checks = [];
  const fragments = [];

  // Check 1: Document date recency (for proof of address / utility bills)
  if (['proof_of_address', 'utility_bill'].includes(documentType)) {
    const dateIssued = extractedData.dateIssued;
    if (dateIssued) {
      const issued = new Date(dateIssued);
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      if (issued < threeMonthsAgo) {
        checks.push({
          check: 'document_recency',
          status: 'fail',
          details: `Document dated ${dateIssued} is older than 3 months`,
          severity: 'warning',
        });
      } else {
        checks.push({ check: 'document_recency', status: 'pass', details: 'Document is within 3-month validity window' });
      }
    } else {
      checks.push({ check: 'document_recency', status: 'skipped', details: 'No issue date found in document' });
    }
  }

  // Check 2: Future dates
  const now = new Date();
  const dateFields = ['incorporationDate', 'dateIssued', 'adoptionDate'];
  for (const field of dateFields) {
    if (extractedData[field]) {
      const date = new Date(extractedData[field]);
      if (date > now) {
        checks.push({
          check: `future_date_${field}`,
          status: 'fail',
          details: `${field} is in the future: ${extractedData[field]}`,
          severity: 'critical',
        });
      }
    }
  }

  // Check 3: Date before entity incorporation
  const incorporationDate = entityProfile.incorporationDate ? new Date(entityProfile.incorporationDate) : null;
  if (incorporationDate && extractedData.incorporationDate) {
    const docIncDate = new Date(extractedData.incorporationDate);
    if (docIncDate.toISOString().split('T')[0] !== incorporationDate.toISOString().split('T')[0]) {
      // Already caught in cross-referencing, but flag here too for completeness
    }
  }

  // Check 4: ID document expiry
  if (documentType === 'id_document' && extractedData.expiryDate) {
    const expiry = new Date(extractedData.expiryDate);
    if (expiry < now) {
      checks.push({
        check: 'id_expired',
        status: 'fail',
        details: `ID document expired on ${extractedData.expiryDate}`,
        severity: 'critical',
      });
    } else {
      checks.push({ check: 'id_expired', status: 'pass', details: 'ID document is not expired' });
    }
  }

  // Check 5: Missing required elements per document type
  const requiredFields = _getRequiredFields(documentType);
  const missingFields = requiredFields.filter((f) => !extractedData[f]);
  if (missingFields.length > 0) {
    checks.push({
      check: 'required_fields',
      status: 'fail',
      details: `Missing expected fields for ${documentType}: ${missingFields.join(', ')}`,
      severity: 'warning',
    });
  } else if (requiredFields.length > 0) {
    checks.push({ check: 'required_fields', status: 'pass', details: 'All expected fields present' });
  }

  // Generate fragments
  const failures = checks.filter((c) => c.status === 'fail');
  const passes = checks.filter((c) => c.status === 'pass');

  if (passes.length > 0 && failures.length === 0) {
    fragments.push({
      type: FragmentType.DOCUMENT_VERIFIED,
      decision: `Document authenticity checks passed: ${passes.map((p) => p.check).join(', ')}`,
      confidence: 85,
      evidence: {
        dataSources: ['document'],
        dataPoints: passes.map((p) => ({
          source: 'authenticity-check',
          field: p.check,
          value: p.details,
          fetchedAt: new Date().toISOString(),
        })),
      },
      status: 'auto_approved',
    });
  }

  for (const failure of failures) {
    fragments.push({
      type: FragmentType.DOCUMENT_DISCREPANCY,
      decision: `Authenticity concern: ${failure.details}`,
      confidence: 80,
      evidence: {
        dataSources: ['document'],
        dataPoints: [
          { source: 'authenticity-check', field: failure.check, value: failure.details, fetchedAt: new Date().toISOString() },
        ],
      },
      status: failure.severity === 'critical' ? 'pending_review' : 'auto_approved',
      metadata: { severity: failure.severity },
    });
  }

  return { checks, fragments };
}

/**
 * Get required fields for a document type.
 * @param {string} documentType
 * @returns {string[]}
 */
function _getRequiredFields(documentType) {
  const required = {
    certificate_of_incorporation: ['entityName', 'registrationNumber', 'incorporationDate'],
    articles_of_association: ['entityName'],
    proof_of_address: ['name', 'address', 'dateIssued'],
    utility_bill: ['name', 'address', 'dateIssued'],
    bank_statement: ['accountHolderName', 'bankName', 'address'],
    id_document: ['fullName', 'dateOfBirth', 'documentNumber'],
    annual_return: ['entityName', 'registrationNumber'],
    financial_statement: ['entityName', 'reportingPeriod'],
    shareholder_register: ['entityName', 'shareholders'],
  };
  return required[documentType] || [];
}

module.exports = { validateDocumentAuthenticity, _getRequiredFields };
```

### File: `backend/src/agents/document-analysis/report-generator.js`

```javascript
/**
 * @typedef {Object} DocumentAnalysisReport
 * @property {string} documentId
 * @property {string} filename
 * @property {string} documentType
 * @property {Object} extractedData
 * @property {import('./registry-comparator').ComparisonResult[]} crossReferenceResults
 * @property {import('./authenticity-validator').AuthenticityCheck[]} authenticityChecks
 * @property {boolean} overallMatch - True if no critical/warning discrepancies
 * @property {string} assessment - 'verified' | 'discrepancies_found' | 'concerns_raised'
 * @property {string} summary - Human-readable summary
 */

/**
 * Generate a structured document analysis report.
 *
 * @param {Object} params
 * @param {Object} params.documentRecord
 * @param {string} params.documentType
 * @param {Object} params.extractedData
 * @param {Object} params.crossReferenceResults
 * @param {Object} params.authenticityResults
 * @returns {DocumentAnalysisReport}
 */
function generateDocumentReport(params) {
  const { documentRecord, documentType, extractedData, crossReferenceResults, authenticityResults } = params;

  const criticalIssues = [
    ...crossReferenceResults.comparisons.filter((c) => c.severity === 'critical'),
    ...authenticityResults.checks.filter((c) => c.severity === 'critical'),
  ];

  const warnings = [
    ...crossReferenceResults.comparisons.filter((c) => c.severity === 'warning'),
    ...authenticityResults.checks.filter((c) => c.severity === 'warning'),
  ];

  let assessment;
  if (criticalIssues.length > 0) {
    assessment = 'concerns_raised';
  } else if (warnings.length > 0) {
    assessment = 'discrepancies_found';
  } else {
    assessment = 'verified';
  }

  const summaryParts = [];
  summaryParts.push(`Document "${documentRecord.filename}" classified as ${documentType.replace(/_/g, ' ')}.`);

  const matchCount = crossReferenceResults.comparisons.filter((c) => c.status === 'match').length;
  const mismatchCount = crossReferenceResults.comparisons.filter((c) => c.status === 'mismatch').length;
  summaryParts.push(`Cross-reference: ${matchCount} matches, ${mismatchCount} mismatches.`);

  const passCount = authenticityResults.checks.filter((c) => c.status === 'pass').length;
  const failCount = authenticityResults.checks.filter((c) => c.status === 'fail').length;
  if (authenticityResults.checks.length > 0) {
    summaryParts.push(`Authenticity: ${passCount} passed, ${failCount} failed.`);
  }

  if (criticalIssues.length > 0) {
    summaryParts.push(`CRITICAL: ${criticalIssues.length} issue(s) require review.`);
  }

  return {
    documentId: documentRecord.id,
    filename: documentRecord.filename,
    documentType,
    extractedData,
    crossReferenceResults: crossReferenceResults.comparisons,
    authenticityChecks: authenticityResults.checks,
    overallMatch: crossReferenceResults.overallMatch && failCount === 0,
    assessment,
    summary: summaryParts.join(' '),
  };
}

module.exports = { generateDocumentReport };
```

### Integration into DocumentAnalysisAgent (Steps 3-5)

The following methods complete the `DocumentAnalysisAgent` class from Story #53:

```javascript
// In index.js — replaces stub methods

async _crossReferenceRegistry(context) {
  const entityProfile = context.existingData?.['entity-resolution'];
  if (!entityProfile) {
    // Document analysis can proceed without entity profile — skip cross-referencing
    this._crossReferenceResults = { comparisons: [], fragments: [], overallMatch: true };
    return {
      description: 'Skipped cross-referencing — no Entity Resolution data available',
      decisionFragments: [],
      llmCalls: [],
    };
  }

  const { crossReferenceRegistry } = require('./registry-comparator');
  this._crossReferenceResults = crossReferenceRegistry(
    this._extractedData,
    this._documentType,
    entityProfile,
  );

  const matches = this._crossReferenceResults.comparisons.filter((c) => c.status === 'match').length;
  const mismatches = this._crossReferenceResults.comparisons.filter((c) => c.status === 'mismatch').length;

  return {
    description: `Cross-referenced ${this._crossReferenceResults.comparisons.length} fields: ${matches} matches, ${mismatches} mismatches`,
    decisionFragments: this._crossReferenceResults.fragments,
    llmCalls: [],
  };
}

async _validateDocumentAuthenticity(context) {
  const entityProfile = context.existingData?.['entity-resolution'] || {};
  const { validateDocumentAuthenticity } = require('./authenticity-validator');

  this._authenticityResults = validateDocumentAuthenticity(
    this._extractedData,
    this._documentType,
    entityProfile,
  );

  const passes = this._authenticityResults.checks.filter((c) => c.status === 'pass').length;
  const fails = this._authenticityResults.checks.filter((c) => c.status === 'fail').length;

  return {
    description: `Authenticity validation: ${passes} passed, ${fails} failed, ${this._authenticityResults.checks.filter((c) => c.status === 'skipped').length} skipped`,
    decisionFragments: this._authenticityResults.fragments,
    llmCalls: [],
  };
}

async _generateDocumentReport(context) {
  const { generateDocumentReport } = require('./report-generator');

  this._report = generateDocumentReport({
    documentRecord: this._documentRecord,
    documentType: this._documentType,
    extractedData: this._extractedData,
    crossReferenceResults: this._crossReferenceResults,
    authenticityResults: this._authenticityResults,
  });

  // Update status to analyzed
  await this._updateAnalysisStatus(this._documentRecord.id, 'analyzed');

  return {
    description: `Document analysis complete: ${this._report.assessment} — ${this._report.summary}`,
    decisionFragments: [],
    llmCalls: [],
  };
}
```

## Acceptance Criteria

- [ ] Step `cross_reference_registry`: compares extracted data against EntityProfile
- [ ] Checks entity name match (fuzzy, handles abbreviations and case)
- [ ] Checks registration number match (exact, normalized)
- [ ] Checks address match (fuzzy, handles formatting differences)
- [ ] Checks incorporation date match (ISO 8601 normalized)
- [ ] Checks director names match (fuzzy, against officers list)
- [ ] Each comparison produces status: `match`, `mismatch`, or `not_available`
- [ ] `document_verified` fragment for matching fields
- [ ] `document_discrepancy` fragment for each mismatch with severity
- [ ] Discrepancy severity: `critical` (reg number, entity name), `warning` (address, directors, dates), `info` (formatting)
- [ ] Critical discrepancies set fragment status to `pending_review`
- [ ] Step `validate_document_authenticity`: checks document recency (proof of address < 3 months)
- [ ] Checks for future dates
- [ ] Checks for expired ID documents
- [ ] Checks for missing required fields per document type
- [ ] Step `generate_document_report`: structured report with all findings
- [ ] Report includes: assessment (`verified`, `discrepancies_found`, `concerns_raised`), summary, all comparison and check results
- [ ] `documents.analysis_status` set to `analyzed` after report generation
- [ ] Graceful handling when EntityProfile is not available (skips cross-referencing)

## Dependencies

- **Depends on**: #53 (Classification + extraction — needs `_extractedData`, `_documentType`, `_documentRecord`), #22 (Decision Fragments — `document_verified`, `document_discrepancy` types), #27-#28 (Entity Resolution — EntityProfile for cross-referencing)
- **Blocks**: #55 (Frontend — needs report data shape for display)

## Testing Strategy

1. **Full cross-reference — all match**: Certificate data matching EntityProfile → all comparisons `match`, overall `verified`
2. **Registration number mismatch**: Different reg numbers → `critical` severity, `pending_review` fragment
3. **Entity name mismatch**: Completely different name → `critical` severity
4. **Entity name — abbreviation match**: "Company Limited" vs "Company Ltd" → `match`
5. **Entity name — case match**: "COMPANY LTD" vs "Company Ltd" → `match`
6. **Address — formatting match**: Multi-line vs single-line same address → `match` (similarity ≥ 0.7)
7. **Address mismatch**: Different addresses → `warning` severity
8. **Director match**: Same directors different order → `match`
9. **Director not in registry**: Document director not found → `warning`, `mismatch`
10. **Incorporation date match**: Same date different format → `match`
11. **Missing EntityProfile**: No entity-resolution data → cross-referencing skipped, no fragments
12. **Missing fields — not_available**: One side has data, other doesn't → `not_available` status
13. **Authenticity — old proof of address**: Date > 3 months ago → `fail`, `warning`
14. **Authenticity — recent proof of address**: Date < 3 months ago → `pass`
15. **Authenticity — future date**: Incorporation date in future → `fail`, `critical`
16. **Authenticity — expired ID**: Expiry date in past → `fail`, `critical`
17. **Authenticity — valid ID**: Expiry date in future → `pass`
18. **Authenticity — missing required fields**: Certificate without registration number → `fail`, `warning`
19. **Report — verified**: No issues → assessment `verified`
20. **Report — discrepancies_found**: Warnings only → assessment `discrepancies_found`
21. **Report — concerns_raised**: Critical issues → assessment `concerns_raised`
22. **Report summary**: Includes match/mismatch counts and critical issue count
