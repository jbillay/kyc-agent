'use strict';

/**
 * Add screening_sync_events table — append-only audit log for sanctions list sync runs.
 *
 * Sync runs are infrastructure events not tied to a specific KYC case, so they
 * cannot use the decision_events table (which requires a non-null case_id FK).
 * This table mirrors the append-only enforcement pattern from decision_events via
 * PostgreSQL rules that silently discard UPDATE and DELETE operations.
 *
 * Regulatory context: BSA/AML and FATF Recommendation 6 require evidence that
 * sanctions screening is performed against current lists. Recording every sync
 * outcome here provides an auditable trail of when lists were updated.
 */

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.up = (pgm) => {
  pgm.createTable('screening_sync_events', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    list_name: {
      type: 'varchar(100)',
      notNull: true,
    },
    status: {
      type: 'varchar(30)',
      notNull: true,
      check: "status IN ('success','failure','stale_detected')",
    },
    entries_added: {
      type: 'integer',
      notNull: true,
      default: 0,
    },
    entries_removed: {
      type: 'integer',
      notNull: true,
      default: 0,
    },
    entries_modified: {
      type: 'integer',
      notNull: true,
      default: 0,
    },
    error_message: {
      type: 'text',
      notNull: false,
    },
    attempt_number: {
      type: 'integer',
      notNull: true,
      default: 1,
    },
    started_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('NOW()'),
    },
    completed_at: {
      type: 'timestamptz',
      notNull: false,
    },
    sequence_number: {
      type: 'bigserial',
      notNull: true,
    },
  });

  pgm.createIndex('screening_sync_events', ['list_name', 'started_at'], {
    name: 'idx_sync_events_list_name',
    order: { started_at: 'DESC' },
  });

  // Append-only enforcement: silently discard UPDATE and DELETE attempts.
  pgm.sql(`
    CREATE OR REPLACE RULE no_update_sync_events AS
      ON UPDATE TO screening_sync_events DO INSTEAD NOTHING;

    CREATE OR REPLACE RULE no_delete_sync_events AS
      ON DELETE TO screening_sync_events DO INSTEAD NOTHING;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
exports.down = (pgm) => {
  pgm.sql(`
    DROP RULE IF EXISTS no_update_sync_events ON screening_sync_events;
    DROP RULE IF EXISTS no_delete_sync_events ON screening_sync_events;
  `);
  pgm.dropIndex('screening_sync_events', ['list_name', 'started_at'], {
    name: 'idx_sync_events_list_name',
  });
  pgm.dropTable('screening_sync_events');
};
