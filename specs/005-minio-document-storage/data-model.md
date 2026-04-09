# Data Model: MinIO Document Storage Service

**Branch**: `005-minio-document-storage` | **Phase**: 1 | **Date**: 2026-04-09

## Entities

### Document

Represents a file attached to a KYC case. Stored as a metadata row in PostgreSQL; the file bytes live in MinIO.

**PostgreSQL table**: `documents`

| Column | Type | Nullable | Constraint | Notes |
|--------|------|----------|------------|-------|
| `id` | `UUID` | NO | PK, `DEFAULT gen_random_uuid()` | Unique document identifier |
| `case_id` | `UUID` | NO | FK → `cases(id)` | Owning case |
| `filename` | `VARCHAR(500)` | NO | | Original filename as uploaded |
| `mime_type` | `VARCHAR(100)` | NO | | e.g. `application/pdf` |
| `size_bytes` | `BIGINT` | NO | | File size as reported by caller |
| `minio_key` | `VARCHAR(500)` | NO | | Storage key: `cases/{caseId}/{documentId}/{filename}` |
| `document_type` | `VARCHAR(100)` | YES | | Set by Document Analysis agent; NULL until analyzed |
| `extracted_text` | `TEXT` | YES | | Set by Document Analysis agent |
| `extracted_data` | `JSONB` | YES | | Set by Document Analysis agent |
| `analysis_status` | `VARCHAR(20)` | NO | CHECK IN ('pending','analyzing','analyzed','failed'), DEFAULT 'pending' | Lifecycle state for analysis |
| `uploaded_at` | `TIMESTAMPTZ` | NO | `DEFAULT NOW()` | Upload timestamp |
| `uploaded_by` | `UUID` | YES | FK → `users(id)` | Actor who uploaded; NULL for system uploads |
| `deleted_at` | `TIMESTAMPTZ` | YES | | NULL = active; non-NULL = soft-deleted (**NEW — migration required**) |
| `deleted_by` | `UUID` | YES | FK → `users(id)` | Actor who deleted (**NEW — migration required**) |

**Existing indexes** (from `init.sql`):
- `idx_documents_case ON documents (case_id)`

**New indexes** (added by migration):
- `idx_documents_deleted_at ON documents (deleted_at) WHERE deleted_at IS NULL` — partial index for active-document queries

**Validation rules enforced at service layer** (not DB-level):
- `mime_type` must be one of: `application/pdf`, `image/jpeg`, `image/png`, `image/tiff`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`
- `size_bytes` must be ≤ `MAX_FILE_SIZE` (default 52,428,800 bytes / 50 MB)

---

### Storage Key

Not a table — a computed string that determines the object path within MinIO.

**Pattern**: `cases/{caseId}/{documentId}/{filename}`

**Example**: `cases/550e8400-e29b-41d4-a716-446655440000/f47ac10b-58cc-4372-a567-0e02b2c3d479/certificate-of-incorporation.pdf`

**Properties**:
- Unique per document (documentId component is a UUID generated at upload time)
- Preserves the original filename for human legibility in MinIO console
- Groups all documents for a case under a single prefix, enabling future bulk operations

---

### Decision Event (document context)

Documents produce events in the shared `decision_events` table. No new table.

**Convention for document events**:

| Column | Value |
|--------|-------|
| `agent_type` | `'document-service'` |
| `step_id` | `'upload'` \| `'download'` \| `'delete'` |
| `event_type` | `'document_uploaded'` \| `'document_downloaded'` \| `'document_deleted'` |
| `case_id` | UUID of the owning case |

**`event_data` shape** (JSONB):
```json
{
  "document_id": "<uuid>",
  "case_id": "<uuid>",
  "filename": "<string>",
  "mime_type": "<string>",
  "size_bytes": 12345,
  "actor_id": "<uuid | null>"
}
```

---

## State Transitions

### Document Lifecycle

```
[Upload attempted]
        │
        ▼
   Validation ──► REJECTED (mime_type or size_bytes invalid; nothing persisted)
        │
        ▼
  MinIO upload ──► RETRY (up to 3 attempts with backoff on transient error)
        │            │
        │            └──► FAILED (error returned to caller after all retries)
        ▼
  DB insert ──► FAILED + MinIO rollback (orphan cleanup; error returned)
        │
        ▼
   ACTIVE (deleted_at IS NULL)
        │
        ├──► [Download requested] → event emitted → stream returned
        │
        └──► [Delete requested]
                    │
                    ▼
              SOFT-DELETED (deleted_at set, deleted_by set)
              File retained in MinIO for retention period
```

### Document `analysis_status` (owned by Document Analysis agent, not this service)

```
pending → analyzing → analyzed
                  └──► failed
```

---

## Migration

**File**: `backend/db/migrations/{timestamp}_add-soft-delete-to-documents.js`

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
