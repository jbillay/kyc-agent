# OFAC SDN Sanctions List Ingestion and Search

> GitHub Issue: [#17](https://github.com/jbillay/kyc-agent/issues/17)
> Epic: Data Integration Layer (#13)
> Size: L (3-5 days) | Priority: Critical

## Context

The OFAC Specially Designated Nationals (SDN) list is the primary US sanctions list. For instant screening without external API latency, the list is downloaded, parsed from XML, and stored locally in PostgreSQL. A daily sync worker keeps the data current. The `OFACProvider` implements the `ScreeningProvider` interface and uses the fuzzy matching engine (#19) for name comparison.

## Requirements

### Functional

1. Download and parse OFAC SDN XML from the Treasury website
2. Store entries in `screening_entries` table with: names, aliases, DOB, nationalities, programs, remarks
3. Handle both individual and entity entries
4. Parse alternate names/aliases correctly
5. Daily sync worker that checks for list updates and applies them
6. `OFACProvider` implements `ScreeningProvider` interface
7. Search returns matches with fuzzy name matching scores
8. List metadata tracked: last update date, entry count, source URL

### Non-Functional

- Full list ingestion completes in under 60 seconds
- Search against full list in under 500ms (delegated to fuzzy matcher)
- Sync worker is idempotent (re-running produces the same result)

## Technical Design

### File: `backend/src/data-sources/screening/ofac.js`

```javascript
const { pool } = require('../../db/connection');

/**
 * OFAC SDN screening provider.
 *
 * Downloads and parses the OFAC SDN XML list, stores entries locally,
 * and searches them using the fuzzy matching engine.
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
   * @param {string} [config.sourceUrl='https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML']
   * @param {import('./fuzzy-matcher').FuzzyMatcher} fuzzyMatcher
   */
  constructor(config, fuzzyMatcher) {
    this.name = 'ofac-sdn';
    this.listType = 'sanctions';
    this.sourceUrl = config.sourceUrl ||
      'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML';
    this.fuzzyMatcher = fuzzyMatcher;
    this._listId = null;
  }

  /**
   * Search the local SDN list for matches.
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

        // Boost score if DOB also matches
        if (query.dateOfBirth && entry.date_of_birth) {
          if (this._dobMatches(query.dateOfBirth, entry.date_of_birth)) {
            bestScore = Math.min(100, bestScore + 10);
            matchedFields.push('dateOfBirth');
          }
        }

        // Boost score if nationality matches
        if (query.nationality && entry.nationalities?.length > 0) {
          if (entry.nationalities.some((n) => n.toLowerCase().includes(query.nationality.toLowerCase()))) {
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
   * Get metadata about the local SDN list.
   * @returns {Promise<ListMetadata>}
   */
  async getListMetadata() {
    const result = await pool.query(
      `SELECT list_name, list_type, source_url, last_updated, entry_count, metadata
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
   * Download, parse, and upsert the SDN list.
   * @returns {Promise<UpdateResult>}
   */
  async updateList() {
    const xml = await this._downloadXML();
    const entries = this._parseXML(xml);

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
   * Download the SDN XML file.
   * @returns {Promise<string>}
   */
  async _downloadXML() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(this.sourceUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to download SDN list: ${response.status}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse SDN XML into structured entries.
   *
   * Uses a lightweight XML parser (fast-xml-parser) to convert XML to JS objects.
   *
   * @param {string} xml
   * @returns {Array<Object>}
   */
  _parseXML(xml) {
    const { XMLParser } = require('fast-xml-parser');
    const parser = new XMLParser({
      ignoreAttributes: false,
      isArray: (name) => ['sdnEntry', 'aka', 'program', 'dateOfBirthItem', 'nationality'].includes(name),
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
   * Ensure the screening_lists row exists for OFAC-SDN.
   * @returns {Promise<string>} list ID
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
   * Upsert entries and track changes.
   * @param {string} listId
   * @param {Array<Object>} entries
   * @returns {Promise<{ added: number, removed: number, modified: number }>}
   */
  async _upsertEntries(listId, entries) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get existing entry IDs
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

        if (result.rows[0].is_insert) {
          added++;
        } else {
          modified++;
        }
      }

      // Remove entries no longer in the list
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

  /**
   * Load entries from the local database for searching.
   * @param {'individual'|'entity'} entityType
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
   * Simple DOB comparison — handles partial dates.
   * @param {string} queryDOB
   * @param {string} entryDOB
   * @returns {boolean}
   */
  _dobMatches(queryDOB, entryDOB) {
    const normalize = (d) => d.replace(/[^0-9]/g, '');
    return normalize(queryDOB) === normalize(entryDOB)
      || queryDOB.includes(entryDOB)
      || entryDOB.includes(queryDOB);
  }
}

module.exports = { OFACProvider };
```

### File: `backend/src/workers/screening-sync.js`

```javascript
const { getConfigService } = require('../services/config-service');
const { OFACProvider } = require('../data-sources/screening/ofac');
const { UKHMTProvider } = require('../data-sources/screening/uk-hmt');
const { FuzzyMatcher } = require('../data-sources/screening/fuzzy-matcher');

/**
 * Screening list sync worker.
 *
 * Designed to be called by a BullMQ scheduled job or cron.
 * Idempotent — safe to re-run at any time.
 */
async function syncScreeningLists() {
  const config = getConfigService();
  const fuzzyMatcher = new FuzzyMatcher();

  const providers = [
    new OFACProvider(config.screeningSources?.ofac_sdn || {}, fuzzyMatcher),
    new UKHMTProvider(config.screeningSources?.uk_hmt || {}, fuzzyMatcher),
  ];

  const results = [];
  for (const provider of providers) {
    try {
      console.log(`Syncing ${provider.name}...`);
      const result = await provider.updateList();
      console.log(`${provider.name}: +${result.entriesAdded} -${result.entriesRemoved} ~${result.entriesModified}`);
      results.push({ provider: provider.name, ...result });
    } catch (err) {
      console.error(`Failed to sync ${provider.name}:`, err.message);
      results.push({ provider: provider.name, error: err.message });
    }
  }

  return results;
}

module.exports = { syncScreeningLists };
```

### SDN XML Structure

The SDN XML has this structure (fields used by the parser):

| XML Element | Mapped To | Notes |
|-------------|-----------|-------|
| `<uid>` | `entry_id` | Unique identifier |
| `<sdnType>` | `entity_type` | "Individual" or "Entity" |
| `<firstName>` + `<lastName>` | `primary_name` | Combined |
| `<akaList>/<aka>` | `aliases` | Array of alternate names |
| `<programList>/<program>` | `programs` | e.g., "SDGT", "IRAN" |
| `<dateOfBirthList>` | `date_of_birth` | First DOB entry |
| `<nationalityList>` | `nationalities` | Array of countries |
| `<remarks>` | `remarks` | Free text |

## Acceptance Criteria

- [ ] `OFACProvider` implements full `ScreeningProvider` interface (`search`, `getListMetadata`, `updateList`)
- [ ] XML downloaded and parsed from Treasury website
- [ ] Entries stored in `screening_entries` with names, aliases, DOB, nationalities, programs, remarks
- [ ] Both individual and entity entries handled
- [ ] Alternate names/aliases parsed from `<akaList>`
- [ ] `search` returns matches with fuzzy scores, matched fields, and full list entry details
- [ ] DOB and nationality boost the match score when they match
- [ ] `getListMetadata` returns last update date, entry count, source URL
- [ ] `updateList` performs idempotent upsert (inserts new, updates changed, removes delisted)
- [ ] Daily sync worker calls `updateList` for all screening providers
- [ ] All responses include `rawData` with original XML entry
- [ ] Unit tests with known SDN entries

## Dependencies

- **Depends on**: #14 (Provider interface — `ScreeningProvider`), #3 (Database — `screening_lists` + `screening_entries`), #19 (Fuzzy matching engine)
- **Blocks**: #27-#28 (Screening Agent)

## Testing Strategy

1. **XML parsing**: Parse sample SDN XML fragment, verify entries extracted correctly
2. **Individual entry**: Verify `sdnType=Individual` maps to `entityType: 'individual'`
3. **Entity entry**: Verify `sdnType=Entity` maps to `entityType: 'entity'`
4. **Aliases**: Verify `<akaList>` entries are extracted as aliases array
5. **Programs**: Verify `<programList>` entries are extracted
6. **Search hit**: Insert known entry, search with exact name, verify 100% score
7. **Search fuzzy**: Insert known entry, search with slightly misspelled name, verify partial score
8. **Search miss**: Search with unrelated name, verify no results
9. **DOB boost**: Search with matching DOB, verify score boost
10. **Nationality boost**: Search with matching nationality, verify score boost
11. **Upsert idempotency**: Run `updateList` twice with same data, verify zero changes on second run
12. **Entry removal**: Remove entry from XML, run `updateList`, verify entry deleted from DB
13. **Integration test**: Download real SDN XML (small subset), verify parse and store
