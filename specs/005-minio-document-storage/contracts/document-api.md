# API Contracts: Document Endpoints

**Branch**: `005-minio-document-storage` | **Phase**: 1 | **Date**: 2026-04-09  
**Registered under**: `backend/src/api/cases.js` (prefix: `/api/v1`)  
**Validation**: Fastify JSON Schema on all request/response shapes

---

## POST /api/v1/cases/:caseId/documents

Upload a document to a KYC case.

**Content-Type**: `multipart/form-data`

**Path parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `caseId` | UUID string | Yes | ID of the owning case |

**Multipart fields**:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file | Yes | The document file (streamed, not buffered) |

**Request schema** (Fastify `params`):
```json
{
  "type": "object",
  "properties": {
    "caseId": { "type": "string", "format": "uuid" }
  },
  "required": ["caseId"]
}
```

**Success response** — `201 Created`:
```json
{
  "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "minioKey": "cases/550e.../f47a.../certificate.pdf"
}
```

**Error responses**:

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `INVALID_FILE_TYPE` | MIME type not in allowed set |
| 400 | `FILE_TOO_LARGE` | File size exceeds configured maximum |
| 404 | `CASE_NOT_FOUND` | `caseId` does not exist |
| 503 | `STORAGE_UNAVAILABLE` | MinIO unreachable after retries |

---

## GET /api/v1/cases/:caseId/documents

List all active (non-deleted) documents for a case.

**Path parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `caseId` | UUID string | Yes | ID of the case |

**Success response** — `200 OK`:
```json
[
  {
    "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    "filename": "certificate-of-incorporation.pdf",
    "mimeType": "application/pdf",
    "sizeBytes": 204800,
    "documentType": null,
    "analysisStatus": "pending",
    "uploadedAt": "2026-04-09T10:00:00Z"
  }
]
```

**Response schema** (Fastify `response[200]`):
```json
{
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "id":             { "type": "string", "format": "uuid" },
      "filename":       { "type": "string" },
      "mimeType":       { "type": "string" },
      "sizeBytes":      { "type": "integer" },
      "documentType":   { "type": ["string", "null"] },
      "analysisStatus": { "type": "string", "enum": ["pending","analyzing","analyzed","failed"] },
      "uploadedAt":     { "type": "string", "format": "date-time" }
    },
    "required": ["id","filename","mimeType","sizeBytes","analysisStatus","uploadedAt"]
  }
}
```

**Notes**: Deleted documents (`deleted_at IS NOT NULL`) are excluded. Returns empty array (not 404) when no documents exist.

---

## GET /api/v1/documents/:documentId/download

Download a document file by its ID. Returns the raw file stream.

**Path parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | UUID string | Yes | ID of the document |

**Success response** — `200 OK`:
- `Content-Type`: document's `mime_type` value
- `Content-Disposition`: `attachment; filename="{filename}"`
- `Content-Length`: document's `size_bytes` value
- Body: raw file stream (piped from MinIO)

**Error responses**:

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `NOT_FOUND` | Document ID does not exist or document is soft-deleted |
| 503 | `STORAGE_UNAVAILABLE` | MinIO unreachable after retries |

---

## DELETE /api/v1/documents/:documentId

Soft-delete a document. Marks the record as deleted; file is retained in storage.

**Path parameters**:

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `documentId` | UUID string | Yes | ID of the document |

**Success response** — `204 No Content` (empty body)

**Error responses**:

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `NOT_FOUND` | Document ID does not exist or already deleted |

---

## Common Error Envelope

All error responses follow the Fastify error handler shape defined in `backend/src/index.js`:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable description"
  }
}
```
