# Document Analysis Agent — Classification and Data Extraction

> GitHub Issue: [#53](https://github.com/jbillay/kyc-agent/issues/53)
> Epic: Document Analysis Agent (#52)
> Size: L (3-5 days) | Priority: High

## Context

The Document Analysis Agent processes uploaded KYC documents through a 5-step pipeline. This story establishes the `DocumentAnalysisAgent` class and implements the first two steps: document classification and structured data extraction. The agent retrieves document content from MinIO, extracts text from PDFs, uses an LLM to classify the document type, and then uses an LLM to extract structured data fields relevant to KYC verification. Extracted data is persisted to the `documents.extracted_data` JSONB column and the `analysis_status` is updated throughout processing.

## Requirements

### Functional

1. `DocumentAnalysisAgent` extends `BaseAgent` with 5 step names: `classify_document`, `extract_document_data`, `cross_reference_registry`, `validate_document_authenticity`, `generate_document_report`
2. Agent receives a `documentId` in its context, retrieves the document record from PostgreSQL and the file content from MinIO
3. Step `classify_document`:
   - Extracts text content from the document (PDF via `pdf-parse`, plain text directly, images via LLM vision if model supports it)
   - Sends extracted text to LLM with `classification` task type
   - LLM identifies document type from: `certificate_of_incorporation`, `articles_of_association`, `proof_of_address`, `utility_bill`, `bank_statement`, `id_document`, `annual_return`, `financial_statement`, `shareholder_register`, `other`
   - Updates `documents.document_type` in database
   - Updates `documents.extracted_text` with raw text content
4. Step `extract_document_data`:
   - Sends document text + classified type to LLM with `extraction` task type
   - LLM extracts structured data based on document type:
     - **Certificate of incorporation**: entity name, registration number, incorporation date, jurisdiction, registered address
     - **Articles of association**: entity name, share classes, director names, registered address
     - **Proof of address / utility bill**: entity or individual name, address, date issued, issuing organization
     - **Bank statement**: account holder name, bank name, address, statement period
     - **ID document**: full name, date of birth, nationality, document number, expiry date
     - **Annual return / financial statement**: entity name, reporting period, key financial figures, director names
     - **Shareholder register**: entity name, shareholder names, share counts, percentages
   - Stores extracted data in `documents.extracted_data` JSONB field
   - Produces `document_verified` decision fragment with extracted data summary

### Non-Functional

- PDF text extraction completes in under 2 seconds for documents up to 50 pages
- LLM classification call completes within configured LLM timeout
- LLM extraction call completes within configured LLM timeout
- Agent updates `documents.analysis_status` to `analyzing` at start, `analyzed` on success, `failed` on error
- Graceful handling of empty/corrupt documents (sets status to `failed` with error details)

## Technical Design

### File: `backend/src/agents/document-analysis/index.js`

```javascript
const { BaseAgent } = require('../base-agent');
const { FragmentType } = require('../decision-fragment');
const { classifyDocument } = require('./document-classifier');
const { extractDocumentData } = require('./data-extractor');
const { extractTextFromDocument } = require('./pdf-extractor');

/**
 * Document Analysis Agent.
 *
 * Analyzes uploaded KYC documents: classifies type, extracts structured
 * data, cross-references against registry data, validates authenticity,
 * and generates a structured report.
 *
 * Steps:
 *   1. classify_document — identify document type via LLM
 *   2. extract_document_data — extract structured fields via LLM
 *   3. cross_reference_registry — compare against EntityProfile (Story #54)
 *   4. validate_document_authenticity — check dates, formatting (Story #54)
 *   5. generate_document_report — produce structured report (Story #54)
 */
class DocumentAnalysisAgent extends BaseAgent {
  /**
   * @param {Object} deps
   * @param {import('../../llm/llm-service').LLMService} deps.llmService
   * @param {import('../../services/document-service').DocumentService} deps.documentService
   * @param {Object} deps.db - Database pool
   */
  constructor(deps) {
    super('document-analysis', [
      'classify_document',
      'extract_document_data',
      'cross_reference_registry',
      'validate_document_authenticity',
      'generate_document_report',
    ]);

    this.llmService = deps.llmService;
    this.documentService = deps.documentService;
    this.db = deps.db;

    // Shared state across steps
    this._documentRecord = null;
    this._extractedText = null;
    this._documentType = null;
    this._extractedData = null;
    this._crossReferenceResults = null;
    this._authenticityResults = null;
    this._report = null;
  }

  /** @override */
  async executeStep(stepName, context, previousSteps) {
    switch (stepName) {
      case 'classify_document':
        return this._classifyDocument(context);
      case 'extract_document_data':
        return this._extractDocumentData(context);
      case 'cross_reference_registry':
        return this._crossReferenceRegistry(context);
      case 'validate_document_authenticity':
        return this._validateDocumentAuthenticity(context);
      case 'generate_document_report':
        return this._generateDocumentReport(context);
      default:
        throw new Error(`Unknown step: ${stepName}`);
    }
  }

  /** @override */
  async compileOutput(context, steps, fragments) {
    return {
      documentId: this._documentRecord?.id,
      documentType: this._documentType,
      extractedData: this._extractedData,
      crossReferenceResults: this._crossReferenceResults,
      authenticityResults: this._authenticityResults,
      report: this._report,
    };
  }

  // ─── Step 1: Classify Document ──────────

  async _classifyDocument(context) {
    const documentId = context.documentId;
    if (!documentId) {
      throw new Error('documentId not found in context — cannot analyze document');
    }

    // Update status to analyzing
    await this._updateAnalysisStatus(documentId, 'analyzing');

    // Retrieve document record and content
    this._documentRecord = await this.documentService.getDocument(documentId);
    if (!this._documentRecord) {
      throw new Error(`Document ${documentId} not found`);
    }

    const fileBuffer = await this.documentService.downloadDocument(this._documentRecord.minioKey);

    // Extract text content
    this._extractedText = await extractTextFromDocument(
      fileBuffer,
      this._documentRecord.mimeType,
      this.llmService
    );

    if (!this._extractedText || this._extractedText.trim().length === 0) {
      await this._updateAnalysisStatus(documentId, 'failed');
      throw new Error('No text content could be extracted from document');
    }

    // Classify via LLM
    const classification = await classifyDocument(this._extractedText, this.llmService);
    this._documentType = classification.documentType;

    // Persist classification and extracted text
    await this.db.query(
      'UPDATE documents SET document_type = $1, extracted_text = $2 WHERE id = $3',
      [this._documentType, this._extractedText, documentId]
    );

    return {
      description: `Classified document "${this._documentRecord.filename}" as ${this._documentType} (confidence: ${classification.confidence}%)`,
      decisionFragments: [],
      llmCalls: [classification.llmCall],
    };
  }

  // ─── Step 2: Extract Document Data ──────────

  async _extractDocumentData(context) {
    const extraction = await extractDocumentData(
      this._extractedText,
      this._documentType,
      this.llmService
    );

    this._extractedData = extraction.data;

    // Persist extracted data
    await this.db.query(
      'UPDATE documents SET extracted_data = $1 WHERE id = $2',
      [JSON.stringify(this._extractedData), this._documentRecord.id]
    );

    return {
      description: `Extracted ${Object.keys(this._extractedData).length} data fields from ${this._documentType}`,
      decisionFragments: [{
        type: FragmentType.DOCUMENT_VERIFIED,
        decision: `Extracted structured data from ${this._documentType}: ${_summarizeExtractedData(this._extractedData)}`,
        confidence: extraction.confidence,
        evidence: {
          dataSources: ['document'],
          dataPoints: [
            { source: 'document', field: 'filename', value: this._documentRecord.filename, fetchedAt: new Date().toISOString() },
            { source: 'document', field: 'document_type', value: this._documentType, fetchedAt: new Date().toISOString() },
            { source: 'document', field: 'extracted_fields', value: Object.keys(this._extractedData).join(', '), fetchedAt: new Date().toISOString() },
          ],
        },
        status: 'pending_review',
      }],
      llmCalls: [extraction.llmCall],
    };
  }

  // Steps 3-5 implemented in Story #54
  async _crossReferenceRegistry(context) { /* Story #54 */ }
  async _validateDocumentAuthenticity(context) { /* Story #54 */ }
  async _generateDocumentReport(context) { /* Story #54 */ }

  // ─── Helpers ──────────

  async _updateAnalysisStatus(documentId, status) {
    await this.db.query(
      'UPDATE documents SET analysis_status = $1 WHERE id = $2',
      [status, documentId]
    );
  }
}

/**
 * Summarize extracted data for decision fragment description.
 * @param {Object} data
 * @returns {string}
 */
function _summarizeExtractedData(data) {
  const fields = [];
  if (data.entityName) fields.push(`entity: ${data.entityName}`);
  if (data.registrationNumber) fields.push(`reg#: ${data.registrationNumber}`);
  if (data.incorporationDate) fields.push(`incorporated: ${data.incorporationDate}`);
  if (data.address) fields.push('address present');
  if (data.directors?.length) fields.push(`${data.directors.length} directors`);
  return fields.join(', ') || 'no key fields extracted';
}

module.exports = { DocumentAnalysisAgent };
```

### File: `backend/src/agents/document-analysis/pdf-extractor.js`

```javascript
const pdfParse = require('pdf-parse');

/**
 * Extract text content from a document buffer based on MIME type.
 *
 * @param {Buffer} buffer - File content
 * @param {string} mimeType - Document MIME type
 * @param {import('../../llm/llm-service').LLMService} llmService - For image extraction via vision
 * @returns {Promise<string>} Extracted text
 */
async function extractTextFromDocument(buffer, mimeType, llmService) {
  if (mimeType === 'application/pdf') {
    return extractFromPdf(buffer);
  }

  if (mimeType === 'text/plain') {
    return buffer.toString('utf-8');
  }

  if (mimeType.startsWith('image/')) {
    return extractFromImage(buffer, mimeType, llmService);
  }

  // Word documents and other types — attempt as text, fallback to empty
  try {
    return buffer.toString('utf-8');
  } catch {
    return '';
  }
}

/**
 * Extract text from PDF using pdf-parse.
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function extractFromPdf(buffer) {
  const result = await pdfParse(buffer);
  return result.text;
}

/**
 * Extract text from image using LLM vision (if model supports it).
 * Falls back to empty string if vision is not available.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {import('../../llm/llm-service').LLMService} llmService
 * @returns {Promise<string>}
 */
async function extractFromImage(buffer, mimeType, llmService) {
  try {
    const isVisionAvailable = await llmService.supportsVision('extraction');
    if (!isVisionAvailable) {
      return '';
    }

    const base64 = buffer.toString('base64');
    const response = await llmService.complete({
      taskType: 'extraction',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', mimeType, data: base64 },
            { type: 'text', text: 'Extract all text content from this document image. Return the text exactly as it appears.' },
          ],
        },
      ],
    });

    return response.content;
  } catch {
    return '';
  }
}

module.exports = { extractTextFromDocument, extractFromPdf, extractFromImage };
```

### File: `backend/src/agents/document-analysis/document-classifier.js`

```javascript
const { prompts } = require('./prompts');

/**
 * @typedef {Object} ClassificationResult
 * @property {string} documentType - One of the recognized document types
 * @property {number} confidence - 0-100
 * @property {Object} llmCall - LLM call metadata for audit
 */

const DOCUMENT_TYPES = [
  'certificate_of_incorporation',
  'articles_of_association',
  'proof_of_address',
  'utility_bill',
  'bank_statement',
  'id_document',
  'annual_return',
  'financial_statement',
  'shareholder_register',
  'other',
];

/**
 * Classify a document's type using LLM.
 *
 * @param {string} text - Extracted text content
 * @param {import('../../llm/llm-service').LLMService} llmService
 * @returns {Promise<ClassificationResult>}
 */
async function classifyDocument(text, llmService) {
  // Truncate text if very long — classification needs first ~2000 chars
  const truncated = text.length > 3000 ? text.slice(0, 3000) + '\n[...truncated]' : text;

  const response = await llmService.complete({
    taskType: 'classification',
    messages: [
      { role: 'system', content: prompts.classifyDocument(DOCUMENT_TYPES) },
      { role: 'user', content: truncated },
    ],
  });

  const parsed = _parseClassificationResponse(response.content);

  return {
    documentType: parsed.documentType,
    confidence: parsed.confidence,
    llmCall: {
      taskType: 'classification',
      model: response.model,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      durationMs: response.durationMs,
    },
  };
}

/**
 * Parse LLM classification response.
 * Expects JSON with documentType and confidence fields.
 *
 * @param {string} responseText
 * @returns {{ documentType: string, confidence: number }}
 */
function _parseClassificationResponse(responseText) {
  try {
    // Try to extract JSON from response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const documentType = DOCUMENT_TYPES.includes(parsed.documentType)
        ? parsed.documentType
        : 'other';
      const confidence = Math.min(100, Math.max(0, parseInt(parsed.confidence, 10) || 50));
      return { documentType, confidence };
    }
  } catch {
    // Fall through to default
  }

  return { documentType: 'other', confidence: 30 };
}

module.exports = { classifyDocument, DOCUMENT_TYPES, _parseClassificationResponse };
```

### File: `backend/src/agents/document-analysis/data-extractor.js`

```javascript
const { prompts } = require('./prompts');

/**
 * @typedef {Object} ExtractionResult
 * @property {Object} data - Extracted structured data
 * @property {number} confidence - 0-100
 * @property {Object} llmCall - LLM call metadata for audit
 */

/**
 * Extract structured data from document text using LLM.
 *
 * @param {string} text - Full extracted text
 * @param {string} documentType - Classified document type
 * @param {import('../../llm/llm-service').LLMService} llmService
 * @returns {Promise<ExtractionResult>}
 */
async function extractDocumentData(text, documentType, llmService) {
  const schema = _getExtractionSchema(documentType);

  const response = await llmService.complete({
    taskType: 'extraction',
    messages: [
      { role: 'system', content: prompts.extractData(documentType, schema) },
      { role: 'user', content: text },
    ],
  });

  const parsed = _parseExtractionResponse(response.content, schema);

  return {
    data: parsed.data,
    confidence: parsed.confidence,
    llmCall: {
      taskType: 'extraction',
      model: response.model,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      durationMs: response.durationMs,
    },
  };
}

/**
 * Get the extraction schema for a document type.
 * Defines which fields the LLM should extract.
 *
 * @param {string} documentType
 * @returns {Object} Schema with field names and descriptions
 */
function _getExtractionSchema(documentType) {
  const schemas = {
    certificate_of_incorporation: {
      entityName: 'Full legal name of the entity',
      registrationNumber: 'Company registration / incorporation number',
      incorporationDate: 'Date of incorporation (ISO 8601)',
      jurisdiction: 'Country or jurisdiction of incorporation',
      registeredAddress: 'Registered office address',
      companyType: 'Type of company (e.g., private limited, public limited)',
    },
    articles_of_association: {
      entityName: 'Full legal name of the entity',
      shareClasses: 'Types of shares and rights (array)',
      directors: 'Names of directors listed (array)',
      registeredAddress: 'Registered office address',
      adoptionDate: 'Date articles were adopted',
    },
    proof_of_address: {
      name: 'Name of individual or entity',
      address: 'Full address shown',
      dateIssued: 'Date the document was issued (ISO 8601)',
      issuingOrganization: 'Organization that issued the document',
    },
    utility_bill: {
      name: 'Account holder name',
      address: 'Service address',
      dateIssued: 'Bill date (ISO 8601)',
      issuingOrganization: 'Utility provider name',
      accountNumber: 'Account or reference number',
    },
    bank_statement: {
      accountHolderName: 'Name on the account',
      bankName: 'Name of the bank',
      address: 'Address on the statement',
      statementPeriod: 'Period covered (start and end dates)',
      accountNumber: 'Account number (may be partially redacted)',
    },
    id_document: {
      fullName: 'Full name as shown on ID',
      dateOfBirth: 'Date of birth (ISO 8601)',
      nationality: 'Nationality or issuing country',
      documentNumber: 'ID document number',
      expiryDate: 'Expiry date (ISO 8601)',
      documentSubType: 'Passport, driving licence, national ID, etc.',
    },
    annual_return: {
      entityName: 'Company name',
      registrationNumber: 'Company registration number',
      reportingPeriod: 'Period covered',
      directors: 'Directors listed (array)',
      shareholders: 'Shareholders listed (array with percentages)',
    },
    financial_statement: {
      entityName: 'Company name',
      reportingPeriod: 'Financial year covered',
      totalAssets: 'Total assets figure',
      totalRevenue: 'Total revenue / turnover',
      netIncome: 'Net income / profit',
      auditor: 'Auditor name (if stated)',
    },
    shareholder_register: {
      entityName: 'Company name',
      shareholders: 'Shareholder entries (array: name, shares, percentage)',
      registerDate: 'Date of register extract',
    },
    other: {
      entityName: 'Any entity name found',
      keyDates: 'Any significant dates found (array)',
      keyNames: 'Any significant names found (array)',
      summary: 'Brief summary of document content',
    },
  };

  return schemas[documentType] || schemas.other;
}

/**
 * Parse LLM extraction response.
 * Expects JSON matching the extraction schema.
 *
 * @param {string} responseText
 * @param {Object} schema
 * @returns {{ data: Object, confidence: number }}
 */
function _parseExtractionResponse(responseText, schema) {
  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const confidence = Math.min(100, Math.max(0, parseInt(parsed.confidence, 10) || 60));

      // Extract only fields from schema (plus confidence)
      const data = {};
      for (const field of Object.keys(schema)) {
        if (parsed[field] !== undefined) {
          data[field] = parsed[field];
        }
      }

      return { data, confidence };
    }
  } catch {
    // Fall through to default
  }

  return { data: {}, confidence: 20 };
}

module.exports = { extractDocumentData, _getExtractionSchema, _parseExtractionResponse };
```

### File: `backend/src/agents/document-analysis/prompts.js`

```javascript
const prompts = {
  /**
   * Prompt for document classification.
   * @param {string[]} documentTypes - Valid document type identifiers
   * @returns {string}
   */
  classifyDocument(documentTypes) {
    return `You are a KYC document classifier. Analyze the provided document text and determine its type.

Valid document types:
${documentTypes.map((t) => `- ${t}`).join('\n')}

Respond with a JSON object:
{
  "documentType": "<one of the valid types above>",
  "confidence": <0-100>,
  "reasoning": "<brief explanation>"
}

If you cannot determine the type with confidence, use "other".`;
  },

  /**
   * Prompt for structured data extraction.
   * @param {string} documentType - Classified document type
   * @param {Object} schema - Fields to extract with descriptions
   * @returns {string}
   */
  extractData(documentType, schema) {
    const fields = Object.entries(schema)
      .map(([key, desc]) => `- ${key}: ${desc}`)
      .join('\n');

    return `You are a KYC data extraction specialist. Extract structured data from this ${documentType.replace(/_/g, ' ')}.

Extract the following fields:
${fields}

Respond with a JSON object containing the extracted fields. Include a "confidence" field (0-100) indicating your confidence in the extraction accuracy.

Rules:
- Use ISO 8601 format for dates (YYYY-MM-DD)
- Use arrays where specified
- Set fields to null if the information is not found in the document
- Do not invent or hallucinate data — only extract what is explicitly present`;
  },
};

module.exports = { prompts };
```

### Document Analysis Status State Machine

```
Upload received
     │
     ▼
  pending ──── agent triggered ───► analyzing
                                       │
                              ┌────────┴────────┐
                              ▼                  ▼
                          analyzed             failed
                   (extracted_data set)    (error details)
```

## Acceptance Criteria

- [ ] `DocumentAnalysisAgent` extends `BaseAgent` with 5 step names
- [ ] Agent receives `documentId` in context and retrieves document from database + MinIO
- [ ] Step `classify_document`: LLM identifies document type from extracted text
- [ ] Supports document types: certificate_of_incorporation, articles_of_association, proof_of_address, utility_bill, bank_statement, id_document, annual_return, financial_statement, shareholder_register, other
- [ ] Step `extract_document_data`: LLM extracts structured data fields based on document type
- [ ] Extraction schema varies per document type (different fields for certificate vs bank statement vs ID)
- [ ] PDF text extraction via `pdf-parse`
- [ ] Image documents handled via LLM vision (graceful fallback if not supported)
- [ ] Plain text documents handled directly
- [ ] `documents.document_type` updated after classification
- [ ] `documents.extracted_text` updated with raw text content
- [ ] `documents.extracted_data` updated with structured JSON
- [ ] `documents.analysis_status` transitions: `pending` → `analyzing` → `analyzed`/`failed`
- [ ] `document_verified` decision fragment produced with extraction summary
- [ ] Empty or corrupt documents set status to `failed` with clear error
- [ ] LLM calls recorded for audit trail

## Dependencies

- **Depends on**: #21 (BaseAgent), #22 (Decision Fragments — `document_verified` type), #6 (MinIO storage), #8 (LLM Service — classification and extraction task types), #3 (Database — documents table)
- **Blocks**: #54 (Registry cross-referencing — needs `_extractedData` and `_documentType`)

## Testing Strategy

1. **Full classification + extraction**: Upload PDF with certificate of incorporation text → verify classified as `certificate_of_incorporation`, structured data extracted (entity name, reg number, date, address)
2. **PDF extraction**: Valid PDF buffer → `extractFromPdf` returns text content
3. **Plain text extraction**: Text buffer with `text/plain` → returns text directly
4. **Image extraction — vision available**: Image buffer + LLM supports vision → returns extracted text
5. **Image extraction — no vision**: Image buffer + LLM does not support vision → returns empty string
6. **Empty document**: Empty PDF → status set to `failed`, error thrown
7. **Classification — certificate**: Text mentioning "Certificate of Incorporation" → `certificate_of_incorporation`
8. **Classification — unknown**: Gibberish text → `other` with low confidence
9. **Classification response parsing**: Valid JSON → correct type and confidence; malformed JSON → `other` with confidence 30
10. **Extraction — certificate fields**: Certificate text → entity name, registration number, incorporation date extracted
11. **Extraction — bank statement fields**: Statement text → account holder, bank name, period extracted
12. **Extraction — missing fields**: Document with partial data → present fields extracted, missing fields null
13. **Extraction response parsing**: Valid JSON → data extracted; malformed JSON → empty data with confidence 20
14. **Database updates**: After classification → verify `document_type` and `extracted_text` in DB; after extraction → verify `extracted_data` in DB
15. **Status transitions**: Verify `pending` → `analyzing` → `analyzed` on success; `pending` → `analyzing` → `failed` on error
16. **Missing documentId**: No documentId in context → error thrown
17. **Missing document**: documentId not found in DB → error thrown
