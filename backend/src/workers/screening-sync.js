'use strict';

// Screening sync worker — periodic sanctions list updater
// Full implementation in epic-06-screening-agent.

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function syncScreeningLists() {
  console.log('[screening-sync] Starting screening list sync…');
  // Screening list sync implemented in epic-06-screening-agent
  console.log('[screening-sync] Sync complete');
}

syncScreeningLists()
  .then(() => {
    console.log('[screening-sync] Initial sync done, scheduling periodic updates…');
    // Run every 24 hours
    setInterval(syncScreeningLists, 24 * 60 * 60 * 1000);
  })
  .catch((err) => {
    console.error('[screening-sync] Sync failed:', err.message);
    process.exit(1);
  });
