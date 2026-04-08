'use strict';

const path = require('path');
const runner = require('node-pg-migrate/dist/runner').default;

/**
 * Apply all pending migrations using node-pg-migrate.
 * Called by the API startup sequence before fastify.listen().
 * Rejects (fail-fast) if any migration fails.
 */
async function runMigrations() {
  console.log('Running database migrations...');

  await runner({
    databaseUrl:      process.env.DATABASE_URL,
    migrationsTable:  'pgmigrations',
    dir:              path.join(__dirname, 'migrations'),
    direction:        'up',
    count:            Infinity,
    log:              (msg) => console.log(msg),
  });

  console.log('Migrations complete.');
}

module.exports = { runMigrations };
