# Research: MinIO Document Storage Service

**Branch**: `005-minio-document-storage` | **Phase**: 0 | **Date**: 2026-04-09

## Decision 1: MinIO Node.js SDK API (v8)

**Decision**: Use the `minio` npm package v8. The core API used in this feature (`new Client(opts)`, `bucketExists`, `makeBucket`, `putObject`, `getObject`, `removeObject`) is stable across v7 and v8. No breaking changes affect these methods.

**Rationale**: The project already declares `minio: ^8.0.0` in `package.json`. The client constructor accepts `{ endPoint, port, useSSL, accessKey, secretKey }`. `putObject(bucket, key, stream, size, metadata)` streams directly to MinIO without buffering.

**Alternatives considered**: AWS SDK v3 S3 client (compatible with MinIO S3 API) — rejected because the native MinIO SDK is already declared as a dependency and provides a simpler interface for this use case.

---

## Decision 2: Retry Strategy for Transient Storage Failures

**Decision**: Implement a lightweight inline `withRetry(fn, maxAttempts=3)` utility within `document-service.js`. No additional npm dependency required.

**Implementation pattern**:
```js
async function withRetry(fn, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise(r => setTimeout(r, 200 * 2 ** (attempt - 1)));
    }
  }
}
```
Backoff: 200ms, 400ms, then fail. Total max wait: ~600ms before giving up — acceptable for a Docker-internal network.

**Rationale**: Adding a dedicated retry library (e.g., `p-retry`, `async-retry`) for a 6-line pattern would be over-engineering. The retry applies only to MinIO operations, not to DB operations (which have their own connection-pool retry semantics).

**Alternatives considered**: `p-retry` npm package — rejected to avoid adding a dependency for a trivial pattern. `bullmq` job-level retry — rejected because this is a synchronous service call, not a background job.

---

## Decision 3: Emitting Events to `decision_events` from a Non-Agent Context

**Decision**: Use `agent_type = 'document-service'` and `step_id` equal to the operation name (`'upload'`, `'download'`, `'delete'`). The `event-store.js` service will expose a generic `emit(event)` function that the document service calls.

**Convention**:
```js
// event_data shape for document events
{
  document_id: '<uuid>',
  case_id: '<uuid>',
  filename: '<string>',
  mime_type: '<string>',
  size_bytes: <number>,
  actor_id: '<uuid | null>'
}
```

**Rationale**: The constitution requires every significant action to be recorded in `decision_events`. The table's `agent_type` and `step_id` columns are NOT NULL but have no CHECK constraint limiting values — using `'document-service'` as `agent_type` is valid and consistent with the spirit of the audit requirement. The `case_id` is available for all three operations (upload receives it directly; download and delete retrieve it from the documents row before acting).

**Alternatives considered**: A separate `document_events` table — rejected because the constitution explicitly requires the append-only `decision_events` table as the single audit stream. Logging to application logs only — rejected (violates FR-014 and the constitution).

---

## Decision 4: Encryption at Rest

**Decision**: MinIO Server-Side Encryption with auto-encryption enabled at the server level (`MINIO_KMS_AUTO_ENCRYPTION=on`). No client-side changes are required — MinIO encrypts all objects transparently when auto-encryption is enabled.

**MinIO environment variables required** (added to `docker-compose.yml` MinIO service):
```yaml
MINIO_KMS_AUTO_ENCRYPTION: "on"
MINIO_KMS_KES_ENDPOINT: ""      # Leave empty to use MinIO's built-in key management
```

For the local dev stack, MinIO's built-in KMS (no external KES server) is sufficient. Production deployments should configure an external KES endpoint.

**Rationale**: SSE at the server level is the correct abstraction — it requires zero application code changes and enforces encryption for all objects in all buckets regardless of which client uploads them.

**Alternatives considered**: SSE-C (client-provided keys) — rejected because it requires the application to manage and transmit encryption keys on every request, adding significant complexity. Application-level encryption before upload — rejected because it breaks streaming and increases memory pressure.

---

## Decision 5: Schema Migration for Soft Delete

**Decision**: Create a `node-pg-migrate` migration file that adds `deleted_at TIMESTAMPTZ` and `deleted_by UUID REFERENCES users(id)` to the `documents` table. This overrides the original assumption that "this feature does not manage schema migrations."

**Rationale**: The soft-delete clarification (Q2 in the clarification session) introduced new columns that did not exist when the original spec assumption was written. The assumption must be corrected. The migration is additive (new nullable columns) and non-destructive.

**Migration file**: `backend/db/migrations/{timestamp}_add-soft-delete-to-documents.js`

**Alternatives considered**: Handle soft delete via a separate `deleted_documents` table — rejected because it complicates queries and the existing `documents` table is the natural place for this state.

---

## Decision 6: Fastify Multipart Streaming

**Decision**: Use `@fastify/multipart` (already in `package.json` at v9) with `file.toBuffer()` avoided in favour of `file.file` (the raw `busboy` Readable stream) to satisfy the no-buffering requirement.

**Route registration**:
```js
app.register(require('@fastify/multipart'), {
  limits: { fileSize: MAX_FILE_SIZE }
});
```

**Rationale**: `@fastify/multipart` v9 exposes the raw stream via `part.file`, enabling true streaming to MinIO without materialising the file in memory. The `limits.fileSize` option at the multipart layer provides an additional server-side guard complementing the service-level validation.

**Alternatives considered**: `busboy` directly — rejected because `@fastify/multipart` is already a declared dependency and wraps `busboy` with Fastify-idiomatic integration.
