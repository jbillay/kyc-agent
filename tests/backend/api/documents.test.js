'use strict';

const { Readable } = require('stream');

// ---------------------------------------------------------------------------
// Mock document service before requiring buildServer.
// jest.mock() is hoisted before require() calls, so the mocked module is in
// place when buildServer() is imported and when documentService.init() is
// called inside buildServer().
// ---------------------------------------------------------------------------

const mockUploadDocument = jest.fn();
const mockDownloadDocument = jest.fn();
const mockDeleteDocument = jest.fn();
const mockListDocuments = jest.fn();
const mockInit = jest.fn();

jest.mock('../../../backend/src/services/document-service', () => ({
  init: mockInit,
  uploadDocument: mockUploadDocument,
  downloadDocument: mockDownloadDocument,
  deleteDocument: mockDeleteDocument,
  listDocuments: mockListDocuments,
}));

const { buildServer } = require('../../../backend/src/index');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CASE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DOC_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** Build a minimal valid multipart/form-data body with one file part. */
function makeMultipartPayload(filename, contentType, content) {
  const boundary = '----TestBoundary001';
  const body = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="file"; filename="${filename}"`,
    `Content-Type: ${contentType}`,
    '',
    content,
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

// ---------------------------------------------------------------------------
// Setup — single app instance reused across all tests
// ---------------------------------------------------------------------------

let app;

beforeAll(async () => {
  mockInit.mockResolvedValue(undefined);
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Re-stub init so any accidental re-build doesn't hang
  mockInit.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// POST /api/v1/cases/:caseId/documents — Upload
// ---------------------------------------------------------------------------

describe('POST /api/v1/cases/:caseId/documents', () => {
  it('returns 201 with { id, minioKey } for a valid upload', async () => {
    mockUploadDocument.mockResolvedValue({
      id: DOC_ID,
      minioKey: `cases/${CASE_ID}/${DOC_ID}/test.pdf`,
    });

    const { body, contentType } = makeMultipartPayload('test.pdf', 'application/pdf', 'PDF content');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/cases/${CASE_ID}/documents`,
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(201);
    const result = JSON.parse(response.body);
    expect(result).toHaveProperty('id', DOC_ID);
    expect(result).toHaveProperty('minioKey');
    expect(mockUploadDocument).toHaveBeenCalledTimes(1);
  });

  it('returns 400 INVALID_FILE_TYPE when service rejects the MIME type', async () => {
    mockUploadDocument.mockRejectedValue(
      Object.assign(new Error('File type not allowed'), {
        statusCode: 400,
        code: 'INVALID_FILE_TYPE',
      })
    );

    const { body, contentType } = makeMultipartPayload('malware.exe', 'application/octet-stream', 'content');

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/cases/${CASE_ID}/documents`,
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('INVALID_FILE_TYPE');
  });

  it('returns 400 FILE_TOO_LARGE when service rejects the file size', async () => {
    mockUploadDocument.mockRejectedValue(
      Object.assign(new Error('File too large'), {
        statusCode: 400,
        code: 'FILE_TOO_LARGE',
      })
    );

    const { body, contentType } = makeMultipartPayload('huge.pdf', 'application/pdf', 'x'.repeat(100));

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/cases/${CASE_ID}/documents`,
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).error.code).toBe('FILE_TOO_LARGE');
  });

  it('returns 400 for an invalid caseId (not a UUID)', async () => {
    const { body, contentType } = makeMultipartPayload('test.pdf', 'application/pdf', 'content');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cases/not-a-uuid/documents',
      headers: { 'content-type': contentType },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/cases/:caseId/documents — List
// ---------------------------------------------------------------------------

describe('GET /api/v1/cases/:caseId/documents', () => {
  it('returns 200 with an array of document metadata', async () => {
    mockListDocuments.mockResolvedValue([
      {
        id: DOC_ID,
        filename: 'test.pdf',
        mime_type: 'application/pdf',
        size_bytes: 1024,
        document_type: null,
        analysis_status: 'pending',
        uploaded_at: new Date('2026-04-09T10:00:00Z'),
      },
    ]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/cases/${CASE_ID}/documents`,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0]).toHaveProperty('id', DOC_ID);
    expect(body[0]).toHaveProperty('filename', 'test.pdf');
  });

  it('returns 200 with empty array for a case with no documents', async () => {
    mockListDocuments.mockResolvedValue([]);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/cases/${CASE_ID}/documents`,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual([]);
  });

  it('returns 400 for an invalid caseId', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/cases/not-a-uuid/documents',
    });

    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/documents/:documentId/download — Download
// ---------------------------------------------------------------------------

describe('GET /api/v1/documents/:documentId/download', () => {
  it('returns 200 with Content-Disposition and Content-Type headers', async () => {
    mockDownloadDocument.mockResolvedValue({
      stream: Readable.from(['PDF content']),
      filename: 'test.pdf',
      mimetype: 'application/pdf',
      size: 11,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${DOC_ID}/download`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-disposition']).toContain('test.pdf');
  });

  it('returns 404 for a deleted or non-existent document', async () => {
    mockDownloadDocument.mockRejectedValue(
      Object.assign(new Error('Document not found'), {
        statusCode: 404,
        code: 'NOT_FOUND',
      })
    );

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/documents/${DOC_ID}/download`,
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for an invalid documentId', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/documents/not-a-uuid/download',
    });

    expect(response.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/v1/documents/:documentId — Delete
// ---------------------------------------------------------------------------

describe('DELETE /api/v1/documents/:documentId', () => {
  it('returns 204 with no body for a successful soft delete', async () => {
    mockDeleteDocument.mockResolvedValue(undefined);

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${DOC_ID}`,
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
  });

  it('returns 404 for a non-existent or already-deleted document', async () => {
    mockDeleteDocument.mockRejectedValue(
      Object.assign(new Error('Document not found'), {
        statusCode: 404,
        code: 'NOT_FOUND',
      })
    );

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/v1/documents/${DOC_ID}`,
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error.code).toBe('NOT_FOUND');
  });

  it('returns 400 for an invalid documentId', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/documents/not-a-uuid',
    });

    expect(response.statusCode).toBe(400);
  });
});
