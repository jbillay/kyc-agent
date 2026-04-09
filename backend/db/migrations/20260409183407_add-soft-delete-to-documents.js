'use strict';

/**
 * Add soft-delete support to the documents table.
 *
 * Adds two nullable columns:
 *   deleted_at  — timestamp when the document was soft-deleted (NULL = active)
 *   deleted_by  — UUID of the user who deleted it (FK → users)
 *
 * Also adds a partial index covering only active (non-deleted) rows to keep
 * list and download queries fast without penalising the retained deleted rows.
 *
 * Regulatory context: Money Laundering Regulations 2017 and FATF Recommendation 11
 * require retention of KYC records for a minimum of 5 years after relationship end.
 * Files are retained in MinIO; this migration supports soft deletion of metadata
 * while preserving the audit trail.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.addColumns('documents', {
    deleted_at: {
      type: 'timestamptz',
      notNull: false,
    },
    deleted_by: {
      type: 'uuid',
      notNull: false,
      references: '"users"',
      onDelete: 'SET NULL',
    },
  });

  // Partial index: only active documents are included, keeping the index small
  // and list/download queries on active documents fast.
  pgm.createIndex('documents', 'deleted_at', {
    name: 'idx_documents_deleted_at',
    where: 'deleted_at IS NULL',
  });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.dropIndex('documents', 'deleted_at', { name: 'idx_documents_deleted_at' });
  pgm.dropColumns('documents', ['deleted_at', 'deleted_by']);
};
