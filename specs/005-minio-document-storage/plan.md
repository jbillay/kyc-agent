# Implementation Plan: MinIO Document Storage Service

**Branch**: `005-minio-document-storage` | **Date**: 2026-04-09 | **Spec**: [spec.md](spec.md)  
**Input**: Feature specification from `/specs/005-minio-document-storage/spec.md`

## Summary

Implement `backend/src/services/document-service.js` — a Layer 4 core service that streams KYC documents to MinIO (S3-compatible object storage), records metadata in PostgreSQL, soft-deletes documents for regulatory retention, emits audit events to the append-only `decision_events` table, and retries transient storage failures with exponential backoff. A companion database migration adds soft-delete columns to the `documents` table. Four REST API endpoints are wired into the Fastify router. The implementation is test-driven with unit and integration tests covering all eight acceptance scenarios.

## Technical Context

**Language/Version**: Node.js ≥ 22.0.0, JavaScript (CommonJS, `'use strict'`)  
**Primary Dependencies**: `minio ^8.0.0` (object storage client), `pg ^8.13.0` (PostgreSQL), `@fastify/multipart ^9.0.0` (streaming file uploads), `node-pg-migrate ^7.0.0` (schema migrations)  
**Storage**: PostgreSQL 16 (`documents` table for metadata), MinIO (file bytes)  
**Testing**: Jest 29 — test roots at `tests/backend/` per `backend/package.json` jest config  
**Target Platform**: Linux (Docker container, `docker-compose up`)  
**Project Type**: Backend service within a web application (Layer 4 of 6-layer architecture)  
**Performance Goals**: 50 MB upload or download completes within 30 seconds end-to-end  
**Constraints**: Stream uploads directly to MinIO (no full in-memory buffering); encryption at rest required; soft delete (retain files for 7 years by default); retry storage operations up to 3 times with exponential backoff; all operations emit audit events to `decision_events`  
**Scale/Scope**: Service layer feature — no new Docker services; operates within existing Docker Compose stack

## Constitution Check

*GATE: Pre-Phase 0 — all principles must pass before implementation begins.*

| Principle | Status | Justification |
|-----------|--------|---------------|
| I. Auditability First | **PASS** | FR-014 mandates `document_uploaded`, `document_downloaded`, `document_deleted` events in `decision_events`. Convention: `agent_type='document-service'`, `step_id` = operation name. `case_id` obtained from the document row for download/delete operations. |
| II. LLM-Agnostic Provider Interface | **N/A** | No LLM calls in this feature. |
| III. Strict Layered Architecture | **PASS** | `document-service.js` is Layer 4. Depends on: DB connection (Layer 0/infra), `event-store.js` (Layer 4 peer — permitted within same layer), MinIO client (external library). No upward dependencies. |
| IV. Data Sovereignty & Standalone Deployment | **PASS** | MinIO runs as a Docker Compose service. No external cloud storage. All data stays within the deployment boundary. |
| V. Configuration-Driven Compliance Logic | **PASS** | `MAX_FILE_SIZE`, `MINIO_BUCKET`, `MINIO_ENDPOINT/PORT/SSL/ACCESS_KEY/SECRET_KEY`, `DOCUMENT_RETENTION_DAYS` all driven by environment variables. No compliance values hardcoded. |

**Regulatory references**: Money Laundering Regulations 2017 (UK) — 5-year minimum record retention (7-year default chosen); FATF Recommendation 11 — record-keeping for transactions and business relationships; BSA (US) — document retention requirements for CDD.

**Post-Phase 1 re-check**: Constitution Check re-verified after design. No new violations introduced. The soft-delete design satisfies regulatory retention without requiring data destruction.

## Project Structure

### Documentation (this feature)

```text
specs/005-minio-document-storage/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── document-api.md  # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks — not yet created)
```

### Source Code

```text
backend/
├── db/
│   └── migrations/
│       └── {timestamp}_add-soft-delete-to-documents.js   # NEW — soft-delete columns
├── src/
│   ├── services/
│   │   ├── document-service.js                           # NEW (stub → full implementation)
│   │   └── event-store.js                                # NEW (stub → emit() function)
│   └── api/
│       └── cases.js                                      # NEW (stub → document endpoints wired)
tests/
└── backend/
    ├── services/
    │   └── document-service.test.js                      # NEW — unit + integration tests
    └── api/
        └── documents.test.js                             # NEW — API-level integration tests
```

**Structure Decision**: Existing web application layout (Option 2). All new code slots into the established `backend/src/services/` and `backend/src/api/` directories. Test files mirror the source tree under `tests/backend/`.

## Complexity Tracking

> No constitution violations — this table is informational only.

| Design Choice | Why Needed | Simpler Alternative Rejected Because |
|---------------|------------|-------------------------------------|
| Soft delete instead of hard delete | Regulatory retention requirement (MLR 2017, FATF R.11); Q2 clarification | Hard delete destroys evidence documents required for regulatory audit replay |
| `event-store.js` emit function (partial implementation) | `document-service.js` must emit events; `event-store.js` is a stub that blocks this | Calling `decision_events` INSERT directly from document-service would duplicate logic and violate the service boundary |
| Schema migration (contradicts original assumption) | Soft-delete adds new columns not present in `init.sql` | Cannot add columns without a migration; assumption was written before soft-delete was clarified |

## Implementation Approach

### Step 1: Database Migration

Create `backend/db/migrations/{timestamp}_add-soft-delete-to-documents.js`:

```js
exports.up = (pgm) => {
  pgm.addColumns('documents', {
    deleted_at: { type: 'timestamptz', notNull: false },
    deleted_by: { type: 'uuid', notNull: false, references: 'users(id)' },
  });
  pgm.createIndex('documents', 'deleted_at', {
    name: 'idx_documents_deleted_at',
    where: 'deleted_at IS NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex('documents', 'deleted_at', { name: 'idx_documents_deleted_at' });
  pgm.dropColumns('documents', ['deleted_at', 'deleted_by']);
};
```

### Step 2: Event Store — `emit()` function

Implement the minimum surface of `backend/src/services/event-store.js` required by this feature:

```js
async function emit({ caseId, agentType, stepId, eventType, eventData }) {
  await query(
    `INSERT INTO decision_events (case_id, agent_type, step_id, event_type, event_data)
     VALUES ($1, $2, $3, $4, $5)`,
    [caseId, agentType, stepId, eventType, JSON.stringify(eventData)]
  );
}
module.exports = { emit };
```

### Step 3: Document Service — `backend/src/services/document-service.js`

Full implementation replacing the `// TODO: implement` stub. Key design points:

**Retry helper** (inline, no new dependency):
```js
async function withRetry(fn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, 200 * 2 ** (attempt - 1)));
    }
  }
}
```

**`init()`**: Creates MinIO client from env vars; calls `bucketExists` then `makeBucket` if absent. Must be called during application startup (wire into `buildServer` in `backend/src/index.js`).

**`uploadDocument(caseId, file, uploadedBy)`**:
1. Validate `file.mimetype` against `ALLOWED_MIME_TYPES` → throw 400 `INVALID_FILE_TYPE`
2. Validate `file.size` against `MAX_FILE_SIZE` → throw 400 `FILE_TOO_LARGE`
3. Generate `documentId = randomUUID()`; compose `minioKey`
4. `withRetry(() => minio.putObject(BUCKET, minioKey, file.stream, file.size, {'Content-Type': file.mimetype}))`
5. DB INSERT into `documents` — on failure: `withRetry(() => minio.removeObject(...)).catch(() => {})` then rethrow
6. `emit({ caseId, agentType: 'document-service', stepId: 'upload', eventType: 'document_uploaded', eventData: {...} })`
7. Return `{ id: documentId, minioKey }`

**`downloadDocument(documentId)`**:
1. SELECT from `documents WHERE id = $1 AND deleted_at IS NULL`
2. If not found → throw 404 `NOT_FOUND`
3. `withRetry(() => minio.getObject(BUCKET, doc.minio_key))`
4. `emit(... eventType: 'document_downloaded' ...)`
5. Return `{ stream, filename, mimetype, size }`

**`deleteDocument(documentId, deletedBy)`**:
1. SELECT `id, case_id` from `documents WHERE id = $1 AND deleted_at IS NULL`
2. If not found → throw 404 `NOT_FOUND`
3. UPDATE `documents SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`
4. `emit(... eventType: 'document_deleted' ...)`
5. *(File retained in MinIO — physical removal is out of scope)*

**`listDocuments(caseId)`**:
- SELECT `id, filename, mime_type, size_bytes, document_type, analysis_status, uploaded_at FROM documents WHERE case_id = $1 AND deleted_at IS NULL ORDER BY uploaded_at DESC`

### Step 4: API Routes — `backend/src/api/cases.js`

Register `@fastify/multipart` with `limits.fileSize = MAX_FILE_SIZE`. Wire four routes per contracts:

| Method | Path | Handler |
|--------|------|---------|
| `POST` | `/cases/:caseId/documents` | `uploadDocument` |
| `GET` | `/cases/:caseId/documents` | `listDocuments` |
| `GET` | `/documents/:documentId/download` | `downloadDocument` |
| `DELETE` | `/documents/:documentId` | `deleteDocument` |

All params schemas validate `format: 'uuid'`. Error codes from service layer are forwarded via Fastify's error handler (already configured in `index.js`).

Register the route plugin in `backend/src/index.js`:
```js
await app.register(require('./api/cases'), { prefix: '/api/v1' });
```

### Step 5: Docker Compose — Encryption at Rest

Add to the `minio` service in `docker-compose.yml`:
```yaml
environment:
  MINIO_KMS_AUTO_ENCRYPTION: "on"
```

## Test Plan

**Test root**: `tests/backend/` (per `backend/package.json` jest config)

### Unit tests — `tests/backend/services/document-service.test.js`

| Test | Strategy |
|------|----------|
| Upload valid PDF → stored + metadata row | Mock MinIO client + mock `query`; assert putObject called and INSERT executed |
| Upload disallowed MIME → 400 INVALID_FILE_TYPE | No mock calls needed; assert error before any storage call |
| Upload oversized file → 400 FILE_TOO_LARGE | Same; assert error before any storage call |
| DB insert fails after MinIO upload → orphan cleaned up | Mock: putObject resolves, query rejects; assert removeObject called |
| Retry: transient MinIO error → succeeds on 2nd attempt | Mock putObject: rejects once then resolves; assert retried once |
| Download active document → stream + metadata | Mock getObject + query; assert correct return shape |
| Download deleted document → 404 | Mock query returning 0 rows (WHERE deleted_at IS NULL filters it); assert NOT_FOUND |
| Download non-existent document → 404 | Mock query 0 rows; assert NOT_FOUND |
| Delete active document → sets deleted_at | Mock query (SELECT finds row, UPDATE succeeds); assert UPDATE called |
| Delete non-existent/already-deleted → 404 | Mock query 0 rows; assert NOT_FOUND |
| List documents → ordered by uploaded_at DESC | Mock query returns 3 rows; assert order preserved |
| List deleted documents excluded | Mock query (WHERE deleted_at IS NULL built in); assert only non-deleted rows returned |
| init() — bucket absent → makeBucket called | Mock bucketExists=false; assert makeBucket called |
| init() — bucket exists → makeBucket not called | Mock bucketExists=true; assert makeBucket not called |
| Each operation emits correct event to decision_events | Spy on event-store emit; assert called with correct eventType and eventData |

### API integration tests — `tests/backend/api/documents.test.js`

Use Fastify `app.inject()` (no real HTTP server needed). Mock `document-service` module.

| Test | Assertion |
|------|-----------|
| POST valid multipart → 201 with `{ id, minioKey }` | Status 201, body shape |
| POST disallowed MIME → 400 INVALID_FILE_TYPE | Status 400, error.code |
| POST oversized → 400 FILE_TOO_LARGE | Status 400, error.code |
| GET list → 200 array | Status 200, array items match schema |
| GET list empty case → 200 `[]` | Status 200, empty array |
| GET download → 200 with Content-Disposition | Status 200, header present |
| GET download deleted → 404 | Status 404 |
| DELETE → 204 | Status 204, empty body |
| DELETE non-existent → 404 | Status 404 |

## Acceptance Criteria Traceability

| Spec Criterion | Implementation | Test Coverage |
|----------------|----------------|---------------|
| MinIO connects via env vars | `init()` reads `process.env.*` | `init()` unit test |
| Bucket created on startup if absent | `init()` calls `makeBucket` | `init()` unit test (idempotent) |
| Upload streams to MinIO + metadata row | `uploadDocument()` | Upload valid PDF unit test |
| Download returns stream + metadata | `downloadDocument()` | Download unit test |
| Soft-delete marks record, retains file | `deleteDocument()` | Delete unit test |
| Size limit rejected with 400 | `uploadDocument()` validation | Size limit unit test |
| Disallowed MIME rejected with 400 | `uploadDocument()` validation | MIME type unit test |
| DB failure after upload → orphan cleaned | Rollback in catch block | Rollback unit test |
| List returns all active docs ordered by date | `listDocuments()` | List unit test |
| Audit event emitted per operation | `emit()` calls in each operation | Event emission assertions in each test |
| Encryption at rest | MinIO server config (`MINIO_KMS_AUTO_ENCRYPTION`) | Manual verification via MinIO console |
| Retry on transient failure | `withRetry()` | Retry unit test |
| Soft-deleted docs hidden from normal views | `WHERE deleted_at IS NULL` in SELECT | Download/list deleted doc tests |
