'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString:       process.env.DATABASE_URL,
  max:                    parseInt(process.env.PG_POOL_MAX)              || 20,
  min:                    parseInt(process.env.PG_POOL_MIN)              || 2,
  idleTimeoutMillis:      parseInt(process.env.PG_POOL_IDLE_TIMEOUT_MS) || 30000,
  connectionTimeoutMillis:parseInt(process.env.PG_POOL_CONN_TIMEOUT_MS) || 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle database client', err);
});

/**
 * Execute a parameterized SQL query using the shared connection pool.
 * Logs a WARN if the query takes longer than 1000 ms.
 *
 * @param {string} text       SQL query with $1, $2, … placeholders
 * @param {any[]}  [params]   Parameter values
 * @returns {Promise<import('pg').QueryResult>}
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 1000) {
    console.warn(`WARN: Slow query (${duration}ms): ${text}`);
  }
  return result;
}

/**
 * Acquire a dedicated client from the pool for multi-statement transactions.
 * MUST be released with client.release() in a finally block.
 *
 * @returns {Promise<import('pg').PoolClient>}
 */
async function getClient() {
  return pool.connect();
}

module.exports = { query, getClient };
