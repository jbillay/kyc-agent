'use strict';

const crypto = require('crypto');
const { query } = require('../../db/connection');

class DataSourceCache {
  constructor(options = {}) {
    this.defaultTTLHours = 24;
    this.ttlHours = {
      'companies-house': 24,
      'ofac-sdn': 1,
      'uk-hmt': 1,
      ...options.ttlHours,
    };
    this._hits = 0;
    this._misses = 0;
  }

  async getOrFetch({ provider, method, queryParams, caseId, bypassCache = false, fetchFn }) {
    const queryHash = this._hashQuery(provider, method, queryParams);

    if (!bypassCache) {
      const cached = await this._lookup(provider, queryHash);
      if (cached) {
        this._hits++;
        if (caseId && !cached.case_id) {
          await this._linkToCase(caseId, provider, queryHash);
        }
        return { data: cached.response_data, fromCache: true, cachedAt: cached.fetched_at };
      }
    }

    this._misses++;
    const data = await fetchFn();

    const ttlHours = this.ttlHours[provider] ?? this.defaultTTLHours;
    await this._store({
      provider,
      queryHash,
      queryParams: { method, ...queryParams },
      responseData: data,
      ttlHours,
      caseId,
    });

    return { data, fromCache: false, cachedAt: null };
  }

  getMetrics() {
    const total = this._hits + this._misses;
    return {
      hits: this._hits,
      misses: this._misses,
      hitRate: total > 0 ? this._hits / total : 0,
    };
  }

  resetMetrics() {
    this._hits = 0;
    this._misses = 0;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  _hashQuery(provider, method, queryParams) {
    const payload = JSON.stringify({ provider, method, params: queryParams });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  async _lookup(provider, queryHash) {
    const result = await query(
      `SELECT id, response_data, fetched_at, case_id
       FROM data_source_cache
       WHERE provider = $1 AND query_hash = $2 AND expires_at > NOW()
       ORDER BY fetched_at DESC
       LIMIT 1`,
      [provider, queryHash]
    );
    return result.rows[0] || null;
  }

  async _store({ provider, queryHash, queryParams, responseData, ttlHours, caseId }) {
    await query(
      `INSERT INTO data_source_cache
         (provider, query_hash, query_params, response_data, fetched_at, expires_at, case_id)
       VALUES ($1, $2, $3, $4, NOW(), NOW() + INTERVAL '1 hour' * $5, $6)
       ON CONFLICT DO NOTHING`,
      [provider, queryHash, queryParams, responseData, ttlHours, caseId || null]
    );
  }

  async _linkToCase(caseId, provider, queryHash) {
    await query(
      `UPDATE data_source_cache
       SET case_id = $1
       WHERE id = (
         SELECT id FROM data_source_cache
         WHERE provider = $2
           AND query_hash = $3
           AND expires_at > NOW()
           AND case_id IS NULL
         ORDER BY fetched_at DESC
         LIMIT 1
       )`,
      [caseId, provider, queryHash]
    );
  }
}

module.exports = { DataSourceCache };
