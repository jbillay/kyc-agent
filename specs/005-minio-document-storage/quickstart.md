# Quickstart: MinIO Document Storage Service

**Branch**: `005-minio-document-storage`

## Prerequisites

- Docker and Docker Compose installed
- Node.js ≥ 22 installed

## 1. Start required services

```bash
# Start only the services this feature depends on
docker-compose up postgres redis minio
```

MinIO console will be available at `http://localhost:9001` (login: `minioadmin` / `minioadmin`).

## 2. Configure encryption at rest (local dev)

Add the following to the `minio` service in `docker-compose.yml` if not already present:

```yaml
environment:
  MINIO_KMS_AUTO_ENCRYPTION: "on"
```

Restart MinIO after this change:

```bash
docker-compose restart minio
```

## 3. Run the database migration

```bash
cd backend
DATABASE_URL=postgres://kyc:kyc@localhost:5432/kyc_agent npm run migrate:up
```

This applies the soft-delete migration, adding `deleted_at` and `deleted_by` columns to the `documents` table.

## 4. Set environment variables

Copy `.env.example` to `.env` (or set these in your shell):

```bash
# MinIO
MINIO_ENDPOINT=localhost
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_BUCKET=documents

# File limits
MAX_FILE_SIZE=52428800   # 50 MB

# Document retention (days)
DOCUMENT_RETENTION_DAYS=2555  # 7 years
```

## 5. Run the backend

```bash
cd backend
npm install
npm start
```

On startup, `document-service.init()` connects to MinIO and creates the `documents` bucket if absent.

## 6. Run the tests

```bash
cd backend
npm test
```

To run only document service tests:

```bash
cd backend
npx jest tests/backend/services/document-service.test.js
```

To run the document API integration tests:

```bash
cd backend
npx jest tests/backend/api/documents.test.js
```

## 7. Manual smoke test (curl)

**Upload**:
```bash
curl -X POST http://localhost:4000/api/v1/cases/<caseId>/documents \
  -F "file=@/path/to/sample.pdf"
```

**List**:
```bash
curl http://localhost:4000/api/v1/cases/<caseId>/documents
```

**Download**:
```bash
curl -O -J http://localhost:4000/api/v1/documents/<documentId>/download
```

**Delete**:
```bash
curl -X DELETE http://localhost:4000/api/v1/documents/<documentId>
```

## 8. Verify audit events

After any document operation, confirm an event was recorded:

```bash
docker-compose exec postgres psql -U kyc -d kyc_agent \
  -c "SELECT event_type, event_data FROM decision_events WHERE agent_type = 'document-service' ORDER BY created_at DESC LIMIT 5;"
```
