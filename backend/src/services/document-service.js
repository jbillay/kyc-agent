'use strict';

const { Client: MinioClient } = require('minio');
const { randomUUID } = require('crypto');
const { query } = require('../../db/connection');
const { emit } = require('./event-store');

const BUCKET = process.env.MINIO_BUCKET || 'documents';
const MAX_FILE_SIZE = parseInt(process.env.MAX_FILE_SIZE || String(50 * 1024 * 1024), 10); // 50 MB

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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Retry an async operation with exponential backoff.
 * Attempts: 1 (immediate), 2 (200ms delay), 3 (400ms delay).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} [maxAttempts=3]
 * @returns {Promise<T>}
 */
async function withRetry(fn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the MinIO client and ensure the documents bucket exists.
 * Must be called once during application startup before serving requests.
 *
 * @returns {Promise<void>}
 */
async function init() {
  minio = new MinioClient({
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000', 10),
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
 * Upload a document to MinIO and record its metadata in PostgreSQL.
 * Emits a `document_uploaded` event to the audit event store.
 *
 * The file is streamed directly to MinIO — no in-memory buffering of file bytes.
 * If the PostgreSQL insert fails after a successful MinIO upload, the orphaned
 * object is cleaned up automatically.
 *
 * @param {string} caseId                    - UUID of the owning case
 * @param {Object} file
 * @param {string} file.filename             - Original filename
 * @param {string} file.mimetype             - MIME type
 * @param {number} file.size                 - Size in bytes (caller-provided)
 * @param {import('stream').Readable} file.stream - File data stream
 * @param {string|null} [uploadedBy]         - UUID of the uploading user
 * @returns {Promise<{ id: string, minioKey: string }>}
 */
async function uploadDocument(caseId, file, uploadedBy) {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw Object.assign(
      new Error(`File type '${file.mimetype}' is not allowed`),
      { statusCode: 400, code: 'INVALID_FILE_TYPE' }
    );
  }

  if (file.size > MAX_FILE_SIZE) {
    throw Object.assign(
      new Error(`File exceeds maximum size of ${MAX_FILE_SIZE / 1024 / 1024}MB`),
      { statusCode: 400, code: 'FILE_TOO_LARGE' }
    );
  }

  const documentId = randomUUID();
  const minioKey = `cases/${caseId}/${documentId}/${file.filename}`;

  await withRetry(() =>
    minio.putObject(BUCKET, minioKey, file.stream, file.size, {
      'Content-Type': file.mimetype,
    })
  );

  try {
    await query(
      `INSERT INTO documents (id, case_id, filename, mime_type, size_bytes, minio_key, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [documentId, caseId, file.filename, file.mimetype, file.size, minioKey, uploadedBy ?? null]
    );
  } catch (dbError) {
    await withRetry(() => minio.removeObject(BUCKET, minioKey)).catch(() => {});
    throw dbError;
  }

  await emit({
    caseId,
    agentType: 'document-service',
    stepId: 'upload',
    eventType: 'document_uploaded',
    eventData: {
      document_id: documentId,
      case_id: caseId,
      filename: file.filename,
      mime_type: file.mimetype,
      size_bytes: file.size,
      actor_id: uploadedBy ?? null,
    },
  });

  return { id: documentId, minioKey };
}

/**
 * Download a document by its database ID.
 * Returns the file stream from MinIO plus metadata from PostgreSQL.
 * Only active (non-deleted) documents can be downloaded.
 * Emits a `document_downloaded` event to the audit event store.
 *
 * @param {string} documentId               - UUID of the document
 * @param {string|null} [actorId]           - UUID of the requesting user
 * @returns {Promise<{ stream: import('stream').Readable, filename: string, mimetype: string, size: number }>}
 */
async function downloadDocument(documentId, actorId) {
  const result = await query(
    `SELECT filename, mime_type, size_bytes, minio_key, case_id
     FROM documents
     WHERE id = $1 AND deleted_at IS NULL`,
    [documentId]
  );

  if (result.rows.length === 0) {
    throw Object.assign(new Error('Document not found'), {
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  }

  const doc = result.rows[0];
  const stream = await withRetry(() => minio.getObject(BUCKET, doc.minio_key));

  await emit({
    caseId: doc.case_id,
    agentType: 'document-service',
    stepId: 'download',
    eventType: 'document_downloaded',
    eventData: {
      document_id: documentId,
      case_id: doc.case_id,
      filename: doc.filename,
      mime_type: doc.mime_type,
      size_bytes: doc.size_bytes,
      actor_id: actorId ?? null,
    },
  });

  return {
    stream,
    filename: doc.filename,
    mimetype: doc.mime_type,
    size: doc.size_bytes,
  };
}

/**
 * Soft-delete a document by marking its metadata record as deleted.
 * The file in MinIO is retained per the regulatory retention policy (default 7 years).
 * Only active (non-deleted) documents can be deleted.
 * Emits a `document_deleted` event to the audit event store.
 *
 * @param {string} documentId       - UUID of the document
 * @param {string|null} [deletedBy] - UUID of the deleting user
 * @returns {Promise<void>}
 */
async function deleteDocument(documentId, deletedBy) {
  const result = await query(
    `SELECT id, case_id FROM documents WHERE id = $1 AND deleted_at IS NULL`,
    [documentId]
  );

  if (result.rows.length === 0) {
    throw Object.assign(new Error('Document not found'), {
      statusCode: 404,
      code: 'NOT_FOUND',
    });
  }

  const doc = result.rows[0];

  await query(
    `UPDATE documents SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`,
    [documentId, deletedBy ?? null]
  );

  await emit({
    caseId: doc.case_id,
    agentType: 'document-service',
    stepId: 'delete',
    eventType: 'document_deleted',
    eventData: {
      document_id: documentId,
      case_id: doc.case_id,
      actor_id: deletedBy ?? null,
    },
  });
}

/**
 * List all active (non-deleted) documents for a case, ordered newest first.
 *
 * @param {string} caseId - UUID of the case
 * @returns {Promise<Object[]>}
 */
async function listDocuments(caseId) {
  const result = await query(
    `SELECT id, filename, mime_type, size_bytes, document_type, analysis_status, uploaded_at
     FROM documents
     WHERE case_id = $1 AND deleted_at IS NULL
     ORDER BY uploaded_at DESC`,
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
