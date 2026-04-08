# Case Audit Export (PDF and JSON)

> GitHub Issue: [#73](https://github.com/jbillay/kyc-agent/issues/73)
> Epic: Audit Trail & Reporting (#71)
> Size: L (5-8 days) | Priority: High

## Context

Compliance officers need to produce complete audit packages for regulators and internal audit teams. This story implements two export formats: a structured JSON export for machine consumption and integration, and a professionally formatted PDF report suitable for regulatory submission.

The JSON export aggregates all case data (case metadata, agent results, decision fragments, decision events, review history) into a single document. The PDF export renders this data as a formatted report with cover page, executive summary, entity profile, ownership structure, screening results, risk assessment, and complete audit trail.

Large exports (cases with many agents, events, and documents) are handled asynchronously via BullMQ to avoid HTTP timeouts — the API returns a job ID, and the client polls or receives a WebSocket notification when the export is ready for download.

## Requirements

### Functional

1. `GET /api/v1/audit/cases/:id/export?format=json` — returns complete JSON export containing:
   - Case metadata (client name, type, jurisdiction, registration number, state, risk score/rating, dates)
   - All agent results (per-agent: type, status, output, confidence, steps, latency)
   - All decision fragments (type, decision, confidence, evidence, review status, reviewer comments)
   - All decision events (chronological, full payload)
   - Review history (reviewer, decision, comments, timestamps)
   - Document list (filenames, types, analysis status — not file contents)
2. `GET /api/v1/audit/cases/:id/export?format=pdf` — returns formatted PDF report with sections:
   - **Cover page**: entity name, registration number, jurisdiction, risk rating (color-coded badge), review decision, export date
   - **Executive summary**: risk narrative (from risk assessment agent output)
   - **Entity profile**: company details, officers, filing history
   - **Ownership structure**: ownership chain as a table (entity, ownership %, jurisdiction, UBO flag)
   - **Screening results**: per-person/entity screening outcomes with match details and LLM reasoning
   - **Document analysis**: document list with classification, verification status, extracted data
   - **Risk assessment**: risk score breakdown (per-factor scores), risk factors, narrative
   - **Complete audit trail**: chronological event log (timestamp, type, agent, summary)
   - **Reviewer decisions**: review comments, decisions, overrides
3. Export metadata included in both formats:
   - `exported_at`: ISO timestamp
   - `exported_by`: user who requested the export (name, email, role)
   - `platform_version`: application version string
4. Large exports handled asynchronously:
   - If case has > 200 events or > 5 agent results, return `202 Accepted` with job ID
   - `GET /api/v1/audit/exports/:jobId/status` — check export job status
   - `GET /api/v1/audit/exports/:jobId/download` — download completed export
   - WebSocket event `audit:export_ready` sent when async export completes
5. PDF is professionally formatted and suitable for regulatory submission:
   - Consistent typography, headers, page numbers
   - Table of contents with page references
   - Color-coded risk rating badge
   - Company logo placeholder in header
6. Export restricted to `compliance_officer` role and above

### Non-Functional

- JSON export for a typical case (5 agents, 100 events) completes within 2 seconds
- PDF export for a typical case completes within 10 seconds
- Async export jobs retained for 24 hours before cleanup
- Maximum PDF size: 50 MB (guard against unbounded growth)

## Technical Design

### Backend: Export Endpoints

#### File: `backend/src/api/audit.js` (additions)

```javascript
// ─── GET /api/v1/audit/cases/:id/export ─────────
app.get(
  '/audit/cases/:id/export',
  {
    preHandler: [app.authenticate, app.requireRole('compliance_officer')],
    schema: {
      params: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', format: 'uuid' },
        },
      },
      querystring: {
        type: 'object',
        required: ['format'],
        properties: {
          format: { type: 'string', enum: ['json', 'pdf'] },
        },
      },
    },
  },
  async (request, reply) => {
    const { id } = request.params;
    const { format } = request.query;
    const user = request.user;

    // Check if case exists
    const caseData = await auditService.getCaseForExport(id);
    if (!caseData) {
      return reply.status(404).send({
        error: { code: 'CASE_NOT_FOUND', message: 'Case not found' },
      });
    }

    // Determine if async export is needed
    const eventCount = await auditService.getCaseEventCount(id);
    const agentCount = await auditService.getCaseAgentCount(id);

    if (eventCount > 200 || agentCount > 5) {
      // Async export via BullMQ
      const jobId = await auditService.queueExport(id, format, user);
      return reply.status(202).send({
        jobId,
        message: 'Export queued. Check status at /api/v1/audit/exports/:jobId/status',
      });
    }

    // Synchronous export
    if (format === 'json') {
      const data = await auditService.generateJsonExport(id, user);
      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', `attachment; filename="kyc-audit-${id}.json"`);
      return reply.send(data);
    }

    if (format === 'pdf') {
      const pdfBuffer = await auditService.generatePdfExport(id, user);
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="kyc-audit-${id}.pdf"`);
      return reply.send(pdfBuffer);
    }
  }
);

// ─── GET /api/v1/audit/exports/:jobId/status ────
app.get(
  '/audit/exports/:jobId/status',
  {
    preHandler: [app.authenticate, app.requireRole('compliance_officer')],
    schema: {
      params: {
        type: 'object',
        required: ['jobId'],
        properties: {
          jobId: { type: 'string' },
        },
      },
    },
  },
  async (request, reply) => {
    const status = await auditService.getExportJobStatus(request.params.jobId);
    if (!status) {
      return reply.status(404).send({
        error: { code: 'JOB_NOT_FOUND', message: 'Export job not found' },
      });
    }
    return reply.send(status);
  }
);

// ─── GET /api/v1/audit/exports/:jobId/download ──
app.get(
  '/audit/exports/:jobId/download',
  {
    preHandler: [app.authenticate, app.requireRole('compliance_officer')],
  },
  async (request, reply) => {
    const result = await auditService.getExportResult(request.params.jobId);
    if (!result) {
      return reply.status(404).send({
        error: { code: 'EXPORT_NOT_READY', message: 'Export not ready or not found' },
      });
    }
    reply.header('Content-Type', result.contentType);
    reply.header('Content-Disposition', `attachment; filename="${result.filename}"`);
    return reply.send(result.data);
  }
);
```

#### File: `backend/src/services/audit-service.js` (additions)

```javascript
/**
 * Generate complete JSON export for a case.
 *
 * @param {string} caseId
 * @param {Object} exportedBy - { sub, email, name, role }
 * @returns {Promise<Object>}
 */
async generateJsonExport(caseId, exportedBy) {
  const [caseData, agentResults, fragments, events, documents] = await Promise.all([
    this._getCaseData(caseId),
    this._getAgentResults(caseId),
    this._getDecisionFragments(caseId),
    this._getAllEvents(caseId),
    this._getDocuments(caseId),
  ]);

  return {
    export_metadata: {
      exported_at: new Date().toISOString(),
      exported_by: {
        name: exportedBy.name,
        email: exportedBy.email,
        role: exportedBy.role,
      },
      platform_version: process.env.APP_VERSION || '1.0.0',
      case_id: caseId,
    },
    case: caseData,
    agent_results: agentResults,
    decision_fragments: fragments,
    decision_events: events,
    documents: documents,
  };
}
```

#### File: `backend/src/services/pdf-export-service.js`

```javascript
const PDFDocument = require('pdfkit');

/**
 * PDF export service — generates regulatory-grade PDF reports for KYC cases.
 *
 * @param {Object} deps
 * @param {import('./audit-service').AuditService} deps.auditService
 */
class PdfExportService {
  constructor({ auditService }) {
    this.auditService = auditService;
  }

  /**
   * Generate a PDF report for a case.
   *
   * @param {string} caseId
   * @param {Object} exportedBy
   * @returns {Promise<Buffer>}
   */
  async generate(caseId, exportedBy) {
    const data = await this.auditService.generateJsonExport(caseId, exportedBy);
    const doc = new PDFDocument({ size: 'A4', margin: 50, bufferPages: true });

    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));

    this._renderCoverPage(doc, data);
    this._renderTableOfContents(doc, data);
    this._renderExecutiveSummary(doc, data);
    this._renderEntityProfile(doc, data);
    this._renderOwnershipStructure(doc, data);
    this._renderScreeningResults(doc, data);
    this._renderDocumentAnalysis(doc, data);
    this._renderRiskAssessment(doc, data);
    this._renderAuditTrail(doc, data);
    this._renderReviewerDecisions(doc, data);
    this._addPageNumbers(doc);

    doc.end();

    return new Promise((resolve) => {
      doc.on('end', () => resolve(Buffer.concat(buffers)));
    });
  }

  // ─── Section renderers (private) ──────────────────

  _renderCoverPage(doc, data) {
    // Logo placeholder
    doc.fontSize(28).text('KYC Agent', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(18).text('Case Audit Report', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(14).text(`Entity: ${data.case.client_name}`, { align: 'center' });
    doc.text(`Registration: ${data.case.registration_number || 'N/A'}`, { align: 'center' });
    doc.text(`Jurisdiction: ${data.case.jurisdiction}`, { align: 'center' });
    doc.moveDown(1);
    doc.text(`Risk Rating: ${data.case.risk_rating || 'Pending'}`, { align: 'center' });
    doc.text(`Review Decision: ${data.case.review_decision || 'Pending'}`, { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(10).text(`Exported: ${data.export_metadata.exported_at}`, { align: 'center' });
    doc.text(`By: ${data.export_metadata.exported_by.name}`, { align: 'center' });
    doc.text(`Platform Version: ${data.export_metadata.platform_version}`, { align: 'center' });
    doc.addPage();
  }

  _renderTableOfContents(doc, data) {
    doc.fontSize(16).text('Table of Contents');
    doc.moveDown(0.5);
    const sections = [
      'Executive Summary',
      'Entity Profile',
      'Ownership Structure',
      'Screening Results',
      'Document Analysis',
      'Risk Assessment',
      'Complete Audit Trail',
      'Reviewer Decisions',
    ];
    sections.forEach((section, i) => {
      doc.fontSize(11).text(`${i + 1}. ${section}`);
    });
    doc.addPage();
  }

  _renderExecutiveSummary(doc, data) {
    doc.fontSize(16).text('1. Executive Summary');
    doc.moveDown(0.5);
    const riskAgent = data.agent_results.find((r) => r.agent_type === 'risk_assessment');
    const narrative = riskAgent?.output?.narrative || 'Risk assessment not yet completed.';
    doc.fontSize(11).text(narrative);
    doc.addPage();
  }

  _renderEntityProfile(doc, data) { /* ... entity details, officers, filings ... */ }
  _renderOwnershipStructure(doc, data) { /* ... ownership table with %, jurisdiction, UBO flag ... */ }
  _renderScreeningResults(doc, data) { /* ... per-person screening with match details ... */ }
  _renderDocumentAnalysis(doc, data) { /* ... document list with classification, verification ... */ }
  _renderRiskAssessment(doc, data) { /* ... score breakdown, risk factors, narrative ... */ }
  _renderAuditTrail(doc, data) { /* ... chronological event log table ... */ }
  _renderReviewerDecisions(doc, data) { /* ... review comments, decisions, overrides ... */ }

  _addPageNumbers(doc) {
    const pages = doc.bufferedPageRange();
    for (let i = pages.start; i < pages.start + pages.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).text(
        `Page ${i + 1} of ${pages.count}`,
        50,
        doc.page.height - 40,
        { align: 'center' }
      );
    }
  }
}

module.exports = { PdfExportService };
```

### Async Export Worker

Export jobs use the existing BullMQ infrastructure (`agent-worker.js` pattern). A new queue `audit-export` processes large exports:

```javascript
// In backend/src/workers/export-worker.js
const { Worker } = require('bullmq');

const exportWorker = new Worker(
  'audit-export',
  async (job) => {
    const { caseId, format, exportedBy } = job.data;

    if (format === 'json') {
      const data = await auditService.generateJsonExport(caseId, exportedBy);
      // Store result in MinIO for download
      const key = `exports/${job.id}.json`;
      await minioClient.putObject('exports', key, JSON.stringify(data));
      return { key, contentType: 'application/json', filename: `kyc-audit-${caseId}.json` };
    }

    if (format === 'pdf') {
      const buffer = await pdfExportService.generate(caseId, exportedBy);
      const key = `exports/${job.id}.pdf`;
      await minioClient.putObject('exports', key, buffer);
      return { key, contentType: 'application/pdf', filename: `kyc-audit-${caseId}.pdf` };
    }
  },
  { connection: redisConnection }
);

// Emit WebSocket event on completion
exportWorker.on('completed', (job) => {
  socketio.to(`user:${job.data.exportedBy.sub}`).emit('audit:export_ready', {
    jobId: job.id,
    caseId: job.data.caseId,
    format: job.data.format,
  });
});
```

### Frontend: Export Controls

Add export buttons to the case detail view header or Audit Trail tab:

```javascript
// In AuditTrailTab.vue or CaseDetailHeader.vue
async function exportCase(format) {
  exporting.value = true;
  try {
    const response = await api.get(`/audit/cases/${caseId}/export`, {
      params: { format },
      responseType: format === 'pdf' ? 'blob' : 'json',
    });

    if (response.status === 202) {
      // Async export — show notification and wait for WebSocket
      const { jobId } = response.data;
      toast.info('Export queued. You will be notified when it is ready.');
      awaitExportJob(jobId);
      return;
    }

    // Synchronous — trigger download
    downloadFile(response.data, `kyc-audit-${caseId}.${format}`);
  } finally {
    exporting.value = false;
  }
}
```

### JSON Export Schema

```json
{
  "export_metadata": {
    "exported_at": "2026-04-07T14:30:00Z",
    "exported_by": { "name": "Jane Smith", "email": "jane@company.com", "role": "compliance_officer" },
    "platform_version": "1.0.0",
    "case_id": "uuid"
  },
  "case": {
    "id": "uuid",
    "client_name": "Acme Corp",
    "client_type": "corporate",
    "jurisdiction": "GB",
    "registration_number": "12345678",
    "state": "APPROVED",
    "risk_score": 35,
    "risk_rating": "medium",
    "review_decision": "approved",
    "review_comment": "All checks satisfactory",
    "reviewed_at": "2026-04-07T12:00:00Z",
    "created_at": "2026-04-06T09:00:00Z",
    "completed_at": "2026-04-07T12:00:00Z"
  },
  "agent_results": [ "..." ],
  "decision_fragments": [ "..." ],
  "decision_events": [ "..." ],
  "documents": [ "..." ]
}
```

### Error Response Format

| Error Code | HTTP Status | When |
|-----------|-------------|------|
| `CASE_NOT_FOUND` | 404 | Case ID does not exist |
| `JOB_NOT_FOUND` | 404 | Export job ID does not exist |
| `EXPORT_NOT_READY` | 404 | Export job not completed yet or expired |
| `UNAUTHORIZED` | 401 | Missing or invalid auth token |
| `FORBIDDEN` | 403 | User role below `compliance_officer` |
| `EXPORT_TOO_LARGE` | 413 | Export exceeds 50 MB limit |

## Acceptance Criteria

- [ ] `GET /api/v1/audit/cases/:id/export?format=json` returns complete JSON with all case data, agent results, fragments, events, review history
- [ ] `GET /api/v1/audit/cases/:id/export?format=pdf` returns formatted PDF report
- [ ] PDF contains: cover page, table of contents, executive summary, entity profile, ownership structure, screening results, document analysis, risk assessment, audit trail, reviewer decisions
- [ ] PDF has page numbers, consistent formatting, and is suitable for regulatory submission
- [ ] Export metadata includes: export date, exported by (name, email, role), platform version
- [ ] Cases with > 200 events return 202 with job ID for async processing
- [ ] `GET /api/v1/audit/exports/:jobId/status` returns job status (queued, active, completed, failed)
- [ ] `GET /api/v1/audit/exports/:jobId/download` returns completed export file
- [ ] WebSocket `audit:export_ready` event sent when async export completes
- [ ] Export buttons (JSON, PDF) visible in case detail view for compliance_officer+
- [ ] Export restricted to `compliance_officer` role and above (403 for lower roles)
- [ ] JSON export for typical case completes within 2 seconds
- [ ] Async export jobs cleaned up after 24 hours

## Dependencies

- **Depends on**: #72 (Audit trail view — shared `AuditService`), #25 (Event store), #34 (Cases CRUD), #35 (Decision fragments API), #6 (MinIO — for async export storage), #24 (BullMQ worker — for async export queue), #67 (Auth — RBAC enforcement)
- **Blocks**: None

## Testing Strategy

### Backend

1. **JSON export — complete data**: Create case with agents, fragments, events, documents; export as JSON; verify all sections present and complete
2. **JSON export — metadata**: Verify `exported_at`, `exported_by`, `platform_version` present in export
3. **JSON export — case not found**: Export non-existent case ID, verify 404
4. **PDF export — generates valid PDF**: Export as PDF, verify response is valid PDF buffer with correct content-type
5. **PDF export — cover page**: Verify PDF contains entity name, risk rating, export date
6. **PDF export — sections**: Verify PDF contains all required sections (executive summary through reviewer decisions)
7. **PDF export — page numbers**: Verify all pages have page numbers in footer
8. **Async export — triggers for large case**: Create case with 201 events, request export, verify 202 response with job ID
9. **Async export — status endpoint**: Queue export, check status, verify `queued` or `active`
10. **Async export — download**: Wait for job completion, download, verify file contents
11. **Async export — WebSocket notification**: Queue export, verify `audit:export_ready` emitted on completion
12. **Auth — compliance_officer allowed**: Export with compliance_officer role, verify success
13. **Auth — analyst denied**: Export with analyst role, verify 403
14. **Auth — unauthenticated**: Export without token, verify 401

### Frontend

15. **Export buttons**: Verify JSON and PDF export buttons visible for compliance_officer
16. **Export buttons hidden**: Verify export buttons hidden for analyst role
17. **Synchronous download**: Click JSON export, verify file download triggered
18. **Async notification**: Click export for large case, verify "export queued" toast, verify download on WebSocket event
