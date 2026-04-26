# UK HMT Sanctions List Ingestion and Search

> GitHub Issue: [#18](https://github.com/jbillay/kyc-agent/issues/18)
> Epic: Data Integration Layer (#13)
> Size: M (1-3 days) | Priority: Critical

## Context

The UK HMT (Her Majesty's Treasury) consolidated sanctions list is required for UK regulatory compliance. The list is distributed as a CSV file with a specific column structure, notably splitting names across six fields (Name1–Name6). The `UKHMTProvider` implements the `ScreeningProvider` interface and uses the shared fuzzy matching engine (#19).

## Requirements

### Functional

1. Download and parse UK HMT consolidated list CSV
2. Store entries in `screening_entries` table
3. Handle names in HMT format (Name1–Name6 fields)
4. Parse DOB, nationality, and regime/program fields
5. `UKHMTProvider` implements `ScreeningProvider` interface
6. Sync worker checks for updates
7. Search returns matches with fuzzy name matching scores

### Non-Functional

- Full list ingestion completes in under 30 seconds
- Search against full list in under 500ms (delegated to fuzzy matcher)
- CSV parsing handles edge cases: quoted fields, embedded commas, empty fields

## Technical Design

### File: `backend/src/data-sources/screening/uk-hmt.js`

```javascript
const { pool } = require('../../db/connection');

/**
 * UK HMT consolidated sanctions list provider.
 *
 * HMT CSV Column Structure (key fields):
 *   Col 0:  Last Updated
 *   Col 1:  Group Type (Entity / Individual)
 *   Col 2:  Group ID (unique identifier)
 *   Col 3-8: Name1 through Name6 (split across columns)
 *   Col 9:  Name Type (Primary / AKA)
 *   Col 10: Alias Quality
 *   Col 11: Title
 *   Col 12: DOB (DD/MM/YYYY or partial)
 *   Col 13: Town of Birth
 *   Col 14: Country of Birth
 *   Col 15: Nationality
 *   Col 16: Passport Number
 *   Col 17: NI Number
 *   Col 18: Position
 *   Col 19: Address1-6, Country
 *   Col 25: Regime / Sanctions program
 *   Col 26: Listed On
 *
 * Multiple rows can share the same Group ID (one per alias / address).
 *
 * @implements {ScreeningProvider}
 */
class UKHMTProvider {
  /**
   * @param {Object} config
   * @param {string} [config.sourceUrl='https://assets.publishing.service.gov.uk/media/ConList.csv']
   * @param {import('./fuzzy-matcher').FuzzyMatcher} fuzzyMatcher
   */
  constructor(config, fuzzyMatcher) {
    this.name = 'uk-hmt';
    this.listType = 'sanctions';
    this.sourceUrl = config.sourceUrl ||
      'https://assets.publishing.service.gov.uk/media/ConList.csv';
    this.fuzzyMatcher = fuzzyMatcher;
    this._listId = null;
  }

  /**
   * Search the local HMT list for matches.
   * @param {ScreeningQuery} query
   * @returns {Promise<ScreeningHit[]>}
   */
  async search(query) {
    const entries = await this._loadEntries(query.entityType);

    const hits = [];
    for (const entry of entries) {
      const allNames = [entry.primary_name, ...(entry.aliases || [])];
      let bestScore = 0;
      let bestMatchedName = '';
      const matchedFields = [];

      for (const name of allNames) {
        const score = this.fuzzyMatcher.compare(query.name, name);
        if (score > bestScore) {
          bestScore = score;
          bestMatchedName = name;
        }
      }

      if (bestScore >= this.fuzzyMatcher.threshold) {
        matchedFields.push('name');

        if (query.dateOfBirth && entry.date_of_birth) {
          if (this._dobMatches(query.dateOfBirth, entry.date_of_birth)) {
            bestScore = Math.min(100, bestScore + 10);
            matchedFields.push('dateOfBirth');
          }
        }

        if (query.nationality && entry.nationalities?.length > 0) {
          if (entry.nationalities.some((n) => n.toLowerCase().includes(query.nationality.toLowerCase()))) {
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
   * @returns {Promise<ListMetadata>}
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
      };
    }

    const row = result.rows[0];
    return {
      listName: row.list_name,
      listType: row.list_type,
      sourceUrl: row.source_url,
      lastUpdated: row.last_updated?.toISOString() || null,
      entryCount: row.entry_count || 0,
    };
  }

  /**
   * Download, parse, and upsert the HMT list.
   * @returns {Promise<UpdateResult>}
   */
  async updateList() {
    const csv = await this._downloadCSV();
    const entries = this._parseCSV(csv);

    const listId = await this._ensureList();
    const stats = await this._upsertEntries(listId, entries);

    await pool.query(
      `UPDATE screening_lists SET last_updated = NOW(), entry_count = $1 WHERE id = $2`,
      [entries.length, listId]
    );

    return {
      updated: stats.added > 0 || stats.removed > 0 || stats.modified > 0,
      entriesAdded: stats.added,
      entriesRemoved: stats.removed,
      entriesModified: stats.modified,
      timestamp: new Date().toISOString(),
    };
  }

  // ─── Internal ─────────────────────────────────────────

  /**
   * Download the HMT CSV file.
   * @returns {Promise<string>}
   */
  async _downloadCSV() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(this.sourceUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to download HMT list: ${response.status}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse HMT CSV into grouped entries.
   *
   * Multiple CSV rows share the same Group ID — one row per alias/address.
   * We group by Group ID and produce one entry per group with all aliases collected.
   *
   * @param {string} csv
   * @returns {Array<Object>}
   */
  _parseCSV(csv) {
    const lines = this._parseCSVLines(csv);
    // Skip header row
    const dataLines = lines.slice(1);

    // Group rows by Group ID (column 2)
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
          rawRows: [],
        });
      }

      const group = groups.get(groupId);

      // Build name from Name1–Name6 (columns 3–8)
      const nameParts = [];
      for (let i = 3; i <= 8; i++) {
        const part = cols[i]?.trim();
        if (part) nameParts.push(part);
      }
      const fullName = nameParts.join(' ');
      const nameType = cols[9]?.trim(); // "Primary Name" or "AKA"

      if (fullName) {
        group.names.push({ name: fullName, type: nameType });
      }

      // DOB (column 12)
      if (!group.dob && cols[12]?.trim()) {
        group.dob = this._normalizeDOB(cols[12].trim());
      }

      // Nationality (column 15)
      if (cols[15]?.trim()) {
        group.nationalities.add(cols[15].trim());
      }

      // Regime/program (column 25)
      if (cols[25]?.trim()) {
        group.programs.add(cols[25].trim());
      }

      // Listed On (column 26)
      if (!group.listedOn && cols[26]?.trim()) {
        group.listedOn = cols[26].trim();
      }

      group.rawRows.push(cols);
    }

    // Convert groups to entries
    return Array.from(groups.values()).map((group) => {
      const primaryNameEntry = group.names.find((n) => n.type === 'Primary Name') || group.names[0];
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
   * Parse CSV text respecting quoted fields.
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

    if (field || current.length > 0) {
      current.push(field);
      if (current.length > 1) lines.push(current);
    }

    return lines;
  }

  /**
   * Normalize HMT DOB formats (DD/MM/YYYY, MM/YYYY, YYYY) to ISO-ish.
   * @param {string} dob
   * @returns {string}
   */
  _normalizeDOB(dob) {
    // DD/MM/YYYY → YYYY-MM-DD
    const full = dob.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (full) return `${full[3]}-${full[2]}-${full[1]}`;

    // MM/YYYY → YYYY-MM
    const partial = dob.match(/^(\d{2})\/(\d{4})$/);
    if (partial) return `${partial[2]}-${partial[1]}`;

    // YYYY → YYYY
    return dob;
  }

  _dobMatches(queryDOB, entryDOB) {
    const normalize = (d) => d.replace(/[^0-9]/g, '');
    return normalize(queryDOB) === normalize(entryDOB)
      || queryDOB.includes(entryDOB)
      || entryDOB.includes(queryDOB);
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

  async _upsertEntries(listId, entries) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query(
        `SELECT entry_id FROM screening_entries WHERE list_id = $1`,
        [listId]
      );
      const existingIds = new Set(existing.rows.map((r) => r.entry_id));
      const newIds = new Set(entries.map((e) => e.entryId));

      let added = 0;
      let modified = 0;

      for (const entry of entries) {
        const result = await client.query(
          `INSERT INTO screening_entries
             (list_id, entry_id, entity_type, primary_name, aliases, date_of_birth,
              nationalities, programs, remarks, raw_data)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (list_id, entry_id)
           DO UPDATE SET
             primary_name = EXCLUDED.primary_name,
             aliases = EXCLUDED.aliases,
             date_of_birth = EXCLUDED.date_of_birth,
             nationalities = EXCLUDED.nationalities,
             programs = EXCLUDED.programs,
             remarks = EXCLUDED.remarks,
             raw_data = EXCLUDED.raw_data
           RETURNING (xmax = 0) AS is_insert`,
          [
            listId, entry.entryId, entry.entityType, entry.primaryName,
            entry.aliases, entry.dateOfBirth, entry.nationalities,
            entry.programs, entry.remarks, entry.rawData,
          ]
        );

        if (result.rows[0].is_insert) added++;
        else modified++;
      }

      const toRemove = [...existingIds].filter((id) => !newIds.has(id));
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
```

### HMT CSV Column Mapping

| Column Index | Field | Usage |
|-------------|-------|-------|
| 1 | Group Type | "Entity" or "Individual" → `entity_type` |
| 2 | Group ID | Unique entry identifier → `entry_id` |
| 3–8 | Name1–Name6 | Joined to form full name |
| 9 | Name Type | "Primary Name" or "AKA" — determines primary vs alias |
| 12 | DOB | Normalized to ISO format |
| 15 | Nationality | Added to `nationalities` set |
| 25 | Regime | Sanctions program → `programs` |
| 26 | Listed On | Date of listing |

### Name Assembly

HMT splits names across 6 fields — typically:
- **Individuals**: Name1=Title, Name2=FirstName, Name3=MiddleName, Name4=, Name5=, Name6=LastName
- **Entities**: Name1-6=Parts of entity name

The provider joins all non-empty Name1–Name6 fields with spaces.

### Grouping Logic

Multiple CSV rows share the same Group ID (one per alias/address). The parser groups all rows by Group ID and collects:
- All names (first "Primary Name" becomes `primary_name`, rest become `aliases`)
- Union of all nationalities, programs
- First non-empty DOB

## Acceptance Criteria

- [ ] `UKHMTProvider` implements full `ScreeningProvider` interface
- [ ] CSV downloaded and parsed from GOV.UK
- [ ] Names assembled from Name1–Name6 fields
- [ ] Multiple rows per Group ID grouped correctly (primary + aliases)
- [ ] DOB normalized from DD/MM/YYYY to YYYY-MM-DD
- [ ] Nationality and regime fields extracted
- [ ] Entries stored in `screening_entries` with correct `entity_type`
- [ ] `search` returns matches with fuzzy scores
- [ ] `updateList` performs idempotent upsert
- [ ] CSV parser handles quoted fields and embedded commas
- [ ] Unit tests with known HMT entries

## Dependencies

- **Depends on**: #14 (Provider interface — `ScreeningProvider`), #3 (Database — `screening_lists` + `screening_entries`), #19 (Fuzzy matching engine)
- **Blocks**: #27-#28 (Screening Agent)

## Testing Strategy

1. **CSV parsing**: Parse sample HMT CSV fragment, verify entries extracted
2. **Name assembly**: Verify Name1–Name6 joined correctly for individuals and entities
3. **Grouping**: Multiple rows with same Group ID produce one entry with aliases
4. **Primary vs AKA**: Verify "Primary Name" row becomes `primary_name`, others become aliases
5. **DOB normalization**: DD/MM/YYYY → YYYY-MM-DD, MM/YYYY → YYYY-MM, YYYY → YYYY
6. **Quoted CSV fields**: Fields with commas inside quotes parsed correctly
7. **Search hit**: Insert known entry, search with exact name, verify match
8. **Search fuzzy**: Insert known entry, search with variant spelling, verify partial score
9. **Upsert idempotency**: Run `updateList` twice, verify zero changes on second run
10. **Entity type**: Verify "Individual" → 'individual', "Entity" → 'entity'
