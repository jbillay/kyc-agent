'use strict';

// Mock the DB pool before any module loads
jest.mock('../../../../backend/db/connection', () => ({
  pool: {
    query: jest.fn(),
    connect: jest.fn(),
  },
}));

const { pool } = require('../../../../backend/db/connection');
const { OFACProvider } = require('../../../../backend/src/data-sources/screening/ofac');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sdnList>
  <sdnEntry>
    <uid>12345</uid>
    <sdnType>Individual</sdnType>
    <lastName>DOE</lastName>
    <firstName>JOHN</firstName>
    <programList>
      <program>SDGT</program>
      <program>IRAN</program>
    </programList>
    <akaList>
      <aka>
        <lastName>SMITH</lastName>
        <firstName>JACK</firstName>
      </aka>
      <aka>
        <lastName>JONES</lastName>
      </aka>
    </akaList>
    <dateOfBirthList>
      <dateOfBirthItem>
        <dateOfBirth>01 Jan 1970</dateOfBirth>
      </dateOfBirthItem>
    </dateOfBirthList>
    <nationalityList>
      <nationality>
        <country>Iran</country>
      </nationality>
    </nationalityList>
    <remarks>Test entry</remarks>
  </sdnEntry>
  <sdnEntry>
    <uid>99999</uid>
    <sdnType>Entity</sdnType>
    <lastName>EVIL CORP LLC</lastName>
    <programList>
      <program>SDGT</program>
    </programList>
  </sdnEntry>
</sdnList>`;

const SAMPLE_DB_ENTRY = {
  entry_id: '12345',
  primary_name: 'JOHN DOE',
  aliases: ['JACK SMITH', 'JONES'],
  date_of_birth: '01 Jan 1970',
  nationalities: ['Iran'],
  programs: ['SDGT', 'IRAN'],
  remarks: 'Test entry',
  raw_data: { uid: '12345' },
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
  return new OFACProvider(config, makeFuzzyMatcher(matcherOpts));
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
// T006 — _parseXML
// ---------------------------------------------------------------------------

describe('_parseXML', () => {
  test('extracts all fields from a well-formed individual entry', () => {
    const provider = makeProvider();
    const entries = provider._parseXML(SAMPLE_XML);
    const john = entries.find((e) => e.entryId === '12345');

    expect(john).toBeDefined();
    expect(john.primaryName).toBe('JOHN DOE');
    expect(john.entityType).toBe('individual');
    expect(john.aliases).toEqual(['JACK SMITH', 'JONES']);
    expect(john.programs).toEqual(['SDGT', 'IRAN']);
    expect(john.dateOfBirth).toBe('01 Jan 1970');
    expect(john.nationalities).toEqual(['Iran']);
    expect(john.remarks).toBe('Test entry');
    expect(john.rawData).toBeDefined();
  });

  test('maps sdnType=Individual to entityType individual', () => {
    const entries = makeProvider()._parseXML(SAMPLE_XML);
    expect(entries.find((e) => e.entryId === '12345').entityType).toBe('individual');
  });

  test('maps sdnType=Entity to entityType entity', () => {
    const entries = makeProvider()._parseXML(SAMPLE_XML);
    expect(entries.find((e) => e.entryId === '99999').entityType).toBe('entity');
  });

  test('extracts akaList entries as aliases array', () => {
    const aliases = makeProvider()._parseXML(SAMPLE_XML)
      .find((e) => e.entryId === '12345').aliases;
    expect(aliases).toContain('JACK SMITH');
    expect(aliases).toContain('JONES');
  });

  test('extracts programList entries as programs array', () => {
    const programs = makeProvider()._parseXML(SAMPLE_XML)
      .find((e) => e.entryId === '12345').programs;
    expect(programs).toContain('SDGT');
    expect(programs).toContain('IRAN');
  });

  test('uses lastName alone as primaryName when firstName is absent (entity)', () => {
    const entries = makeProvider()._parseXML(SAMPLE_XML);
    expect(entries.find((e) => e.entryId === '99999').primaryName).toBe('EVIL CORP LLC');
  });

  test('returns empty array for empty sdnList', () => {
    expect(makeProvider()._parseXML('<sdnList></sdnList>')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T007 — search()
// ---------------------------------------------------------------------------

describe('search', () => {
  test('returns score 100 for exact name match with all required fields', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_DB_ENTRY] });

    const provider = makeProvider({}, { threshold: 70, scores: { 'JOHN DOE|JOHN DOE': 100 } });
    const hits = await provider.search({ name: 'JOHN DOE', entityType: 'individual' });

    expect(hits).toHaveLength(1);
    expect(hits[0].matchScore).toBe(100);
    expect(hits[0].source).toBe('OFAC-SDN');
    expect(hits[0].matchedName).toBe('JOHN DOE');
    expect(hits[0].listEntry.id).toBe('12345');
    expect(hits[0].listEntry.names).toContain('JOHN DOE');
    expect(hits[0].listEntry.programs).toContain('SDGT');
    expect(hits[0].rawData).toBeDefined();
    expect(hits[0].matchedFields).toContain('name');
  });

  test('returns partial score for misspelled name above threshold', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_DB_ENTRY] });

    const provider = makeProvider({}, { threshold: 70, scores: { 'JON DOE|JOHN DOE': 85 } });
    const hits = await provider.search({ name: 'JON DOE', entityType: 'individual' });

    expect(hits).toHaveLength(1);
    expect(hits[0].matchScore).toBeGreaterThanOrEqual(70);
    expect(hits[0].matchScore).toBeLessThan(100);
  });

  test('returns empty array when no match meets threshold', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_DB_ENTRY] });

    // All comparisons return 0 (default in makeFuzzyMatcher when no score key matches)
    const provider = makeProvider({}, { threshold: 70, scores: {} });
    const hits = await provider.search({ name: 'UNRELATED NAME', entityType: 'individual' });
    expect(hits).toHaveLength(0);
  });

  test('boosts score by 10 when DOB matches', async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [SAMPLE_DB_ENTRY] })  // first search (no DOB)
      .mockResolvedValueOnce({ rows: [SAMPLE_DB_ENTRY] }); // second search (with DOB)

    const fm = makeFuzzyMatcher({ threshold: 70, scores: { 'JOHN DOE|JOHN DOE': 80 } });
    const provider = new OFACProvider({}, fm);

    const hitsNoDob = await provider.search({ name: 'JOHN DOE', entityType: 'individual' });
    const hitsWithDob = await provider.search({
      name: 'JOHN DOE',
      entityType: 'individual',
      dateOfBirth: '01 Jan 1970',
    });

    expect(hitsWithDob[0].matchScore).toBe(Math.min(100, hitsNoDob[0].matchScore + 10));
    expect(hitsWithDob[0].matchedFields).toContain('dateOfBirth');
  });

  test('boosts score by 5 when nationality matches', async () => {
    pool.query.mockResolvedValueOnce({ rows: [SAMPLE_DB_ENTRY] });

    const provider = makeProvider({}, { threshold: 70, scores: { 'JOHN DOE|JOHN DOE': 80 } });
    const hits = await provider.search({
      name: 'JOHN DOE',
      entityType: 'individual',
      nationality: 'Iran',
    });

    expect(hits[0].matchScore).toBe(85);
    expect(hits[0].matchedFields).toContain('nationality');
  });

  test('results are sorted by matchScore descending', async () => {
    const entries = [
      { ...SAMPLE_DB_ENTRY, entry_id: 'A', primary_name: 'ALICE', aliases: [] },
      { ...SAMPLE_DB_ENTRY, entry_id: 'B', primary_name: 'BOB', aliases: [] },
    ];
    pool.query.mockResolvedValueOnce({ rows: entries });

    const fm = makeFuzzyMatcher({ threshold: 70, scores: { 'TEST|ALICE': 90, 'TEST|BOB': 75 } });
    const provider = new OFACProvider({}, fm);

    const hits = await provider.search({ name: 'TEST', entityType: 'individual' });
    expect(hits.length).toBeGreaterThan(1);
    expect(hits[0].matchScore).toBeGreaterThanOrEqual(hits[1].matchScore);
  });
});

// ---------------------------------------------------------------------------
// T012 — updateList()
// ---------------------------------------------------------------------------

describe('updateList', () => {
  test('second run with identical data reports zero changes (idempotent)', async () => {
    const listId = 'list-uuid-1';
    // _upsertEntries now SELECTs all fields to compare; returning the same data
    // means _entryChanged() returns false → zero add/modify/remove
    const existingRow = {
      entry_id: '1',
      primary_name: 'DOE JOHN',
      aliases: [],
      date_of_birth: null,
      nationalities: [],
      programs: [],
      remarks: null,
    };
    const client = makeTransactionClient([
      { rows: [] },                      // BEGIN
      { rows: [existingRow] },           // SELECT all existing rows
      { rows: [] },                      // COMMIT (no INSERT/UPDATE needed)
    ]);

    pool.query
      .mockResolvedValueOnce({ rows: [{ id: listId }] })
      .mockResolvedValueOnce({ rows: [{
        list_name: 'OFAC-SDN', list_type: 'sanctions',
        source_url: 'http://x', last_updated: new Date(), entry_count: 1,
      }] })
      .mockResolvedValueOnce({ rows: [] })   // UPDATE screening_lists
      .mockResolvedValueOnce({ rows: [] });  // _writeSyncEvent (success)
    pool.connect.mockResolvedValueOnce(client);

    // XML produces an entry that matches existingRow exactly
    const xml = `<sdnList><sdnEntry><uid>1</uid><sdnType>Individual</sdnType>
      <lastName>JOHN</lastName><firstName>DOE</firstName></sdnEntry></sdnList>`;
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: () => Promise.resolve(xml) });

    const provider = makeProvider();
    provider._listId = listId;

    const result = await provider.updateList();

    expect(result.entriesAdded).toBe(0);
    expect(result.entriesRemoved).toBe(0);
    expect(result.entriesModified).toBe(0);
    expect(result.updated).toBe(false);
  });

  test('removes entries absent from the XML', async () => {
    const listId = 'list-uuid-2';
    const deleteSpy = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });

    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({ rows: [] })                              // BEGIN
        .mockResolvedValueOnce({ rows: [{ entry_id: 'stale-id' }] })     // existing IDs
        .mockResolvedValueOnce({ rows: [{ is_insert: true }] })           // upsert new-id
        .mockImplementationOnce((sql) => {                                // DELETE stale entries
          if (sql.includes('DELETE')) return deleteSpy();
          return Promise.resolve({ rows: [], rowCount: 0 });
        })
        .mockResolvedValueOnce({ rows: [] }),                             // COMMIT
      release: jest.fn(),
    };

    pool.query
      .mockResolvedValueOnce({ rows: [{ id: listId }] })
      .mockResolvedValueOnce({ rows: [{
        list_name: 'OFAC-SDN', list_type: 'sanctions',
        source_url: 'http://x', last_updated: new Date(), entry_count: 2,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    pool.connect.mockResolvedValueOnce(client);

    const xml = `<sdnList><sdnEntry><uid>new-id</uid><sdnType>Individual</sdnType>
      <lastName>NEW</lastName></sdnEntry></sdnList>`;
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: () => Promise.resolve(xml) });

    const provider = makeProvider();
    provider._listId = listId;

    const result = await provider.updateList();
    expect(result.entriesRemoved).toBe(1);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
  });

  test('retries download up to 3 times on network error then throws', async () => {
    jest.useFakeTimers();
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('Network error'));

    const provider = makeProvider();
    const promise = provider._downloadXML();

    // Attach the rejection handler BEFORE advancing timers to prevent
    // unhandled rejection warnings from Node.js
    const expectation = expect(promise).rejects.toThrow('Network error');

    // Advance through all retry delays (2s + 4s + 8s)
    await jest.runAllTimersAsync();
    await expectation;

    expect(fetchSpy).toHaveBeenCalledTimes(4); // attempt 1 + 3 retries

    jest.useRealTimers();
  });

  test('writes success row to screening_sync_events on completion', async () => {
    const listId = 'list-uuid-4';
    const syncEventRows = [];

    pool.query.mockImplementation((sql, params) => {
      if (sql && sql.includes('INSERT INTO screening_sync_events')) {
        syncEventRows.push(params);
        return Promise.resolve({ rows: [] });
      }
      if (sql && sql.includes('ON CONFLICT') && sql.includes('screening_lists')) {
        return Promise.resolve({ rows: [{ id: listId }] });
      }
      if (sql && sql.includes('SELECT') && sql.includes('screening_lists')) {
        return Promise.resolve({ rows: [{
          list_name: 'OFAC-SDN', list_type: 'sanctions',
          source_url: 'http://x', last_updated: new Date(), entry_count: 1,
        }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    pool.connect.mockResolvedValueOnce(makeTransactionClient([
      { rows: [] },
      { rows: [] },
      { rows: [{ is_insert: true }] },
      { rows: [] },
    ]));

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(
        `<sdnList><sdnEntry><uid>1</uid><sdnType>Individual</sdnType><lastName>DOE</lastName></sdnEntry></sdnList>`
      ),
    });

    const provider = makeProvider();
    provider._listId = listId;
    await provider.updateList();

    const successEvent = syncEventRows.find((p) => p && p[1] === 'success');
    expect(successEvent).toBeDefined();
    expect(successEvent[0]).toBe('OFAC-SDN');
  });
});

// ---------------------------------------------------------------------------
// T018 — _isStale() and stale_detected event
// ---------------------------------------------------------------------------

describe('_isStale', () => {
  const provider = makeProvider();

  test('returns true when lastUpdated is null', () => {
    expect(provider._isStale(null)).toBe(true);
  });

  test('returns true when lastUpdated is undefined', () => {
    expect(provider._isStale(undefined)).toBe(true);
  });

  test('returns true when lastUpdated is more than 24 hours ago', () => {
    const ts = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    expect(provider._isStale(ts)).toBe(true);
  });

  test('returns false when lastUpdated is within 24 hours', () => {
    const ts = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    expect(provider._isStale(ts)).toBe(false);
  });

  test('returns false when lastUpdated is just now', () => {
    expect(provider._isStale(new Date().toISOString())).toBe(false);
  });
});

describe('stale_detected event', () => {
  test('updateList emits stale_detected row when list is already stale', async () => {
    const listId = 'list-stale';
    const staleTs = new Date(Date.now() - 26 * 60 * 60 * 1000);
    const syncEventRows = [];

    pool.query.mockImplementation((sql, params) => {
      if (sql && sql.includes('INSERT INTO screening_sync_events')) {
        syncEventRows.push(params);
        return Promise.resolve({ rows: [] });
      }
      if (sql && sql.includes('ON CONFLICT')) {
        return Promise.resolve({ rows: [{ id: listId }] });
      }
      if (sql && sql.includes('SELECT') && sql.includes('screening_lists')) {
        return Promise.resolve({ rows: [{
          list_name: 'OFAC-SDN', list_type: 'sanctions',
          source_url: 'http://x', last_updated: staleTs, entry_count: 100,
        }] });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    pool.connect.mockResolvedValueOnce(makeTransactionClient([
      { rows: [] }, { rows: [] }, { rows: [] },
    ]));

    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<sdnList></sdnList>'),
    });

    const provider = makeProvider();
    provider._listId = listId;
    await provider.updateList();

    const staleEvent = syncEventRows.find((p) => p && p[1] === 'stale_detected');
    expect(staleEvent).toBeDefined();
    expect(staleEvent[0]).toBe('OFAC-SDN');
  });
});

// ---------------------------------------------------------------------------
// T022 — getListMetadata()
// ---------------------------------------------------------------------------

describe('getListMetadata', () => {
  test('returns default shape with isStale:true when no row exists', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const provider = makeProvider({ sourceUrl: 'https://example.com/sdn.xml' });
    const meta = await provider.getListMetadata();

    expect(meta.listName).toBe('OFAC-SDN');
    expect(meta.listType).toBe('sanctions');
    expect(meta.entryCount).toBe(0);
    expect(meta.lastUpdated).toBeNull();
    expect(meta.isStale).toBe(true);
    expect(meta.sourceUrl).toBe('https://example.com/sdn.xml');
  });

  test('returns correct values with isStale:false after a recent sync', async () => {
    const recent = new Date(Date.now() - 1 * 60 * 60 * 1000); // 1 hour ago
    pool.query.mockResolvedValueOnce({ rows: [{
      list_name: 'OFAC-SDN', list_type: 'sanctions',
      source_url: 'https://example.com/sdn.xml',
      last_updated: recent, entry_count: 12435,
    }] });

    const meta = await makeProvider().getListMetadata();

    expect(meta.entryCount).toBe(12435);
    expect(meta.lastUpdated).toBe(recent.toISOString());
    expect(meta.isStale).toBe(false);
  });

  test('returns isStale:true when last_updated is more than 24 hours ago', async () => {
    const stale = new Date(Date.now() - 26 * 60 * 60 * 1000);
    pool.query.mockResolvedValueOnce({ rows: [{
      list_name: 'OFAC-SDN', list_type: 'sanctions',
      source_url: 'http://x', last_updated: stale, entry_count: 5000,
    }] });

    const meta = await makeProvider().getListMetadata();
    expect(meta.isStale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T010 — _dobMatches
// ---------------------------------------------------------------------------

describe('_dobMatches', () => {
  const provider = makeProvider();

  test('matches identical date strings', () => {
    expect(provider._dobMatches('01 Jan 1970', '01 Jan 1970')).toBe(true);
  });

  test('matches when query is a numeric substring of entry', () => {
    expect(provider._dobMatches('1970', '01 Jan 1970')).toBe(true);
  });

  test('does not match unrelated dates', () => {
    expect(provider._dobMatches('15 Mar 1985', '01 Jan 1970')).toBe(false);
  });
});
