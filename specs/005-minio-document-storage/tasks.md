# Tasks: MinIO Document Storage Service

**Input**: Design documents from `/specs/005-minio-document-storage/`  
**Prerequisites**: plan.md ✅ spec.md ✅ research.md ✅ data-model.md ✅ contracts/ ✅ quickstart.md ✅

**Tests**: Included — the implementation plan defines a full test plan covering all acceptance criteria.

**Organization**: Tasks are grouped by user story (Upload → Download → List → Delete) to enable independent implementation and validation of each increment.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no blocking dependencies)
- **[Story]**: Which user story this task belongs to (US1–US4)

## Path Conventions

Web application layout. All backend source under `backend/`, tests under `tests/backend/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Environmental configuration and test directory scaffolding required before any implementation.

- [x] T001 Add `MINIO_KMS_AUTO_ENCRYPTION: "on"` to the `minio` service environment block in `docker-compose.yml` to enable server-side encryption at rest for all stored objects
- [x] T002 [P] Create directory structure `tests/backend/services/` and `tests/backend/api/` (add `.gitkeep` files so directories are tracked by git)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before any user story can be implemented.

**⚠️ CRITICAL**: No user story implementation can begin until this phase is complete.

- [x] T003 Create database migration file `backend/db/migrations/{timestamp}_add-soft-delete-to-documents.js` — add nullable `deleted_at TIMESTAMPTZ` and `deleted_by UUID REFERENCES users(id)` columns to the `documents` table, plus a partial index `idx_documents_deleted_at ON documents (deleted_at) WHERE deleted_at IS NULL`; include a `down` export that drops the index and columns
- [x] T004 [P] Implement `emit({ caseId, agentType, stepId, eventType, eventData })` function in `backend/src/services/event-store.js` — executes `INSERT INTO decision_events (case_id, agent_type, step_id, event_type, event_data) VALUES ($1,$2,$3,$4,$5)` using `query` from `backend/db/connection.js`; export `{ emit }`
- [x] T005 [P] Implement `init()` in `backend/src/services/document-service.js` — create MinIO client from env vars (`MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_USE_SSL`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`), call `bucketExists(BUCKET)` and `makeBucket(BUCKET)` if absent; define module-level constants `BUCKET`, `MAX_FILE_SIZE`, `ALLOWED_MIME_TYPES`; include the `withRetry(fn, maxAttempts=3)` helper (200ms/400ms exponential backoff); stub out exported function names so `require()` resolves: `{ init, uploadDocument, downloadDocument, deleteDocument, listDocuments }`
- [x] T006 Wire startup and routing in `backend/src/index.js` — call `await documentService.init()` inside `buildServer()` after the error handler registration; uncomment and register `require('./api/cases')` with prefix `/api/v1`; also register `@fastify/multipart` plugin with `limits: { fileSize: MAX_FILE_SIZE }` at the app level

**Checkpoint**: Foundation ready — database schema supports soft delete, event store can record document events, MinIO client initialises on startup, Fastify is configured to accept multipart uploads.

---

## Phase 3: User Story 1 — Upload a KYC Document (Priority: P1) 🎯 MVP

**Goal**: A compliance analyst can upload a PDF, JPEG, PNG, TIFF, DOC, or DOCX file (≤ 50 MB) to a KYC case; the file is streamed to MinIO, metadata is recorded in PostgreSQL, and a `document_uploaded` event is written to the audit store.

**Independent Test**: `POST /api/v1/cases/:caseId/documents` with a valid PDF returns 201 with `{ id, minioKey }` and the document appears when listing the case.

- [x] T007 Write unit tests for `uploadDocument()` in `tests/backend/services/document-service.test.js` covering: (1) valid PDF upload → `putObject` called and DB INSERT executed, (2) disallowed MIME type → throws 400 `INVALID_FILE_TYPE` before any MinIO call, (3) oversized file → throws 400 `FILE_TOO_LARGE` before any MinIO call, (4) DB INSERT fails after MinIO upload → `removeObject` called to clean up orphan, (5) transient MinIO error → retried once and succeeds on second attempt, (6) successful upload → `emit` called with `eventType: 'document_uploaded'` and correct `eventData` shape
- [x] T008 [P] Write API integration test for `POST /api/v1/cases/:caseId/documents` in `tests/backend/api/documents.test.js` using `app.inject()` with a mock multipart body — assert 201 response with `{ id, minioKey }` for valid input; assert 400 `INVALID_FILE_TYPE` for disallowed MIME; assert 400 `FILE_TOO_LARGE` for oversized file (mock `document-service` module)
- [x] T009 Implement `uploadDocument(caseId, file, uploadedBy)` in `backend/src/services/document-service.js` — validate `file.mimetype` against `ALLOWED_MIME_TYPES` (throw 400 `INVALID_FILE_TYPE`), validate `file.size` against `MAX_FILE_SIZE` (throw 400 `FILE_TOO_LARGE`), generate `documentId = randomUUID()`, compose `minioKey = cases/${caseId}/${documentId}/${file.filename}`, call `withRetry(() => minio.putObject(BUCKET, minioKey, file.stream, file.size, {'Content-Type': file.mimetype}))`, INSERT into `documents` table (on failure: call `withRetry(() => minio.removeObject(...)).catch(() => {})` then rethrow), call `emit({ caseId, agentType: 'document-service', stepId: 'upload', eventType: 'document_uploaded', eventData: { document_id, case_id, filename, mime_type, size_bytes, actor_id } })`, return `{ id: documentId, minioKey }`
- [x] T010 Implement `POST /cases/:caseId/documents` route in `backend/src/api/cases.js` — define Fastify route schema with `params: { caseId: { type: 'string', format: 'uuid' } }`, parse multipart upload using `request.file()` (from `@fastify/multipart`), call `documentService.uploadDocument(caseId, { filename, mimetype, size, stream: file.file }, uploadedBy)`, reply with 201 and `{ id, minioKey }`; propagate service errors through Fastify error handler

**Checkpoint**: Upload is fully functional. A real PDF can be streamed to MinIO, its metadata recorded in PostgreSQL, and a `document_uploaded` event visible in `decision_events`.

---

## Phase 4: User Story 2 — Download a Case Document (Priority: P2)

**Goal**: An analyst can retrieve the original file stream and metadata for any active (non-deleted) document by its ID via a single HTTP request.

**Independent Test**: Upload a document via the service, then call `GET /api/v1/documents/:documentId/download` and confirm the response stream content matches the original file.

- [x] T011 Write unit tests for `downloadDocument()` in `tests/backend/services/document-service.test.js` covering: (1) active document → `getObject` called and `{ stream, filename, mimetype, size }` returned, (2) soft-deleted document (`deleted_at IS NOT NULL`) → throws 404 `NOT_FOUND`, (3) non-existent document ID → throws 404 `NOT_FOUND`, (4) successful download → `emit` called with `eventType: 'document_downloaded'` and correct `eventData`
- [x] T012 [P] Write API integration test for `GET /api/v1/documents/:documentId/download` in `tests/backend/api/documents.test.js` — assert 200 with `Content-Disposition: attachment; filename=...` and `Content-Type` headers for a found document; assert 404 for a deleted or missing document (mock `document-service` module)
- [x] T013 Implement `downloadDocument(documentId)` in `backend/src/services/document-service.js` — SELECT `filename, mime_type, size_bytes, minio_key, case_id FROM documents WHERE id = $1 AND deleted_at IS NULL`; throw 404 `NOT_FOUND` if no row returned; call `withRetry(() => minio.getObject(BUCKET, doc.minio_key))`; call `emit({ caseId: doc.case_id, agentType: 'document-service', stepId: 'download', eventType: 'document_downloaded', eventData: { document_id, case_id, filename, mime_type, size_bytes, actor_id } })`; return `{ stream, filename, mimetype: doc.mime_type, size: doc.size_bytes }`
- [x] T014 Implement `GET /documents/:documentId/download` route in `backend/src/api/cases.js` — define schema with `params: { documentId: { type: 'string', format: 'uuid' } }`, call `documentService.downloadDocument(documentId)`, set `Content-Type`, `Content-Disposition: attachment; filename="{filename}"`, `Content-Length` headers, pipe `result.stream` to the reply

**Checkpoint**: Download is independently functional. An uploaded document can be retrieved as a stream with correct headers.

---

## Phase 5: User Story 3 — List Documents for a Case (Priority: P2)

**Goal**: An analyst can request all active documents attached to a KYC case and receive them ordered by upload date descending; deleted documents are excluded without error.

**Independent Test**: Upload three documents to the same case, then call `GET /api/v1/cases/:caseId/documents` and confirm all three appear in reverse-chronological order; after soft-deleting one, confirm only two appear.

- [x] T015 Write unit tests for `listDocuments()` in `tests/backend/services/document-service.test.js` covering: (1) case with three documents → all three returned ordered by `uploaded_at DESC`, (2) case with no documents → empty array returned without error, (3) case with one active and one soft-deleted document → only the active document returned (confirms `WHERE deleted_at IS NULL` is applied)
- [x] T016 [P] Write API integration test for `GET /api/v1/cases/:caseId/documents` in `tests/backend/api/documents.test.js` — assert 200 with an array of document metadata objects matching the response schema in `contracts/document-api.md`; assert 200 with empty array for a case with no documents (mock `document-service` module)
- [x] T017 Implement `listDocuments(caseId)` in `backend/src/services/document-service.js` — SELECT `id, filename, mime_type, size_bytes, document_type, analysis_status, uploaded_at FROM documents WHERE case_id = $1 AND deleted_at IS NULL ORDER BY uploaded_at DESC`; return `result.rows` (no event emission — list is a read-only query)
- [x] T018 Implement `GET /cases/:caseId/documents` route in `backend/src/api/cases.js` — define schema with `params: { caseId: { type: 'string', format: 'uuid' } }` and `response: { 200: { type: 'array', items: { ... } } }` matching the contract schema; call `documentService.listDocuments(caseId)`, reply 200 with the array

**Checkpoint**: List is independently functional. A case's document inventory can be retrieved and confirms soft-deleted items are hidden.

---

## Phase 6: User Story 4 — Delete a Document (Priority: P3)

**Goal**: An analyst can soft-delete a document; the metadata record is marked as deleted with actor and timestamp, the file is retained in MinIO, and the document no longer appears in normal views.

**Independent Test**: Upload a document, call `DELETE /api/v1/documents/:documentId`, then confirm the document is absent from `GET /cases/:caseId/documents` and returns 404 on `GET /documents/:documentId/download`.

- [x] T019 Write unit tests for `deleteDocument()` in `tests/backend/services/document-service.test.js` covering: (1) active document → UPDATE sets `deleted_at` and `deleted_by`; `removeObject` is NOT called (file retained), (2) already soft-deleted document (`deleted_at IS NOT NULL` filter excludes it) → throws 404 `NOT_FOUND`, (3) non-existent document ID → throws 404 `NOT_FOUND`, (4) successful delete → `emit` called with `eventType: 'document_deleted'` and correct `eventData`
- [x] T020 [P] Write API integration test for `DELETE /api/v1/documents/:documentId` in `tests/backend/api/documents.test.js` — assert 204 with empty body for an existing active document; assert 404 for a non-existent or already-deleted document (mock `document-service` module)
- [x] T021 Implement `deleteDocument(documentId, deletedBy)` in `backend/src/services/document-service.js` — SELECT `id, case_id FROM documents WHERE id = $1 AND deleted_at IS NULL`; throw 404 `NOT_FOUND` if no row; UPDATE `documents SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`; call `emit({ caseId: doc.case_id, agentType: 'document-service', stepId: 'delete', eventType: 'document_deleted', eventData: { document_id, case_id, actor_id } })`; do NOT call `minio.removeObject` (file is retained per retention policy)
- [x] T022 Implement `DELETE /documents/:documentId` route in `backend/src/api/cases.js` — define schema with `params: { documentId: { type: 'string', format: 'uuid' } }`; extract actor identity from request (e.g., `request.user?.id || null`); call `documentService.deleteDocument(documentId, actorId)`; reply 204 with no body

**Checkpoint**: All four user stories are independently functional. The full document lifecycle (upload → list → download → delete) works end-to-end.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Remaining test coverage for shared infrastructure and end-to-end validation.

- [x] T023 Write unit tests for `init()` in `tests/backend/services/document-service.test.js` covering: (1) bucket does not exist → `bucketExists` returns false, `makeBucket` is called once, (2) bucket already exists → `bucketExists` returns true, `makeBucket` is NOT called (idempotency confirmed)
- [x] T024 Run the quickstart.md validation against the local Docker Compose stack: execute `docker-compose up postgres minio`, apply the migration (`npm run migrate:up`), run all backend tests (`npm test`), execute the curl smoke tests from `quickstart.md` for each operation, and verify `decision_events` records via the psql query in quickstart.md

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 completion — **BLOCKS all user story phases**
  - T003 (migration) can start as soon as Phase 1 is done
  - T004 and T005 can run in parallel with each other (different files)
  - T006 depends on T005 (needs `init()` to exist) and T004 (needs `emit()` to exist)
- **User Story Phases (3–6)**: All depend on Phase 2 completion
- **Polish (Phase 7)**: Depends on all user story phases being complete

### User Story Dependencies

- **US1 — Upload (P1)**: Starts after Phase 2. No dependency on other user stories.
- **US2 — Download (P2)**: Starts after Phase 2. Independent of US1 (documents used in tests are set up via mocks). Can proceed in parallel with US1 if staffed.
- **US3 — List (P2)**: Starts after Phase 2. Independent of US1 and US2.
- **US4 — Delete (P3)**: Starts after Phase 2. Independent of other stories (uses mocks in tests). Deliver after US1–US3 in priority order.

### Within Each User Story

- Test task(s) come first — write and verify they fail before implementing
- Service implementation (T00X ending in 9/3/7/1) before API route (T00X ending in 0/4/8/2)
- Service test (T00X ending in 7/1/5/9) and API test (T00X ending in 8/2/6/0) are **[P]** with each other — different files, no dependency between them

### Parallel Opportunities

- T001 ‖ T002 (Phase 1 — different targets)
- T004 ‖ T005 (Phase 2 — different files: `event-store.js` vs `document-service.js`)
- T007 ‖ T008 (Phase 3 — different test files)
- T011 ‖ T012 (Phase 4 — different test files)
- T015 ‖ T016 (Phase 5 — different test files)
- T019 ‖ T020 (Phase 6 — different test files)
- US1 ‖ US2 ‖ US3 phases in parallel across team members once Phase 2 completes

---

## Parallel Example: Phase 2

```
Start simultaneously:
  Task T004: Implement emit() in backend/src/services/event-store.js
  Task T005: Implement init() + module shell in backend/src/services/document-service.js

Then (after both complete):
  Task T006: Wire buildServer() in backend/src/index.js
```

## Parallel Example: User Story 1 (Upload)

```
Start simultaneously:
  Task T007: Write service unit tests in tests/backend/services/document-service.test.js
  Task T008: Write API integration test in tests/backend/api/documents.test.js

Then sequentially:
  Task T009: Implement uploadDocument() in backend/src/services/document-service.js
  Task T010: Implement POST route in backend/src/api/cases.js
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational (T003–T006) — **critical, cannot skip**
3. Complete Phase 3: User Story 1 — Upload (T007–T010)
4. **STOP and VALIDATE**: Run `npx jest tests/backend/services/document-service.test.js` and test the upload endpoint manually with curl
5. Upload is shippable independently — documents can be ingested into KYC cases

### Incremental Delivery

1. Phases 1–2 → Foundation ready
2. Phase 3 (Upload) → Upload works → MVP demo
3. Phase 4 (Download) → Retrieval works → analysts can view documents
4. Phase 5 (List) → Case inventory visible → full read workflow complete
5. Phase 6 (Delete) → Document lifecycle complete
6. Phase 7 (Polish) → All tests pass, quickstart validated → ready for PR

### Parallel Team Strategy

With two developers:
- Developer A: Phase 2 T004 (event-store) → Phase 3 US1 (Upload)
- Developer B: Phase 2 T005 (document-service shell) → Phase 4 US2 (Download)
- Both: T006 (index wiring) after T004 + T005 complete, then US3 and US4 sequentially

---

## Notes

- `[P]` tasks operate on different files and have no blocking dependencies between them
- `[Story]` label maps each task to its user story for traceability
- Write tests before implementing — confirm they fail first (red), then implement (green)
- Each user story is independently testable via Jest mocks; no real MinIO or PostgreSQL needed for unit/API tests
- The physical file in MinIO is never removed by `deleteDocument()` — this is intentional per the 7-year retention clarification
- The migration (T003) must be applied before any integration test that touches a real database
- Commit after each checkpoint (end of each phase or user story) to keep the history clean
