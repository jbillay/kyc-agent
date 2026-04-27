'use strict';

const { pool } = require('../../../db/connection');

/**
 * OFAC SDN screening provider.
 *
 * Downloads and parses the OFAC SDN XML list from the US Treasury, stores
 * entries locally in PostgreSQL, and searches them using injected fuzzy
 * matching. Every sync run outcome is recorded in screening_sync_events
 * (append-only) for regulatory audit purposes.
 *
 * XML Structure (simplified):
 *   <sdnList>
 *     <sdnEntry>
 *       <uid>12345</uid>
 *       <sdnType>Individual</sdnType>
 *       <lastName>DOE</lastName>
 *       <firstName>John</firstName>
 *       <programList><program>SDGT</program></programList>
 *       <akaList><aka><lastName>SMITH</lastName></aka></akaList>
 *       <dateOfBirthList><dateOfBirthItem><dateOfBirth>01 Jan 1970</dateOfBirth></dateOfBirthItem></dateOfBirthList>
 *       <nationalityList><nationality><country>Iran</country></nationality></nationalityList>
 *       <remarks>...</remarks>
 *     </sdnEntry>
 *   </sdnList>
 *
 * @implements {ScreeningProvider}
 */
class OFACProvider {
  /**
   * @param {Object} config
   * @param {string} [config.sourceUrl]
   * @param {number} [config.matchThreshold]
   * @param {import('./fuzzy-matcher').FuzzyMatcher} fuzzyMatcher
   */
  constructor(config, fuzzyMatcher) {
    this.name = 'ofac-sdn';
    this.listType = 'sanctions';
    this.sourceUrl = config.sourceUrl ||
      'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';
    this.fuzzyMatcher = fuzzyMatcher;
    this.matchThreshold = config.matchThreshold ?? 70;
    this._listId = null;
  }

  // ─── Public API (ScreeningProvider interface) ──────────────

  /**
   * Search the local SDN list for fuzzy name matches.
   * Loads all entries from the database and scores each against the query name.
   * Applies DOB (+10) and nationality (+5) score boosts when those fields match.
   * @param {import('./types').ScreeningQuery} query
   * @returns {Promise<import('./types').ScreeningHit[]>} Matches sorted by score descending; empty array when none meet the threshold.
   */
  async search(query) {
    const entries = await this._loadEntries(query.entityType);

    const hits = [];
    for (const entry of entries) {
      const allNames = [entry.primary_name, ...(entry.aliases || [])];
      let bestScore = 0;
      let bestMatchedName = '';

      for (const name of allNames) {
        const score = this.fuzzyMatcher.compare(query.name, name);
        if (score > bestScore) {
          bestScore = score;
          bestMatchedName = name;
        }
      }

      if (bestScore >= this.matchThreshold) {
        const matchedFields = ['name'];

        if (query.dateOfBirth && entry.date_of_birth) {
          if (this._dobMatches(query.dateOfBirth, entry.date_of_birth)) {
            bestScore = Math.min(100, bestScore + 10);
            matchedFields.push('dateOfBirth');
          }
        }

        if (query.nationality && entry.nationalities?.length > 0) {
          if (entry.nationalities.some((n) =>
            n.toLowerCase().includes(query.nationality.toLowerCase())
          )) {
            bestScore = Math.min(100, bestScore + 5);
            matchedFields.push('nationality');
          }
        }

        hits.push({
          source: 'OFAC-SDN',
          matchedName: bestMatchedName,
          matchScore: bestScore,
          matchedFields,
          listEntry: {
            id: entry.entry_id,
            names: allNames,
            dateOfBirth: entry.date_of_birth || undefined,
            nationality: entry.nationalities || [],
            programs: entry.programs || [],
            remarks: entry.remarks || undefined,
          },
          rawData: entry.raw_data,
        });
      }
    }

    return hits.sort((a, b) => b.matchScore - a.matchScore);
  }

  /**
   * Get metadata about the locally stored SDN list.
   * Returns a default zero-entry record if the list has never been synced.
   * @returns {Promise<import('./types').ListMetadata & { isStale: boolean }>} Includes `isStale: true` when `lastUpdated` is null or older than 24 hours.
   */
  async getListMetadata() {
    const result = await pool.query(
      `SELECT list_name, list_type, source_url, last_updated, entry_count
       FROM screening_lists WHERE list_name = $1`,
      ['OFAC-SDN']
    );

    if (result.rows.length === 0) {
      return {
        listName: 'OFAC-SDN',
        listType: 'sanctions',
        sourceUrl: this.sourceUrl,
        lastUpdated: null,
        entryCount: 0,
        isStale: true,
      };
    }

    const row = result.rows[0];
    const lastUpdated = row.last_updated?.toISOString() || null;
    return {
      listName: row.list_name,
      listType: row.list_type,
      sourceUrl: row.source_url,
      lastUpdated,
      entryCount: row.entry_count || 0,
      isStale: this._isStale(lastUpdated),
    };
  }

  /**
   * Download, parse, and upsert the SDN list. Idempotent — re-running with
   * identical source data produces zero added/removed/modified counts.
   * Retries the download up to 3 times with exponential backoff (2s/4s/8s).
   * Writes an immutable outcome row to `screening_sync_events` on every run.
   * @returns {Promise<import('./types').UpdateResult>}
   * @throws {Error} When all 3 download retry attempts fail.
   */
  async updateList() {
    const startedAt = new Date();
    const listId = await this._ensureList();

    // Emit stale_detected event before downloading if the list is already stale
    const meta = await this.getListMetadata();
    if (meta.isStale && meta.lastUpdated !== null) {
      const elapsedMs = Date.now() - new Date(meta.lastUpdated).getTime();
      const elapsedHours = (elapsedMs / (1000 * 60 * 60)).toFixed(1);
      await this._writeSyncEvent({
        status: 'stale_detected',
        entriesAdded: 0,
        entriesRemoved: 0,
        entriesModified: 0,
        errorMessage: `List has not been updated for ${elapsedHours}h`,
        startedAt,
        completedAt: new Date(),
      });
    }

    let stats;
    try {
      const xml = await this._downloadXML();
      const entries = this._parseXML(xml);
      stats = await this._upsertEntries(listId, entries);

      await pool.query(
        `UPDATE screening_lists SET last_updated = NOW(), entry_count = $1 WHERE id = $2`,
        [entries.length, listId]
      );

      await this._writeSyncEvent({
        status: 'success',
        entriesAdded: stats.added,
        entriesRemoved: stats.removed,
        entriesModified: stats.modified,
        startedAt,
        completedAt: new Date(),
      });
    } catch (err) {
      await this._writeSyncEvent({
        status: 'failure',
        entriesAdded: 0,
        entriesRemoved: 0,
        entriesModified: 0,
        errorMessage: err.message,
        startedAt,
        completedAt: new Date(),
      });
      throw err;
    }

    return {
      updated: stats.added > 0 || stats.removed > 0 || stats.modified > 0,
      entriesAdded: stats.added,
      entriesRemoved: stats.removed,
      entriesModified: stats.modified,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Internal ──────────────────────────────────────────────

  /**
   * Download the SDN XML with up to 3 retries (exponential backoff: 2s, 4s, 8s).
   * @returns {Promise<string>}
   */
  async _downloadXML() {
    const delays = [0, 2000, 4000, 8000];
    let lastError;

    for (let attempt = 0; attempt < 4; attempt++) {
      if (delays[attempt] > 0) {
        await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      try {
        const response = await fetch(this.sourceUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to download SDN list: HTTP ${response.status}`);
        }
        return await response.text();
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError;
  }

  /**
   * Parse SDN XML into structured entry objects.
   * @param {string} xml
   * @returns {Array<Object>}
   */
  _parseXML(xml) {
    const { XMLParser } = require('fast-xml-parser');
    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) =>
        ['sdnEntry', 'aka', 'program', 'dateOfBirthItem', 'nationality'].includes(name),
    });
    const doc = parser.parse(xml);
    const sdnEntries = doc?.sdnList?.sdnEntry || [];

    return sdnEntries.map((entry) => {
      const firstName = entry.firstName || '';
      const lastName = entry.lastName || '';
      const primaryName = `${firstName} ${lastName}`.trim() || lastName;

      const aliases = (entry.akaList?.aka || []).map((aka) => {
        const akaFirst = aka.firstName || '';
        const akaLast = aka.lastName || '';
        return `${akaFirst} ${akaLast}`.trim();
      }).filter(Boolean);

      const programs = (entry.programList?.program || []).map((p) =>
        typeof p === 'string' ? p : p['#text'] || ''
      ).filter(Boolean);

      const dobs = (entry.dateOfBirthList?.dateOfBirthItem || []).map((d) =>
        d.dateOfBirth || ''
      ).filter(Boolean);

      const nationalities = (entry.nationalityList?.nationality || []).map((n) =>
        n.country || (typeof n === 'string' ? n : '')
      ).filter(Boolean);

      return {
        entryId: String(entry.uid),
        entityType: entry.sdnType === 'Individual' ? 'individual' : 'entity',
        primaryName,
        aliases,
        dateOfBirth: dobs[0] || null,
        nationalities,
        programs,
        remarks: entry.remarks || null,
        rawData: entry,
      };
    });
  }

  /**
   * Ensure the screening_lists row for OFAC-SDN exists; cache its UUID.
   * @returns {Promise<string>}
   */
  async _ensureList() {
    if (this._listId) return this._listId;

    const result = await pool.query(
      `INSERT INTO screening_lists (list_name, list_type, source_url)
       VALUES ('OFAC-SDN', 'sanctions', $1)
       ON CONFLICT (list_name) DO UPDATE SET source_url = EXCLUDED.source_url
       RETURNING id`,
      [this.sourceUrl]
    );
    this._listId = result.rows[0].id;
    return this._listId;
  }

  /**
   * Upsert entries in a single transaction; delete those no longer in the list.
   * Compares existing data in-memory so truly unchanged entries are not counted
   * as modified, satisfying the idempotency requirement (SC-003).
   * @param {string} listId
   * @param {Array<Object>} entries
   * @returns {Promise<{ added: number, removed: number, modified: number }>}
   */
  async _upsertEntries(listId, entries) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existingResult = await client.query(
        `SELECT entry_id, primary_name, aliases, date_of_birth,
                nationalities, programs, remarks
         FROM screening_entries WHERE list_id = $1`,
        [listId]
      );
      const existingMap = new Map(existingResult.rows.map((r) => [r.entry_id, r]));
      const newIds = new Set(entries.map((e) => e.entryId));

      let added = 0;
      let modified = 0;

      for (const entry of entries) {
        const existing = existingMap.get(entry.entryId);
        if (!existing) {
          await client.query(
            `INSERT INTO screening_entries
               (list_id, entry_id, entity_type, primary_name, aliases, date_of_birth,
                nationalities, programs, remarks, raw_data)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              listId, entry.entryId, entry.entityType, entry.primaryName,
              entry.aliases, entry.dateOfBirth, entry.nationalities,
              entry.programs, entry.remarks, entry.rawData,
            ]
          );
          added++;
        } else if (this._entryChanged(existing, entry)) {
          await client.query(
            `UPDATE screening_entries
             SET primary_name = $1, aliases = $2, date_of_birth = $3,
                 nationalities = $4, programs = $5, remarks = $6, raw_data = $7
             WHERE list_id = $8 AND entry_id = $9`,
            [
              entry.primaryName, entry.aliases, entry.dateOfBirth,
              entry.nationalities, entry.programs, entry.remarks, entry.rawData,
              listId, entry.entryId,
            ]
          );
          modified++;
        }
        // else: data identical → skip, counts as zero change
      }

      const toRemove = [...existingMap.keys()].filter((id) => !newIds.has(id));
      let removed = 0;
      if (toRemove.length > 0) {
        const delResult = await client.query(
          `DELETE FROM screening_entries WHERE list_id = $1 AND entry_id = ANY($2)`,
          [listId, toRemove]
        );
        removed = delResult.rowCount;
      }

      await client.query('COMMIT');
      return { added, removed, modified };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Returns true if any tracked field differs between the stored row and the new entry.
   * Array fields are compared as sorted JSON strings for order-independence.
   * @param {Object} existing - Row from screening_entries
   * @param {Object} newEntry - Parsed entry from _parseXML
   * @returns {boolean}
   */
  _entryChanged(existing, newEntry) {
    const sortedStr = (arr) => JSON.stringify((arr || []).slice().sort());
    return existing.primary_name !== newEntry.primaryName
      || sortedStr(existing.aliases) !== sortedStr(newEntry.aliases)
      || (existing.date_of_birth || null) !== (newEntry.dateOfBirth || null)
      || sortedStr(existing.nationalities) !== sortedStr(newEntry.nationalities)
      || sortedStr(existing.programs) !== sortedStr(newEntry.programs)
      || (existing.remarks || null) !== (newEntry.remarks || null);
  }

  /**
   * Load entries from the local database for searching.
   * @param {'individual'|'entity'} [entityType]
   * @returns {Promise<Array<Object>>}
   */
  async _loadEntries(entityType) {
    const result = await pool.query(
      `SELECT entry_id, primary_name, aliases, date_of_birth, nationalities,
              programs, remarks, raw_data
       FROM screening_entries se
       JOIN screening_lists sl ON se.list_id = sl.id
       WHERE sl.list_name = 'OFAC-SDN'
         AND ($1::varchar IS NULL OR se.entity_type = $1)`,
      [entityType || null]
    );
    return result.rows;
  }

  /**
   * Compare two DOB strings after stripping non-numeric characters.
   * @param {string} queryDOB
   * @param {string} entryDOB
   * @returns {boolean}
   */
  _dobMatches(queryDOB, entryDOB) {
    const normalize = (d) => d.replace(/[^0-9]/g, '');
    const q = normalize(queryDOB);
    const e = normalize(entryDOB);
    return q === e || q.includes(e) || e.includes(q);
  }

  /**
   * Returns true if the list has not been successfully updated within 24 hours.
   * @param {string|null} lastUpdated - ISO 8601 timestamp or null
   * @returns {boolean}
   */
  _isStale(lastUpdated) {
    if (!lastUpdated) return true;
    return Date.now() - new Date(lastUpdated).getTime() > 24 * 60 * 60 * 1000;
  }

  /**
   * Write a sync run outcome row to screening_sync_events.
   * @param {Object} opts
   * @private
   */
  async _writeSyncEvent({ status, entriesAdded, entriesRemoved, entriesModified,
    errorMessage, startedAt, completedAt }) {
    await pool.query(
      `INSERT INTO screening_sync_events
         (list_name, status, entries_added, entries_removed, entries_modified,
          error_message, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        'OFAC-SDN', status, entriesAdded, entriesRemoved, entriesModified,
        errorMessage || null, startedAt, completedAt,
      ]
    );
  }
}

module.exports = { OFACProvider };
