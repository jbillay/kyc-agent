'use strict';

const { pool } = require('../../../db/connection');

/**
 * UK HMT consolidated sanctions list provider.
 *
 * HMT CSV Column Structure (key fields):
 *   Col 0:  Last Updated
 *   Col 1:  Group Type (Entity / Individual)
 *   Col 2:  Group ID (unique identifier)
 *   Col 3-8: Name1 through Name6 (split across columns)
 *   Col 9:  Name Type (Primary Name / AKA)
 *   Col 10: Alias Quality
 *   Col 11: Title
 *   Col 12: DOB (DD/MM/YYYY or partial)
 *   Col 13: Town of Birth
 *   Col 14: Country of Birth
 *   Col 15: Nationality
 *   Col 16: Passport Number
 *   Col 17: NI Number
 *   Col 18: Position
 *   Col 19-24: Address1-6
 *   Col 25: Regime / Sanctions program
 *   Col 26: Listed On
 *
 * Multiple rows share the same Group ID (one per alias / address).
 *
 * @implements {ScreeningProvider}
 */
class UKHMTProvider {
  /**
   * @param {Object} config
   * @param {string} [config.sourceUrl]
   * @param {number} [config.matchThreshold]
   * @param {import('./fuzzy-matcher').FuzzyMatcher} fuzzyMatcher
   */
  constructor(config, fuzzyMatcher) {
    this.name = 'uk-hmt';
    this.listType = 'sanctions';
    this.sourceUrl = config.sourceUrl ||
      'https://assets.publishing.service.gov.uk/media/ConList.csv';
    this.fuzzyMatcher = fuzzyMatcher;
    this.matchThreshold = config.matchThreshold ?? 70;
    this._listId = null;
  }

  // ─── Public API (ScreeningProvider interface) ──────────────────────────────

  /**
   * Search the local HMT list for fuzzy name matches.
   * Applies DOB (+10) and nationality (+5) score boosts when those fields match.
   * @param {import('./types').ScreeningQuery} query
   * @returns {Promise<import('./types').ScreeningHit[]>}
   */
  async search(query) {
    const entries = await this._loadEntries(query.entityType);
    const hits = [];

    for (const entry of entries) {
      const allNames = [entry.primary_name, ...(entry.aliases || [])];
      let bestScore = 0;
      let bestMatchedName = '';

      for (const name of allNames) {
        const result = this.fuzzyMatcher.compare(query.name, name);
        const score = result.score;
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
          source: 'UK-HMT',
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
            listedDate: entry.raw_data?.listedOn || undefined,
          },
          rawData: entry.raw_data,
        });
      }
    }

    return hits.sort((a, b) => b.matchScore - a.matchScore);
  }

  /**
   * Get metadata about the locally stored HMT list.
   * Returns a default zero-entry record if the list has never been synced.
   * @returns {Promise<import('./types').ListMetadata & { isStale: boolean }>}
   */
  async getListMetadata() {
    const result = await pool.query(
      `SELECT list_name, list_type, source_url, last_updated, entry_count
       FROM screening_lists WHERE list_name = $1`,
      ['UK-HMT']
    );

    if (result.rows.length === 0) {
      return {
        listName: 'UK-HMT',
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
   * Download, parse, and upsert the HMT list. Idempotent — re-running with
   * identical source data produces zero added/removed/modified counts.
   * Retries the download up to 3 times with exponential backoff (2s/4s/8s).
   * Writes an immutable outcome row to `screening_sync_events` on every run.
   * @returns {Promise<import('./types').UpdateResult>}
   * @throws {Error} When all download retry attempts fail.
   */
  async updateList() {
    const startedAt = new Date();
    try {
      const csv = await this._downloadCSV();
      const entries = this._parseCSV(csv);
      const listId = await this._ensureList();
      const stats = await this._upsertEntries(listId, entries);

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

      return {
        updated: stats.added > 0 || stats.removed > 0 || stats.modified > 0,
        entriesAdded: stats.added,
        entriesRemoved: stats.removed,
        entriesModified: stats.modified,
        timestamp: new Date().toISOString(),
      };
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
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Download the HMT CSV with up to 3 retries (exponential backoff: 2s, 4s, 8s).
   * @returns {Promise<string>}
   */
  async _downloadCSV() {
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
          throw new Error(`Failed to download HMT list: HTTP ${response.status}`);
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
   * Parse HMT CSV into grouped entries.
   * Multiple CSV rows share the same Group ID — grouped here into one entry per ID.
   * @param {string} csv
   * @returns {Array<Object>}
   */
  _parseCSV(csv) {
    const lines = this._parseCSVLines(csv);
    const dataLines = lines.slice(1); // skip header row

    const groups = new Map();

    for (const cols of dataLines) {
      if (cols.length < 10) continue;

      const groupId = cols[2]?.trim();
      if (!groupId) continue;

      if (!groups.has(groupId)) {
        groups.set(groupId, {
          groupId,
          groupType: cols[1]?.trim(),
          names: [],
          dob: null,
          nationalities: new Set(),
          programs: new Set(),
          remarks: null,
          listedOn: null,
        });
      }

      const group = groups.get(groupId);

      // Assemble full name from Name1–Name6 (cols 3–8)
      const nameParts = [];
      for (let i = 3; i <= 8; i++) {
        const part = cols[i]?.trim();
        if (part) nameParts.push(part);
      }
      const fullName = nameParts.join(' ');
      const nameType = cols[9]?.trim();

      if (fullName) {
        group.names.push({ name: fullName, type: nameType });
      }

      if (!group.dob && cols[12]?.trim()) {
        group.dob = this._normalizeDOB(cols[12].trim());
      }

      if (cols[15]?.trim()) {
        group.nationalities.add(cols[15].trim());
      }

      if (cols[25]?.trim()) {
        group.programs.add(cols[25].trim());
      }

      if (!group.listedOn && cols[26]?.trim()) {
        group.listedOn = cols[26].trim();
      }
    }

    return Array.from(groups.values()).map((group) => {
      const primaryNameEntry =
        group.names.find((n) => n.type === 'Primary Name') || group.names[0];
      const primaryName = primaryNameEntry?.name || 'Unknown';
      const aliases = group.names
        .filter((n) => n !== primaryNameEntry)
        .map((n) => n.name);

      return {
        entryId: group.groupId,
        entityType: group.groupType === 'Individual' ? 'individual' : 'entity',
        primaryName,
        aliases,
        dateOfBirth: group.dob,
        nationalities: [...group.nationalities],
        programs: [...group.programs],
        remarks: group.remarks,
        rawData: {
          groupType: group.groupType,
          listedOn: group.listedOn,
          allNames: group.names,
        },
      };
    });
  }

  /**
   * Parse CSV text respecting quoted fields and escaped double-quotes.
   * Skips rows that produce only one column (no commas).
   * @param {string} csv
   * @returns {string[][]}
   */
  _parseCSVLines(csv) {
    const lines = [];
    let current = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < csv.length; i++) {
      const ch = csv[i];

      if (inQuotes) {
        if (ch === '"') {
          if (csv[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        current.push(field);
        field = '';
      } else if (ch === '\n' || (ch === '\r' && csv[i + 1] === '\n')) {
        current.push(field);
        field = '';
        if (current.length > 1) lines.push(current);
        current = [];
        if (ch === '\r') i++;
      } else {
        field += ch;
      }
    }

    // Handle final line without trailing newline
    if (field || current.length > 0) {
      current.push(field);
      if (current.length > 1) lines.push(current);
    }

    return lines;
  }

  /**
   * Normalise HMT DOB formats to ISO-ish strings.
   * DD/MM/YYYY → YYYY-MM-DD, MM/YYYY → YYYY-MM, YYYY → YYYY, else raw.
   * @param {string} dob
   * @returns {string}
   */
  _normalizeDOB(dob) {
    const full = dob.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (full) return `${full[3]}-${full[2]}-${full[1]}`;

    const partial = dob.match(/^(\d{2})\/(\d{4})$/);
    if (partial) return `${partial[2]}-${partial[1]}`;

    return dob;
  }

  /**
   * Compare two DOB strings after stripping non-numeric characters.
   * A partial stored DOB (e.g. "1985") matches a precise query (e.g. "1985-03-15")
   * because the stripped query "19850315" contains the stripped stored "1985".
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
   * @param {string|null} lastUpdated
   * @returns {boolean}
   */
  _isStale(lastUpdated) {
    if (!lastUpdated) return true;
    return Date.now() - new Date(lastUpdated).getTime() > 24 * 60 * 60 * 1000;
  }

  /**
   * Returns true if any tracked field differs between the stored row and the new entry.
   * Array fields are compared as sorted JSON strings for order-independence.
   * @param {Object} existing - Row from screening_entries
   * @param {Object} newEntry - Parsed entry from _parseCSV
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

  async _ensureList() {
    if (this._listId) return this._listId;

    const result = await pool.query(
      `INSERT INTO screening_lists (list_name, list_type, source_url)
       VALUES ('UK-HMT', 'sanctions', $1)
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
   * as modified, satisfying the idempotency requirement.
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
   * Write a sync run outcome row to screening_sync_events (append-only).
   * @param {Object} opts
   */
  async _writeSyncEvent({ status, entriesAdded, entriesRemoved, entriesModified,
    errorMessage, startedAt, completedAt }) {
    await pool.query(
      `INSERT INTO screening_sync_events
         (list_name, status, entries_added, entries_removed, entries_modified,
          error_message, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        'UK-HMT', status, entriesAdded, entriesRemoved, entriesModified,
        errorMessage || null, startedAt, completedAt,
      ]
    );
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
       WHERE sl.list_name = 'UK-HMT'
         AND ($1::varchar IS NULL OR se.entity_type = $1)`,
      [entityType || null]
    );
    return result.rows;
  }
}

module.exports = { UKHMTProvider };
