'use strict';

const documentService = require('../services/document-service');

// ---------------------------------------------------------------------------
// JSON Schema helpers
// ---------------------------------------------------------------------------

const uuidParam = { type: 'string', format: 'uuid' };

const documentMetaSchema = {
  type: 'object',
  properties: {
    id:              { type: 'string', format: 'uuid' },
    filename:        { type: 'string' },
    mime_type:       { type: 'string' },
    size_bytes:      { type: 'integer' },
    document_type:   { type: ['string', 'null'] },
    analysis_status: { type: 'string', enum: ['pending', 'analyzing', 'analyzed', 'failed'] },
    uploaded_at:     { type: 'string' },
  },
  required: ['id', 'filename', 'mime_type', 'size_bytes', 'analysis_status', 'uploaded_at'],
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * Cases API routes.
 * Registered with prefix `/api/v1` in backend/src/index.js.
 *
 * Exposes document management endpoints:
 *   POST   /cases/:caseId/documents          — upload document
 *   GET    /cases/:caseId/documents          — list documents for a case
 *   GET    /documents/:documentId/download   — download document stream
 *   DELETE /documents/:documentId            — soft-delete document
 *
 * @param {import('fastify').FastifyInstance} fastify
 */
async function casesPlugin(fastify) {
  // ── POST /cases/:caseId/documents ────────────────────────────────────────
  fastify.post(
    '/cases/:caseId/documents',
    {
      schema: {
        params: {
          type: 'object',
          properties: { caseId: uuidParam },
          required: ['caseId'],
        },
      },
    },
    async (request, reply) => {
      const { caseId } = request.params;
      const actorId = request.user?.id ?? null;

      const part = await request.file();
      if (!part) {
        return reply.status(400).send({
          error: { code: 'NO_FILE', message: 'No file part found in request' },
        });
      }

      const file = {
        filename: part.filename,
        mimetype: part.mimetype,
        // Size comes from the multipart metadata field if provided by the client;
        // otherwise fall back to Content-Length (may be absent for chunked transfers).
        size: parseInt(
          (part.fields && part.fields.size && part.fields.size.value) ||
          request.headers['content-length'] ||
          '0',
          10
        ),
        stream: part.file,
      };

      const result = await documentService.uploadDocument(caseId, file, actorId);
      return reply.status(201).send(result);
    }
  );

  // ── GET /cases/:caseId/documents ─────────────────────────────────────────
  fastify.get(
    '/cases/:caseId/documents',
    {
      schema: {
        params: {
          type: 'object',
          properties: { caseId: uuidParam },
          required: ['caseId'],
        },
        response: {
          200: {
            type: 'array',
            items: documentMetaSchema,
          },
        },
      },
    },
    async (request, reply) => {
      const { caseId } = request.params;
      const documents = await documentService.listDocuments(caseId);
      return reply.status(200).send(documents);
    }
  );

  // ── GET /documents/:documentId/download ──────────────────────────────────
  fastify.get(
    '/documents/:documentId/download',
    {
      schema: {
        params: {
          type: 'object',
          properties: { documentId: uuidParam },
          required: ['documentId'],
        },
      },
    },
    async (request, reply) => {
      const { documentId } = request.params;
      const actorId = request.user?.id ?? null;

      const { stream, filename, mimetype, size } = await documentService.downloadDocument(
        documentId,
        actorId
      );

      reply
        .status(200)
        .header('Content-Type', mimetype)
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Content-Length', String(size));

      return reply.send(stream);
    }
  );

  // ── DELETE /documents/:documentId ────────────────────────────────────────
  fastify.delete(
    '/documents/:documentId',
    {
      schema: {
        params: {
          type: 'object',
          properties: { documentId: uuidParam },
          required: ['documentId'],
        },
      },
    },
    async (request, reply) => {
      const { documentId } = request.params;
      const actorId = request.user?.id ?? null;

      await documentService.deleteDocument(documentId, actorId);
      return reply.status(204).send();
    }
  );
}

module.exports = casesPlugin;
