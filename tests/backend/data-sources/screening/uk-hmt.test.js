'use strict';

// Mock the DB pool before any module loads
jest.mock('../../../../backend/db/connection', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

const { pool } = require('../../../../backend/db/connection');
const { UKHMTProvider } = require('../../../../backend/src/data-sources/screening/uk-hmt');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// 27 columns (0-26): col 25 = Regime, col 26 = Listed On
const SAMPLE_CSV = [
  'Last Updated,Group Type,Group ID,Name1,Name2,Name3,Name4,Name5,Name6,Name Type,Alias Quality,Title,DOB,Town of Birth,Country of Birth,Nationality,Passport Number,NI Number,Position,Address1,Address2,Address3,Address4,Address5,Address6,Regime,Listed On',
  '01/04/2026,Individual,12345,DOE,John,,,,,Primary Name,,Mr,01/01/1970,,,Iranian,,,,,,,,,,Iran Sanctions,15/03/2020',
  '01/04/2026,Individual,12345,SMITH,John,,,,,AKA,,,,,,,,,,,,,,,,Iran Sanctions,',
].join('\n');

const SAMPLE_DB_ENTRY = {
  entry_id: '12345',
  primary_name: 'DOE John',
  aliases: ['SMITH John'],
  date_of_birth: '1970-01-01',
  nationalities: ['Iranian'],
  programs: ['Iran Sanctions'],
  remarks: null,
  raw_data: { groupType: 'Individual', listedOn: '15/03/2020', allNames: [] },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFuzzyMatcher({ threshold = 70, scores = {} } = {}) {
  return {
    threshold,
    compare: jest.fn((a, b) => {
      const key = `${a}|${b}`;
      const score = scores[key] ?? (a.toLowerCase() === b.toLowerCase() ? 100 : 0);
      return { score, isMatch: score >= threshold, matchedFields: [] };
    }),
  };
}

function makeProvider(config = {}, matcherOpts = {}) {
  return new UKHMTProvider(config, makeFuzzyMatcher(matcherOpts));
}

function makeTransactionClient(queryResults = []) {
  let i = 0;
  const client = {
    query: jest.fn(() => {
      const r = queryResults[i] ?? { rows: [], rowCount: 0 };
      i++;
      return Promise.resolve(r);
    }),
    release: jest.fn(),
  };
  return client;
}

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// T008 — _parseCSVLines
// ---------------------------------------------------------------------------

describe('_parseCSVLines', () => {
  test('parses a simple two-column row', () => {
    const rows = makeProvider()._parseCSVLines('a,b\nc,d');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['a', 'b']);
    expect(rows[1]).toEqual(['c', 'd']);
  });

  test('handles quoted field with embedded comma', () => {
    const rows = makeProvider()._parseCSVLines('"DOE, JOHN",Individual,12345');
    expect(rows[0][0]).toBe('DOE, JOHN');
    expect(rows[0][1]).toBe('Individual');
    expect(rows[0][2]).toBe('12345');
  });

  test('handles escaped double-quote inside quoted field', () => {
    const rows = makeProvider()._parseCSVLines('"DOE ""THE"" JOHN",Individual');
    expect(rows[0][0]).toBe('DOE "THE" JOHN');
  });

  test('handles CRLF line endings', () => {
    const rows = makeProvider()._parseCSVLines('a,b\r\nc,d');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['a', 'b']);
    expect(rows[1]).toEqual(['c', 'd']);
  });

  test('skips rows with only one column (no commas)', () => {
    const rows = makeProvider()._parseCSVLines('onlyonecolumn\na,b');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(['a', 'b']);
  });

  test('preserves empty trailing field', () => {
    const rows = makeProvider()._parseCSVLines('a,b,');
    expect(rows[0]).toHaveLength(3);
    expect(rows[0][2]).toBe('');
  });
});

// ---------------------------------------------------------------------------
// T009 — _normalizeDOB
// ---------------------------------------------------------------------------

describe('_normalizeDOB', () => {
  test('converts DD/MM/YYYY to YYYY-MM-DD', () => {
    expect(makeProvider()._normalizeDOB('01/03/1985')).toBe('1985-03-01');
  });

  test('converts MM/YYYY to YYYY-MM', () => {
    expect(makeProvider()._normalizeDOB('03/1985')).toBe('1985-03');
  });

  test('passes through a bare four-digit year unchanged', () => {
    expect(makeProvider()._normalizeDOB('1985')).toBe('1985');
  });

  test('passes through an unrecognised format unchanged', () => {
    expect(makeProvider()._normalizeDOB('circa 1970')).toBe('circa 1970');
  });
});

// ---------------------------------------------------------------------------
// T010 — _parseCSV
// ---------------------------------------------------------------------------

describe('_parseCSV', () => {
  test('produces one entry for two rows sharing the same Group ID', () => {
    const entries = makeProvider()._parseCSV(SAMPLE_CSV);
    expect(entries).toHaveLength(1);
    expect(entries[0].entryId).toBe('12345');
  });

  test('sets primaryName from the Primary Name row', () => {
    const entries = makeProvider()._parseCSV(SAMPLE_CSV);
    expect(entries[0].primaryName).toBe('DOE John');
  });

  test('collects AKA rows as aliases', () => {
    const entries = makeProvider()._parseCSV(SAMPLE_CSV);
    expect(entries[0].aliases).toContain('SMITH John');
  });

  test('maps Individual Group Type to entity type individual', () => {
    const entries = makeProvider()._parseCSV(SAMPLE_CSV);
    expect(entries[0].entityType).toBe('individual');
  });

  test('maps non-Individual Group Type to entity type entity', () => {
    const csv = [
      'Last Updated,Group Type,Group ID,Name1,Name2,Name3,Name4,Name5,Name6,Name Type,Alias Quality,Title,DOB,Town of Birth,Country of Birth,Nationality,Passport Number,NI Number,Position,Address1,Address2,Address3,Address4,Address5,Address6,Regime,Listed On',
      '01/04/2026,Entity,99999,EVIL CORP,,,,,,,Primary Name,,,,,,,,,,,,,,,,SDGT,',
    ].join('\n');
    const entries = makeProvider()._parseCSV(csv);
    expect(entries[0].entityType).toBe('entity');
  });

  test('normalises DOB from DD/MM/YYYY format', () => {
    const entries = makeProvider()._parseCSV(SAMPLE_CSV);
    expect(entries[0].dateOfBirth).toBe('1970-01-01');
  });

  test('deduplicates nationalities across group rows', () => {
    const csv = [
      'Last Updated,Group Type,Group ID,Name1,Name2,Name3,Name4,Name5,Name6,Name Type,Alias Quality,Title,DOB,Town of Birth,Country of Birth,Nationality,Passport Number,NI Number,Position,Address1,Address2,Address3,Address4,Address5,Address6,Regime,Listed On',
      '01/04/2026,Individual,AAA,FOO,,,,,,,Primary Name,,,,,Iranian,,,,,,,,,,Iran Sanctions,',
      '01/04/2026,Individual,AAA,BAR,,,,,,,AKA,,,,,Iranian,,,,,,,,,,Iran Sanctions,',
    ].join('\n');
    const entries = makeProvider()._parseCSV(csv);
    expect(entries[0].nationalities).toEqual(['Iranian']);
  });

  test('deduplicates programs across group rows', () => {
    const entries = makeProvider()._parseCSV(SAMPLE_CSV);
    expect(entries[0].programs.filter((p) => p === 'Iran Sanctions')).toHaveLength(1);
  });

  test('uses the first name as primary when no Primary Name row exists', () => {
    const csv = [
      'Last Updated,Group Type,Group ID,Name1,Name2,Name3,Name4,Name5,Name6,Name Type,Alias Quality,Title,DOB,Town of Birth,Country of Birth,Nationality,Passport Number,NI Number,Position,Address1,Address2,Address3,Address4,Address5,Address6,Regime,Listed On',
      '01/04/2026,Individual,ZZZ,ONLY,NAME,,,,,AKA,,,,,,,,,,,,,,,,Test,',
    ].join('\n');
    const entries = makeProvider()._parseCSV(csv);
    expect(entries[0].primaryName).toBe('ONLY NAME');
    expect(entries[0].aliases).toHaveLength(0);
  });

  test('skips rows where all Name1-Name6 fields are blank', () => {
    const csv = [
      'Last Updated,Group Type,Group ID,Name1,Name2,Name3,Name4,Name5,Name6,Name Type,Alias Quality,Title,DOB,Town of Birth,Country of Birth,Nationality,Passport Number,NI Number,Position,Address1,Address2,Address3,Address4,Address5,Address6,Regime,Listed On',
      '01/04/2026,Individual,XYZ,REAL,NAME,,,,,Primary Name,,,,,,,,,,,,,,,,Test,',
      '01/04/2026,Individual,XYZ,,,,,,,AKA,,,,,,,,,,,,,,,,Test,',
    ].join('\n');
    const entries = makeProvider()._parseCSV(csv);
    expect(entries[0].aliases).toHaveLength(0);
  });

  test('stores listedOn in rawData from first non-empty Listed On column', () => {
    const entries = makeProvider()._parseCSV(SAMPLE_CSV);
    expect(entries[0].rawData.listedOn).toBe('15/03/2020');
  });
});

// ---------------------------------------------------------------------------
// T003 — _dobMatches
// ---------------------------------------------------------------------------

describe('_dobMatches', () => {
  test('returns true for exact string match', () => {
    expect(makeProvider()._dobMatches('1985-01-15', '1985-01-15')).toBe(true);
  });

  test('returns true when query is more precise than stored value (partial match)', () => {
    // "1985-03-15" numeric "19850315" contains stored "1985" numeric "1985"
    expect(makeProvider()._dobMatches('1985-03-15', '1985')).toBe(true);
  });

  test('returns true when stored value is more precise than query', () => {
    // "1985" numeric "1985" is contained in "1985-03-15" numeric "19850315"
    expect(makeProvider()._dobMatches('1985', '1985-03-15')).toBe(true);
  });

  test('returns false when years differ', () => {
    expect(makeProvider()._dobMatches('1985', '1990')).toBe(false);
  });

  test('returns false for unrelated values with no numeric overlap', () => {
    // "2000-01-01" numeric "20000101" vs "circa 1970" numeric "1970"
    expect(makeProvider()._dobMatches('2000-01-01', 'circa 1970')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T004 — search()
// ---------------------------------------------------------------------------

describe('search', () => {
  test('returns score 100 for exact name match with all required fields', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_DB_ENTRY] });

    const provider = makeProvider({}, { threshold: 70, scores: { 'DOE John|DOE John': 100 } });
    const hits = await provider.search({ name: 'DOE John', entityType: 'individual' });

    expect(hits).toHaveLength(1);
    expect(hits[0].matchScore).toBe(100);
    expect(hits[0].source).toBe('UK-HMT');
    expect(hits[0].matchedName).toBe('DOE John');
    expect(hits[0].listEntry.id).toBe('12345');
    expect(hits[0].listEntry.names).toContain('DOE John');
    expect(hits[0].matchedFields).toContain('name');
  });

  test('returns partial score for variant spelling above threshold', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_DB_ENTRY] });

    const provider = makeProvider({}, { threshold: 70, scores: { 'DOE Jon|DOE John': 85 } });
    const hits = await provider.search({ name: 'DOE Jon' });

    expect(hits).toHaveLength(1);
    expect(hits[0].matchScore).toBeGreaterThanOrEqual(70);
    expect(hits[0].matchScore).toBeLessThan(100);
  });

  test('returns empty array when no match meets the threshold', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_DB_ENTRY] });

    const provider = makeProvider({}, { threshold: 70, scores: {} });
    const hits = await provider.search({ name: 'UNRELATED NAME' });
    expect(hits).toHaveLength(0);
  });

  test('boosts score by 10 when DOB matches', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_DB_ENTRY] })
      .mockResolvedValueOnce({ rows: [SAMPLE_DB_ENTRY] });

    const fm = makeFuzzyMatcher({ threshold: 70, scores: { 'DOE John|DOE John': 80 } });
    const provider = new UKHMTProvider({}, fm);

    const hitsNoDob = await provider.search({ name: 'DOE John' });
    const hitsWithDob = await provider.search({ name: 'DOE John', dateOfBirth: '1970-01-01' });

    expect(hitsWithDob[0].matchScore).toBe(Math.min(100, hitsNoDob[0].matchScore + 10));
    expect(hitsWithDob[0].matchedFields).toContain('dateOfBirth');
  });

  test('boosts score by 5 when nationality matches', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_DB_ENTRY] });

    const provider = makeProvider({}, { threshold: 70, scores: { 'DOE John|DOE John': 80 } });
    const hits = await provider.search({ name: 'DOE John', nationality: 'Iranian' });

    expect(hits[0].matchScore).toBe(85);
    expect(hits[0].matchedFields).toContain('nationality');
  });

  test('entity-type filter is passed as parameter to the DB query', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await makeProvider().search({ name: 'DOE John', entityType: 'individual' });

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('entity_type'),
      ['individual']
    );
  });

  test('returns empty array when the entry list is empty', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const hits = await makeProvider().search({ name: 'ANY NAME' });
    expect(hits).toHaveLength(0);
  });

  test('results are sorted by matchScore descending', async () => {
    const entries = [
      { ...SAMPLE_DB_ENTRY, entry_id: 'A', primary_name: 'ALICE', aliases: [] },
      { ...SAMPLE_DB_ENTRY, entry_id: 'B', primary_name: 'BOB', aliases: [] },
    ];
    pool.query.mockResolvedValueOnce({ rows: entries });

    const fm = makeFuzzyMatcher({ threshold: 70, scores: { 'TEST|ALICE': 90, 'TEST|BOB': 75 } });
    const hits = await new UKHMTProvider({}, fm).search({ name: 'TEST' });

    expect(hits.length).toBeGreaterThan(1);
    expect(hits[0].matchScore).toBeGreaterThanOrEqual(hits[1].matchScore);
  });
});

// ---------------------------------------------------------------------------
// T011 — updateList()
// ---------------------------------------------------------------------------

describe('updateList', () => {
  test('inserts entries and writes success sync event on first run', async () => {
    const listId = 'list-uuid-1';

    const client = makeTransactionClient([
      { rows: [] },              // BEGIN
      { rows: [] },              // SELECT existing → none
      { rows: [], rowCount: 1 }, // INSERT entry 12345
      { rows: [] },              // COMMIT
    ]);

    pool.query
      .mockResolvedValueOnce({ rows: [{ id: listId }] }) // _ensureList INSERT
      .mockResolvedValueOnce({ rows: [] })               // UPDATE screening_lists
      .mockResolvedValueOnce({ rows: [] });              // _writeSyncEvent
    pool.connect.mockResolvedValueOnce(client);

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_CSV),
    });

    const result = await makeProvider().updateList();

    expect(result.entriesAdded).toBe(1);
    expect(result.entriesRemoved).toBe(0);
    expect(result.entriesModified).toBe(0);
    expect(result.updated).toBe(true);
    expect(result.timestamp).toBeDefined();

    const syncCall = pool.query.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('screening_sync_events')
    );
    expect(syncCall).toBeDefined();
    expect(syncCall[1]).toContain('success');
  });

  test('reports zero changes on second run with identical data (idempotent)', async () => {
    const listId = 'list-uuid-1';

    // Exact match for the entry that SAMPLE_CSV produces
    const existingRow = {
      entry_id: '12345',
      primary_name: 'DOE John',
      aliases: ['SMITH John'],
      date_of_birth: '1970-01-01',
      nationalities: ['Iranian'],
      programs: ['Iran Sanctions'],
      remarks: null,
    };

    const client = makeTransactionClient([
      { rows: [] },             // BEGIN
      { rows: [existingRow] },  // SELECT existing → matches perfectly
      { rows: [] },             // COMMIT (no INSERT/UPDATE since _entryChanged returns false)
    ]);

    pool.query
      .mockResolvedValueOnce({ rows: [{ id: listId }] }) // _ensureList INSERT
      .mockResolvedValueOnce({ rows: [] })               // UPDATE screening_lists
      .mockResolvedValueOnce({ rows: [] });              // _writeSyncEvent
    pool.connect.mockResolvedValueOnce(client);

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_CSV),
    });

    const result = await makeProvider().updateList();

    expect(result.entriesAdded).toBe(0);
    expect(result.entriesRemoved).toBe(0);
    expect(result.entriesModified).toBe(0);
    expect(result.updated).toBe(false);
  });

  test('removes entries absent from the new CSV', async () => {
    const listId = 'list-uuid-1';

    const oldRow = {
      entry_id: 'OLD-ID',
      primary_name: 'OLD NAME',
      aliases: [],
      date_of_birth: null,
      nationalities: [],
      programs: [],
      remarks: null,
    };

    const client = makeTransactionClient([
      { rows: [] },              // BEGIN
      { rows: [oldRow] },        // SELECT existing → OLD-ID
      { rows: [], rowCount: 1 }, // INSERT 12345 (new)
      { rows: [], rowCount: 1 }, // DELETE OLD-ID (absent from new CSV)
      { rows: [] },              // COMMIT
    ]);

    pool.query
      .mockResolvedValueOnce({ rows: [{ id: listId }] }) // _ensureList
      .mockResolvedValueOnce({ rows: [] })               // UPDATE screening_lists
      .mockResolvedValueOnce({ rows: [] });              // _writeSyncEvent
    pool.connect.mockResolvedValueOnce(client);

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(SAMPLE_CSV),
    });

    const result = await makeProvider().updateList();

    expect(result.entriesAdded).toBe(1);
    expect(result.entriesRemoved).toBe(1);
  });

  test('writes failure sync event and rethrows when download fails', async () => {
    const provider = makeProvider();
    jest.spyOn(provider, '_downloadCSV').mockRejectedValue(new Error('Network unreachable'));
    pool.query.mockResolvedValueOnce({ rows: [] }); // _writeSyncEvent (failure)

    await expect(provider.updateList()).rejects.toThrow('Network unreachable');

    const syncCall = pool.query.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('screening_sync_events')
    );
    expect(syncCall).toBeDefined();
    expect(syncCall[1]).toContain('failure');
    expect(syncCall[1]).toContain('Network unreachable');
  });
});

// ---------------------------------------------------------------------------
// T022 — getListMetadata()
// ---------------------------------------------------------------------------

describe('getListMetadata', () => {
  test('returns all fields with isStale false for a recently updated list', async () => {
    const now = new Date();
    pool.query.mockResolvedValueOnce({
      rows: [{
        list_name: 'UK-HMT',
        list_type: 'sanctions',
        source_url: 'https://example.com/ConList.csv',
        last_updated: now,
        entry_count: 1234,
      }],
    });

    const meta = await makeProvider().getListMetadata();

    expect(meta.listName).toBe('UK-HMT');
    expect(meta.listType).toBe('sanctions');
    expect(meta.sourceUrl).toBe('https://example.com/ConList.csv');
    expect(meta.entryCount).toBe(1234);
    expect(meta.lastUpdated).toBe(now.toISOString());
    expect(meta.isStale).toBe(false);
  });

  test('returns isStale true for a timestamp older than 24 hours', async () => {
    const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    pool.query.mockResolvedValueOnce({
      rows: [{
        list_name: 'UK-HMT',
        list_type: 'sanctions',
        source_url: 'https://example.com',
        last_updated: staleTime,
        entry_count: 100,
      }],
    });

    const meta = await makeProvider().getListMetadata();
    expect(meta.isStale).toBe(true);
  });

  test('returns zero-entry default with isStale true when list has never been synced', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const meta = await makeProvider().getListMetadata();

    expect(meta.listName).toBe('UK-HMT');
    expect(meta.listType).toBe('sanctions');
    expect(meta.entryCount).toBe(0);
    expect(meta.lastUpdated).toBeNull();
    expect(meta.isStale).toBe(true);
  });
});
