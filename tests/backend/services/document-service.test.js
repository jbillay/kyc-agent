'use strict';

const { Readable } = require('stream');

// ---------------------------------------------------------------------------
// Mocks — set up before requiring the module under test
// ---------------------------------------------------------------------------

const mockPutObject = jest.fn();
const mockGetObject = jest.fn();
const mockRemoveObject = jest.fn();
const mockBucketExists = jest.fn();
const mockMakeBucket = jest.fn();

jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation(() => ({
    putObject: mockPutObject,
    getObject: mockGetObject,
    removeObject: mockRemoveObject,
    bucketExists: mockBucketExists,
    makeBucket: mockMakeBucket,
  })),
}));

const mockQuery = jest.fn();
jest.mock('../../../backend/db/connection', () => ({ query: mockQuery }));

const mockEmit = jest.fn();
jest.mock('../../../backend/src/services/event-store', () => ({ emit: mockEmit }));

const documentService = require('../../../backend/src/services/document-service');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(overrides = {}) {
  return {
    filename: 'test.pdf',
    mimetype: 'application/pdf',
    size: 1024,
    stream: Readable.from(['PDF content']),
    ...overrides,
  };
}

const CASE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DOC_ID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

describe('init()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates the bucket when it does not exist', async () => {
    mockBucketExists.mockResolvedValue(false);
    mockMakeBucket.mockResolvedValue(undefined);

    await documentService.init();

    expect(mockBucketExists).toHaveBeenCalledTimes(1);
    expect(mockMakeBucket).toHaveBeenCalledTimes(1);
  });

  it('does not create the bucket when it already exists (idempotent)', async () => {
    mockBucketExists.mockResolvedValue(true);

    await documentService.init();

    expect(mockBucketExists).toHaveBeenCalledTimes(1);
    expect(mockMakeBucket).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// uploadDocument()
// ---------------------------------------------------------------------------

describe('uploadDocument()', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockBucketExists.mockResolvedValue(true);
    await documentService.init();
  });

  it('streams valid PDF to MinIO and inserts metadata row', async () => {
    mockPutObject.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ rows: [] });
    mockEmit.mockResolvedValue(undefined);

    const result = await documentService.uploadDocument(CASE_ID, makeFile(), USER_ID);

    expect(result).toMatchObject({ id: expect.any(String), minioKey: expect.stringContaining(`cases/${CASE_ID}/`) });
    expect(mockPutObject).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO documents'),
      expect.arrayContaining([CASE_ID, 'test.pdf', 'application/pdf'])
    );
  });

  it('rejects disallowed MIME type with 400 INVALID_FILE_TYPE before any MinIO call', async () => {
    await expect(
      documentService.uploadDocument(CASE_ID, makeFile({ mimetype: 'application/exe' }), USER_ID)
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_FILE_TYPE' });

    expect(mockPutObject).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('rejects oversized file with 400 FILE_TOO_LARGE before any MinIO call', async () => {
    const oversize = 51 * 1024 * 1024;
    await expect(
      documentService.uploadDocument(CASE_ID, makeFile({ size: oversize }), USER_ID)
    ).rejects.toMatchObject({ statusCode: 400, code: 'FILE_TOO_LARGE' });

    expect(mockPutObject).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('cleans up orphaned MinIO object when DB insert fails', async () => {
    mockPutObject.mockResolvedValue(undefined);
    mockRemoveObject.mockResolvedValue(undefined);
    const dbError = new Error('DB connection lost');
    mockQuery.mockRejectedValue(dbError);

    await expect(documentService.uploadDocument(CASE_ID, makeFile(), USER_ID)).rejects.toThrow('DB connection lost');

    expect(mockRemoveObject).toHaveBeenCalledTimes(1);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('retries once on transient MinIO error then succeeds', async () => {
    mockPutObject
      .mockRejectedValueOnce(new Error('transient network error'))
      .mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ rows: [] });
    mockEmit.mockResolvedValue(undefined);

    const result = await documentService.uploadDocument(CASE_ID, makeFile(), USER_ID);

    expect(result).toHaveProperty('id');
    expect(mockPutObject).toHaveBeenCalledTimes(2);
  });

  it('emits document_uploaded event with correct shape on success', async () => {
    mockPutObject.mockResolvedValue(undefined);
    mockQuery.mockResolvedValue({ rows: [] });
    mockEmit.mockResolvedValue(undefined);

    await documentService.uploadDocument(CASE_ID, makeFile(), USER_ID);

    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        caseId: CASE_ID,
        agentType: 'document-service',
        stepId: 'upload',
        eventType: 'document_uploaded',
        eventData: expect.objectContaining({
          case_id: CASE_ID,
          filename: 'test.pdf',
          mime_type: 'application/pdf',
          actor_id: USER_ID,
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// downloadDocument()
// ---------------------------------------------------------------------------

describe('downloadDocument()', () => {
  const dbRow = {
    filename: 'test.pdf',
    mime_type: 'application/pdf',
    size_bytes: 1024,
    minio_key: `cases/${CASE_ID}/${DOC_ID}/test.pdf`,
    case_id: CASE_ID,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockBucketExists.mockResolvedValue(true);
    await documentService.init();
  });

  it('returns stream and metadata for an active document', async () => {
    mockQuery.mockResolvedValue({ rows: [dbRow] });
    const fakeStream = Readable.from(['PDF']);
    mockGetObject.mockResolvedValue(fakeStream);
    mockEmit.mockResolvedValue(undefined);

    const result = await documentService.downloadDocument(DOC_ID, USER_ID);

    expect(result).toMatchObject({
      stream: fakeStream,
      filename: 'test.pdf',
      mimetype: 'application/pdf',
      size: 1024,
    });
    expect(mockGetObject).toHaveBeenCalledTimes(1);
  });

  it('throws 404 NOT_FOUND for a soft-deleted or non-existent document', async () => {
    mockQuery.mockResolvedValue({ rows: [] }); // WHERE deleted_at IS NULL yields nothing

    await expect(documentService.downloadDocument(DOC_ID, USER_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
    expect(mockGetObject).not.toHaveBeenCalled();
  });

  it('emits document_downloaded event with correct shape on success', async () => {
    mockQuery.mockResolvedValue({ rows: [dbRow] });
    mockGetObject.mockResolvedValue(Readable.from(['PDF']));
    mockEmit.mockResolvedValue(undefined);

    await documentService.downloadDocument(DOC_ID, USER_ID);

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'document_downloaded',
        eventData: expect.objectContaining({
          document_id: DOC_ID,
          case_id: CASE_ID,
          actor_id: USER_ID,
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// deleteDocument()
// ---------------------------------------------------------------------------

describe('deleteDocument()', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockBucketExists.mockResolvedValue(true);
    await documentService.init();
  });

  it('soft-deletes an active document by setting deleted_at and deleted_by', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: DOC_ID, case_id: CASE_ID }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] }); // UPDATE
    mockEmit.mockResolvedValue(undefined);

    await documentService.deleteDocument(DOC_ID, USER_ID);

    expect(mockQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE documents SET deleted_at'),
      expect.arrayContaining([DOC_ID, USER_ID])
    );
    expect(mockRemoveObject).not.toHaveBeenCalled();
  });

  it('throws 404 NOT_FOUND for already-deleted or non-existent document', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(documentService.deleteDocument(DOC_ID, USER_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: 'NOT_FOUND',
    });
    expect(mockRemoveObject).not.toHaveBeenCalled();
  });

  it('emits document_deleted event with correct shape on success', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: DOC_ID, case_id: CASE_ID }] })
      .mockResolvedValueOnce({ rows: [] });
    mockEmit.mockResolvedValue(undefined);

    await documentService.deleteDocument(DOC_ID, USER_ID);

    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'document_deleted',
        eventData: expect.objectContaining({
          document_id: DOC_ID,
          case_id: CASE_ID,
          actor_id: USER_ID,
        }),
      })
    );
  });

  it('does NOT remove the object from MinIO (file retained for regulatory retention)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: DOC_ID, case_id: CASE_ID }] })
      .mockResolvedValueOnce({ rows: [] });
    mockEmit.mockResolvedValue(undefined);

    await documentService.deleteDocument(DOC_ID, USER_ID);

    expect(mockRemoveObject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listDocuments()
// ---------------------------------------------------------------------------

describe('listDocuments()', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockBucketExists.mockResolvedValue(true);
    await documentService.init();
  });

  it('returns all active documents for a case ordered by uploaded_at DESC', async () => {
    const rows = [
      { id: '1', filename: 'c.pdf', uploaded_at: new Date('2026-01-03') },
      { id: '2', filename: 'b.pdf', uploaded_at: new Date('2026-01-02') },
      { id: '3', filename: 'a.pdf', uploaded_at: new Date('2026-01-01') },
    ];
    mockQuery.mockResolvedValue({ rows });

    const result = await documentService.listDocuments(CASE_ID);

    expect(result).toHaveLength(3);
    expect(result[0].filename).toBe('c.pdf');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('deleted_at IS NULL'),
      [CASE_ID]
    );
  });

  it('returns an empty array when a case has no documents', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const result = await documentService.listDocuments(CASE_ID);

    expect(result).toEqual([]);
  });

  it('excludes soft-deleted documents (WHERE deleted_at IS NULL enforced by query)', async () => {
    // The query itself applies the filter; we verify the WHERE clause is present
    mockQuery.mockResolvedValue({ rows: [{ id: '1', filename: 'active.pdf' }] });

    await documentService.listDocuments(CASE_ID);

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('AND deleted_at IS NULL'),
      expect.any(Array)
    );
  });
});
