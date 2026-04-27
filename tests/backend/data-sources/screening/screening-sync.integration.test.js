'use strict';

/**
 * Integration tests for OFAC SDN ingestion.
 *
 * These tests require a running PostgreSQL instance (DATABASE_URL env var).
 * They are skipped automatically when DATABASE_URL is not set so they do not
 * block CI environments that lack a live database.
 *
 * Run manually: cd backend && npx jest screening-sync.integration.test.js
 */

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

describeIfDb('screening_sync_events append-only enforcement', () => {
  let pool;

  beforeAll(async () => {
    const pg = require('pg');
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    // Ensure table exists (schema may already be applied via docker-compose)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS screening_sync_events (
        id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        list_name        VARCHAR(100) NOT NULL,
        status           VARCHAR(30)  NOT NULL
                           CHECK (status IN ('success','failure','stale_detected')),
        entries_added    INTEGER      NOT NULL DEFAULT 0,
        entries_removed  INTEGER      NOT NULL DEFAULT 0,
        entries_modified INTEGER      NOT NULL DEFAULT 0,
        error_message    TEXT,
        attempt_number   INTEGER      NOT NULL DEFAULT 1,
        started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        completed_at     TIMESTAMPTZ,
        sequence_number  BIGSERIAL    NOT NULL
      )
    `);
    await pool.query(`
      CREATE OR REPLACE RULE no_update_sync_events AS
        ON UPDATE TO screening_sync_events DO INSTEAD NOTHING;
      CREATE OR REPLACE RULE no_delete_sync_events AS
        ON DELETE TO screening_sync_events DO INSTEAD NOTHING;
    `);
  });

  afterAll(async () => {
    await pool.end();
  });

  test('inserted row is preserved after attempted UPDATE', async () => {
    const insertResult = await pool.query(
      `INSERT INTO screening_sync_events
         (list_name, status, entries_added, entries_removed, entries_modified)
       VALUES ('OFAC-SDN', 'success', 100, 5, 10)
       RETURNING id, entries_added`
    );
    const { id, entries_added: originalCount } = insertResult.rows[0];

    // Attempt UPDATE — should be silently discarded by the PostgreSQL rule
    await pool.query(
      `UPDATE screening_sync_events SET entries_added = 9999 WHERE id = $1`,
      [id]
    );

    const checkResult = await pool.query(
      `SELECT entries_added FROM screening_sync_events WHERE id = $1`,
      [id]
    );
    expect(checkResult.rows[0].entries_added).toBe(originalCount);

    // Cleanup
    await pool.query(`DELETE FROM screening_sync_events WHERE id = $1`, [id]);
    const afterDelete = await pool.query(
      `SELECT id FROM screening_sync_events WHERE id = $1`,
      [id]
    );
    // DELETE is also silently discarded — row should still exist
    expect(afterDelete.rows).toHaveLength(1);

    // Hard-cleanup via TRUNCATE so the test doesn't leave rows
    await pool.query(`TRUNCATE screening_sync_events`);
  });

  test('OFACProvider.updateList() stores entries and writes audit event', async () => {
    const { OFACProvider } = require('../../../../backend/src/data-sources/screening/ofac');

    // Minimal FuzzyMatcher stub
    const fuzzyMatcher = { threshold: 70, compare: () => { throw new Error('not impl'); } };

    const sampleXml = `<?xml version="1.0"?>
      <sdnList>
        <sdnEntry>
          <uid>integration-test-1</uid>
          <sdnType>Individual</sdnType>
          <lastName>INTEGRATION</lastName>
          <firstName>TEST</firstName>
          <programList><program>TEST</program></programList>
        </sdnEntry>
      </sdnList>`;

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(sampleXml),
    });

    const provider = new OFACProvider(
      { sourceUrl: 'https://example.com/test.xml' },
      fuzzyMatcher
    );

    const result = await provider.updateList();

    expect(result.entriesAdded).toBe(1);
    expect(result.entriesRemoved).toBe(0);

    // Verify sync event was recorded
    const syncEvents = await pool.query(
      `SELECT * FROM screening_sync_events WHERE list_name = 'OFAC-SDN' ORDER BY started_at DESC LIMIT 1`
    );
    expect(syncEvents.rows.length).toBeGreaterThan(0);
    expect(syncEvents.rows[0].status).toBe('success');
    expect(syncEvents.rows[0].entries_added).toBe(1);

    // Verify entry was stored
    const entries = await pool.query(
      `SELECT * FROM screening_entries se
       JOIN screening_lists sl ON se.list_id = sl.id
       WHERE sl.list_name = 'OFAC-SDN' AND se.entry_id = 'integration-test-1'`
    );
    expect(entries.rows).toHaveLength(1);
    expect(entries.rows[0].primary_name).toBe('TEST INTEGRATION');

    jest.restoreAllMocks();

    // Cleanup
    await pool.query(`TRUNCATE screening_sync_events`);
    await pool.query(
      `DELETE FROM screening_entries se
       USING screening_lists sl
       WHERE se.list_id = sl.id AND sl.list_name = 'OFAC-SDN'`
    );
    await pool.query(`DELETE FROM screening_lists WHERE list_name = 'OFAC-SDN'`);
  });
});
