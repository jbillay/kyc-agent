# Feature Specification: MinIO Document Storage Service

**Feature Branch**: `005-minio-document-storage`  
**Created**: 2026-04-09  
**Status**: Draft  
**Input**: User description: "@specifications/epic-01-infrastructure-devops/minio-storage/SPEC.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Upload a KYC Document (Priority: P1)

A compliance analyst attaches a supporting document (e.g., certificate of incorporation or proof of address) to an open KYC case. The system accepts the file, stores it durably, and records the metadata so the document is discoverable within the case.

**Why this priority**: Document upload is the entry point for all document-related workflows. Nothing else (download, analysis, review) is possible without it.

**Independent Test**: Upload a valid PDF to a case and verify the document appears in the case's document list with correct metadata.

**Acceptance Scenarios**:

1. **Given** a valid KYC case exists, **When** an analyst uploads a PDF file under 50 MB, **Then** the document is stored and its metadata (filename, type, size, upload date) is recorded against the case.
2. **Given** a file exceeds 50 MB, **When** an analyst attempts to upload it, **Then** the upload is rejected with a clear message indicating the size limit.
3. **Given** a file has a disallowed format (e.g., executable, spreadsheet), **When** an analyst attempts to upload it, **Then** the upload is rejected with a message listing the accepted file types.
4. **Given** the storage succeeds but the metadata record fails to save, **When** this partial failure occurs, **Then** the stored file is automatically removed so no orphaned data remains.

---

### User Story 2 - Download a Case Document (Priority: P2)

An analyst or reviewer retrieves a previously uploaded document to inspect its contents during a KYC review session.

**Why this priority**: Retrieval is necessary for human QA and agent document analysis; without it, stored documents have no value.

**Independent Test**: Upload a document, then retrieve it and confirm the returned file content matches the original.

**Acceptance Scenarios**:

1. **Given** a document has been uploaded to a case, **When** a user requests it by its identifier, **Then** the original file is returned with its correct filename and content type.
2. **Given** a document identifier does not exist, **When** a user requests it, **Then** the system responds with a clear "not found" message.

---

### User Story 3 - List Documents for a Case (Priority: P2)

An analyst opens a KYC case and sees all documents that have been attached to it, ordered from most recent to oldest.

**Why this priority**: The document list gives analysts a complete picture of submitted evidence before they begin review.

**Independent Test**: Attach three documents to a case and confirm all three appear in the list ordered by upload time.

**Acceptance Scenarios**:

1. **Given** multiple documents have been uploaded to a case, **When** a user requests the document list for that case, **Then** all documents are returned ordered by upload date, newest first.
2. **Given** no documents have been uploaded for a case, **When** a user requests the document list, **Then** an empty list is returned without error.

---

### User Story 4 - Delete a Document (Priority: P3)

An analyst removes a document that was uploaded in error or is no longer relevant to the KYC case.

**Why this priority**: Deletion is a secondary maintenance operation; the primary document lifecycle (upload, retrieve, list) delivers the core value.

**Independent Test**: Upload a document, delete it, then confirm it no longer appears in the list and cannot be downloaded.

**Acceptance Scenarios**:

1. **Given** a document exists for a case, **When** a user deletes it, **Then** the document no longer appears in the case document list, its metadata record is marked as deleted with the actor and timestamp recorded, and the file is retained in storage.
2. **Given** a document has been soft-deleted, **When** a user attempts to download it, **Then** the system responds with a "not found" message (deleted documents are not accessible via normal retrieval).
3. **Given** a document identifier does not exist, **When** a user attempts to delete it, **Then** the system responds with a clear "not found" message.

---

### Edge Cases

- What happens when the storage service is unavailable during upload? The operation is retried up to 3 times with exponential backoff; if all attempts fail, the caller receives an error and no metadata is persisted.
- What happens when the same filename is uploaded twice to the same case? Each upload creates a unique document record with its own identifier, preserving both files.
- What happens when a file reports a size under the limit but the actual stream exceeds it? The size provided by the caller is used for validation; callers are responsible for accurate size reporting.
- How does the system handle concurrent uploads to the same case? Each upload is independent and generates a unique document ID, so concurrent uploads do not conflict.
- What happens when storage removal fails during a rollback? The rollback failure is suppressed so the original database error is propagated to the caller.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST connect to the document storage service using environment-provided configuration (host, port, credentials, bucket name).
- **FR-002**: System MUST automatically create the default document bucket on startup if it does not already exist.
- **FR-003**: System MUST accept document uploads for a given case and stream the file data directly to storage without buffering the entire file in memory.
- **FR-004**: System MUST record document metadata (case association, filename, content type, size, storage key, uploader identity, upload timestamp) in the database as part of each upload.
- **FR-005**: System MUST reject uploads whose file size exceeds the configured maximum (default 50 MB) with a descriptive error.
- **FR-006**: System MUST reject uploads whose content type is not in the allowed set (PDF, JPEG, PNG, TIFF, DOC, DOCX) with a descriptive error.
- **FR-007**: System MUST clean up any file written to storage if the corresponding metadata record fails to persist, leaving no orphaned files.
- **FR-008**: System MUST retrieve a document's file stream and metadata given its unique identifier.
- **FR-009**: System MUST soft-delete a document by marking its metadata record as deleted (capturing deletion timestamp and actor identity) and hiding it from normal list and retrieval views; the file in storage and the metadata row are retained for audit and compliance purposes. Physical file removal occurs only after a configurable retention period has elapsed.
- **FR-010**: System MUST return all documents associated with a case, ordered by upload date descending.
- **FR-011**: Storage keys MUST follow the pattern `cases/{caseId}/{documentId}/{filename}` to ensure clear organisation by case.
- **FR-012**: The object storage service MUST be configured to encrypt all stored objects at rest; unencrypted storage of KYC documents is not permitted.
- **FR-013**: Storage operations (upload, download, delete) MUST be retried up to 3 times with exponential backoff on transient failures before propagating the error to the caller.
- **FR-014**: System MUST emit an event to the append-only event store for each document operation: `document_uploaded` (on successful upload), `document_downloaded` (on successful download), and `document_deleted` (on successful delete), capturing at minimum the document ID, case ID, operation timestamp, and actor identity.

### Key Entities

- **Document**: Represents a file attached to a KYC case. Key attributes: unique identifier, case association, original filename, content type, size in bytes, storage key, uploader identity, upload timestamp, document type classification, analysis status, deleted flag, deletion timestamp, deleted-by identity.
- **KYC Case**: The parent entity to which documents belong. A case may have zero or more documents.
- **Storage Bucket**: The named container within the object storage service that holds all document files. One default bucket is used across all cases.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Documents up to 50 MB are uploaded and retrievable within 30 seconds end-to-end without data loss or corruption.
- **SC-002**: Uploads of disallowed file types or oversized files are rejected 100% of the time with a user-facing error message before any data is written to storage.
- **SC-003**: If metadata persistence fails after a successful file upload, the orphaned file is removed in every case, leaving storage consistent with the database.
- **SC-004**: The document list for any case returns results ordered correctly by upload time across all tested scenarios.
- **SC-005**: System startup creates the required bucket automatically when it does not exist, requiring zero manual setup steps.
- **SC-006**: All document operations (upload, download, delete, list) succeed when configuration is supplied via environment variables, with no hard-coded credentials.
- **SC-007**: Every successful upload, download, and delete produces exactly one corresponding event record in the audit event store, verifiable by querying it after each operation.
- **SC-008**: All document files are stored in an encrypted form; retrieving a raw object directly from storage without going through the service must not yield readable plaintext document content.

## Clarifications

### Session 2026-04-09

- Q: Should document access events (upload, download, delete) be written to the append-only event store? → A: Yes — emit `document_uploaded`, `document_downloaded`, and `document_deleted` events to the `decision_events` table for full audit traceability.
- Q: Should `deleteDocument` perform a hard delete or a soft delete? → A: Soft delete — mark the metadata record as deleted (with timestamp and actor), hide from normal views, retain the file in storage for a configurable retention period.
- Q: Must documents stored in the object storage service be encrypted at rest? → A: Yes — encryption at rest is a hard requirement; the storage service must be configured to encrypt all objects before persisting them.
- Q: Should storage operations retry on transient failure, or fail immediately? → A: Retry with exponential backoff — up to 3 attempts before failing; applies to upload, download, and delete operations.
- Q: What is the acceptable maximum duration for a 50 MB upload or download? → A: 30 seconds end-to-end.

## Assumptions

- The document storage service (MinIO) is already running and reachable within the deployment environment before the application starts.
- The database `documents` table already exists with the required columns; this feature does not manage schema migrations.
- File size is provided by the caller at upload time; the service trusts this value for validation purposes.
- A single shared bucket is sufficient for all cases; per-case or per-tenant bucket isolation is out of scope.
- Allowed MIME types are fixed for this feature; runtime configuration of the allowed list is out of scope.
- Maximum file size is configurable via an environment variable; the default is 50 MB.
- Authentication and authorisation (determining which users may upload, download, or delete documents) are enforced at the API layer; the document service itself does not check permissions.
- Document files are retained in storage after soft deletion for a configurable retention period (default: 7 years, reflecting common KYC regulatory requirements); physical removal after that period is out of scope for this feature.
- Document type classification and analysis status fields exist in the metadata table but are populated by downstream agents, not by this service.
