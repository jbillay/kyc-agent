# MinIO Document Storage Service

> GitHub Issue: [#6](https://github.com/jbillay/kyc-agent/issues/6)
> Epic: Infrastructure & DevOps Setup (#1)
> Size: S (less than 1 day) | Priority: High

## Context

KYC cases require supporting documents — certificates of incorporation, proof of address, ID documents, bank statements, etc. MinIO provides S3-compatible object storage that runs locally within the Docker Compose stack, ensuring data sovereignty. File metadata is tracked in PostgreSQL while the actual file bytes live in MinIO.

## Requirements

### Functional

1. MinIO client connects to the MinIO container using environment variables
2. Default `documents` bucket is created on application startup if absent
3. Document service provides upload, download, and delete operations
4. File metadata is recorded in the PostgreSQL `documents` table
5. File size limits are enforced (configurable, default 50MB)
6. Only allowed MIME types are accepted

### Non-Functional

- Upload streams directly to MinIO (no buffering entire file in memory)
- MinIO key pattern provides clear organization: `cases/{caseId}/{documentId}/{filename}`
- Operations are atomic: if MinIO upload succeeds but DB insert fails, the orphaned file is cleaned up

## Technical Design

### File: `backend/src/services/document-service.js`

```javascript
const { Client: MinioClient } = require('minio');
const { randomUUID } = require('crypto');
const { query, getClient } = require('../../db/connection');

const BUCKET = process.env.MINIO_BUCKET || 'documents';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || String(50 * 1024 * 1024)); // 50MB

const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

/** @type {MinioClient} */
let minio;

/**
 * Initialize MinIO client and ensure the bucket exists.
 */
async function init() {
  minio = new MinioClient({
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000'),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
  });

  const exists = await minio.bucketExists(BUCKET);
  if (!exists) {
    await minio.makeBucket(BUCKET);
  }
}

/**
 * Upload a document to MinIO and record metadata in PostgreSQL.
 *
 * @param {string} caseId - UUID of the case
 * @param {Object} file
 * @param {string} file.filename - Original filename
 * @param {string} file.mimetype - MIME type
 * @param {number} file.size - Size in bytes
 * @param {import('stream').Readable} file.stream - File data stream
 * @param {string} [uploadedBy] - UUID of the uploading user
 * @returns {Promise<{ id: string, minioKey: string }>}
 */
async function uploadDocument(caseId, file, uploadedBy) {
  // Validate MIME type
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw Object.assign(
      new Error(`File type '${file.mimetype}' is not allowed`),
      { statusCode: 400, code: 'INVALID_FILE_TYPE' }
    );
  }

  // Validate file size
  if (file.size > MAX_FILE_SIZE) {
    throw Object.assign(
      new Error(`File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`),
      { statusCode: 400, code: 'FILE_TOO_LARGE' }
    );
  }

  const documentId = randomUUID();
  const minioKey = `cases/${caseId}/${documentId}/${file.filename}`;

  // Upload to MinIO
  await minio.putObject(BUCKET, minioKey, file.stream, file.size, {
    'Content-Type': file.mimetype,
  });

  // Record metadata in PostgreSQL
  try {
    await query(
      `INSERT INTO documents (id, case_id, filename, mime_type, size_bytes, minio_key, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [documentId, caseId, file.filename, file.mimetype, file.size, minioKey, uploadedBy]
    );
  } catch (dbError) {
    // Rollback: remove orphaned file from MinIO
    await minio.removeObject(BUCKET, minioKey).catch(() => {});
    throw dbError;
  }

  return { id: documentId, minioKey };
}

/**
 * Download a document by its database ID.
 *
 * @param {string} documentId - UUID of the document
 * @returns {Promise<{ stream: import('stream').Readable, filename: string, mimetype: string, size: number }>}
 */
async function downloadDocument(documentId) {
  const result = await query(
    'SELECT filename, mime_type, size_bytes, minio_key FROM documents WHERE id = $1',
    [documentId]
  );

  if (result.rows.length === 0) {
    throw Object.assign(
      new Error('Document not found'),
      { statusCode: 404, code: 'NOT_FOUND' }
    );
  }

  const doc = result.rows[0];
  const stream = await minio.getObject(BUCKET, doc.minio_key);

  return {
    stream,
    filename: doc.filename,
    mimetype: doc.mime_type,
    size: doc.size_bytes,
  };
}

/**
 * Delete a document from MinIO and PostgreSQL.
 *
 * @param {string} documentId - UUID of the document
 */
async function deleteDocument(documentId) {
  const result = await query(
    'SELECT minio_key FROM documents WHERE id = $1',
    [documentId]
  );

  if (result.rows.length === 0) {
    throw Object.assign(
      new Error('Document not found'),
      { statusCode: 404, code: 'NOT_FOUND' }
    );
  }

  const { minio_key } = result.rows[0];
  await minio.removeObject(BUCKET, minio_key);
  await query('DELETE FROM documents WHERE id = $1', [documentId]);
}

/**
 * List all documents for a case.
 *
 * @param {string} caseId - UUID of the case
 * @returns {Promise<Object[]>}
 */
async function listDocuments(caseId) {
  const result = await query(
    `SELECT id, filename, mime_type, size_bytes, document_type, analysis_status, uploaded_at
     FROM documents WHERE case_id = $1 ORDER BY uploaded_at DESC`,
    [caseId]
  );
  return result.rows;
}

module.exports = {
  init,
  uploadDocument,
  downloadDocument,
  deleteDocument,
  listDocuments,
};
```

### MinIO Configuration

Environment variables consumed by the service:

| Variable | Default | Purpose |
|----------|---------|---------|
| `MINIO_ENDPOINT` | `localhost` | MinIO server hostname |
| `MINIO_PORT` | `9000` | MinIO API port |
| `MINIO_USE_SSL` | `false` | Enable TLS |
| `MINIO_ACCESS_KEY` | `minioadmin` | Access key |
| `MINIO_SECRET_KEY` | `minioadmin` | Secret key |
| `MINIO_BUCKET` | `documents` | Default bucket name |
| `MAX_FILE_SIZE` | `52428800` (50MB) | Maximum upload size in bytes |

### Storage Key Pattern

```
documents/                          # Bucket
  cases/
    {caseId}/                       # Grouped by case
      {documentId}/                 # Unique document ID
        {original-filename.pdf}     # Preserves original name
```

## Interfaces

### Document Service API

| Method | Signature | Returns |
|--------|-----------|---------|
| `init()` | `() => Promise<void>` | Creates bucket if missing |
| `uploadDocument` | `(caseId, file, uploadedBy?) => Promise<{ id, minioKey }>` | Document ID and storage key |
| `downloadDocument` | `(documentId) => Promise<{ stream, filename, mimetype, size }>` | Readable stream + metadata |
| `deleteDocument` | `(documentId) => Promise<void>` | Removes from MinIO + DB |
| `listDocuments` | `(caseId) => Promise<Object[]>` | Array of document metadata |

### Allowed File Types

| MIME Type | Extension |
|-----------|-----------|
| `application/pdf` | .pdf |
| `image/jpeg` | .jpg, .jpeg |
| `image/png` | .png |
| `image/tiff` | .tif, .tiff |
| `application/msword` | .doc |
| `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | .docx |

## Acceptance Criteria

- [ ] MinIO client connects using environment variables
- [ ] `documents` bucket is created on `init()` if it doesn't exist
- [ ] `uploadDocument` streams file to MinIO and inserts metadata row
- [ ] `downloadDocument` returns a readable stream and metadata for a valid document ID
- [ ] `deleteDocument` removes both the MinIO object and the DB row
- [ ] Files exceeding `MAX_FILE_SIZE` are rejected with 400
- [ ] Disallowed MIME types are rejected with 400
- [ ] If DB insert fails after MinIO upload, the orphaned file is cleaned up
- [ ] `listDocuments` returns all documents for a case, ordered by upload date

## Dependencies

- **Depends on**: #2 (Docker Compose — MinIO running), #3 (Database — `documents` table), #4 (Backend scaffold)
- **Blocks**: Document Analysis Agent (#53-#55 in Phase 2)

## Testing Strategy

1. **Init test**: `init()` creates bucket when it doesn't exist, is idempotent when it does
2. **Upload test**: Upload a PDF, verify MinIO object exists and DB row matches
3. **Download test**: Upload then download, verify stream content matches
4. **Delete test**: Upload then delete, verify MinIO object and DB row are gone
5. **Size limit test**: Upload a file exceeding limit, verify 400 rejection
6. **MIME type test**: Upload a disallowed type (e.g., `.exe`), verify 400 rejection
7. **Rollback test**: Mock DB failure after MinIO upload, verify MinIO object is cleaned up
8. **List test**: Upload 3 documents to a case, verify `listDocuments` returns all 3 in order
