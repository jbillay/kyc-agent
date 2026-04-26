'use strict';

jest.mock('../../../backend/db/connection');

const { query } = require('../../../backend/db/connection');

const { DataSourceCache } = require('../../../backend/src/data-sources/cache');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides = {}) {
  return {
    id: 'row-uuid-1',
    response_data: { name: 'Acme Ltd' },
    fetched_at: new Date('2026-04-26T10:00:00Z').toISOString(),
    case_id: null,
    ...overrides,
  };
}

function mockHit(row = makeRow()) {
  query.mockResolvedValueOnce({ rows: [row] });
}

function mockMiss() {
  query.mockResolvedValueOnce({ rows: [] });
}

function mockWrite() {
  query.mockResolvedValueOnce({ rows: [] });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Hash correctness (scenarios 5 & 6)
// ---------------------------------------------------------------------------

describe('_hashQuery', () => {
  it('produces a 64-char hex string', () => {
    const cache = new DataSourceCache();
    const hash = cache._hashQuery('companies-house', 'getEntityDetails', { id: '01026167' });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — same inputs always produce the same hash', () => {
    const cache = new DataSourceCache();
    const a = cache._hashQuery('companies-house', 'getEntityDetails', { id: '01026167' });
    const b = cache._hashQuery('companies-house', 'getEntityDetails', { id: '01026167' });
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', () => {
    const cache = new DataSourceCache();
    const a = cache._hashQuery('companies-house', 'getEntityDetails', { id: '01026167' });
    const b = cache._hashQuery('companies-house', 'getEntityDetails', { id: '99999999' });
    expect(a).not.toBe(b);
  });

  it('produces different hashes when method differs', () => {
    const cache = new DataSourceCache();
    const a = cache._hashQuery('companies-house', 'getEntityDetails', { id: '01026167' });
    const b = cache._hashQuery('companies-house', 'getOfficers', { id: '01026167' });
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Cache miss (scenario 1)
// ---------------------------------------------------------------------------

describe('getOrFetch — cache miss', () => {
  it('calls fetchFn when no cached entry exists', async () => {
    const cache = new DataSourceCache();
    mockMiss();
    mockWrite();

    const fetchFn = jest.fn().mockResolvedValue({ name: 'Acme Ltd' });
    const result = await cache.getOrFetch({
      provider: 'companies-house',
      method: 'getEntityDetails',
      queryParams: { id: '01026167' },
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
    expect(result.cachedAt).toBeNull();
    expect(result.data).toEqual({ name: 'Acme Ltd' });
  });

  it('stores the fetched response in the database on miss', async () => {
    const cache = new DataSourceCache();
    mockMiss();
    mockWrite();

    const fetchFn = jest.fn().mockResolvedValue({ name: 'Acme Ltd' });
    await cache.getOrFetch({
      provider: 'companies-house',
      method: 'getEntityDetails',
      queryParams: { id: '01026167' },
      fetchFn,
    });

    const insertCall = query.mock.calls.find((c) => c[0].includes('INSERT'));
    expect(insertCall).toBeDefined();
    expect(insertCall[0]).toContain('ON CONFLICT DO NOTHING');
  });
});

// ---------------------------------------------------------------------------
// Cache hit (scenario 2)
// ---------------------------------------------------------------------------

describe('getOrFetch — cache hit', () => {
  it('does NOT call fetchFn when a valid cached entry exists', async () => {
    const cache = new DataSourceCache();
    mockHit();

    const fetchFn = jest.fn();
    const result = await cache.getOrFetch({
      provider: 'companies-house',
      method: 'getEntityDetails',
      queryParams: { id: '01026167' },
      fetchFn,
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(true);
    expect(result.data).toEqual({ name: 'Acme Ltd' });
    expect(result.cachedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TTL expiry (scenario 3)
// ---------------------------------------------------------------------------

describe('getOrFetch — TTL expiry', () => {
  it('fetches fresh data when no valid entry exists (expired or absent)', async () => {
    const cache = new DataSourceCache();
    mockMiss(); // _lookup returns nothing (expired entry filtered by WHERE expires_at > NOW())
    mockWrite();

    const fetchFn = jest.fn().mockResolvedValue({ fresh: true });
    const result = await cache.getOrFetch({
      provider: 'ofac-sdn',
      method: 'search',
      queryParams: { name: 'John Doe' },
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
  });

  it('calls _store with provider-specific TTL (1h for ofac-sdn)', async () => {
    const cache = new DataSourceCache();
    mockMiss();
    mockWrite();

    const fetchFn = jest.fn().mockResolvedValue({});
    await cache.getOrFetch({
      provider: 'ofac-sdn',
      method: 'search',
      queryParams: { name: 'Test' },
      fetchFn,
    });

    const insertCall = query.mock.calls.find((c) => c[0].includes('INSERT'));
    expect(insertCall[1][4]).toBe(1); // ttlHours = 1
  });

  it('calls _store with 24h TTL for a 24h provider (companies-house)', async () => {
    const cache = new DataSourceCache();
    mockMiss();
    mockWrite();

    const fetchFn = jest.fn().mockResolvedValue({});
    await cache.getOrFetch({
      provider: 'companies-house',
      method: 'getEntityDetails',
      queryParams: { id: '01026167' },
      fetchFn,
    });

    const insertCall = query.mock.calls.find((c) => c[0].includes('INSERT'));
    expect(insertCall[1][4]).toBe(24);
  });

  it('serves cache hit without calling fetchFn for a provider within its window', async () => {
    const cache = new DataSourceCache();
    mockHit();

    const fetchFn = jest.fn();
    const result = await cache.getOrFetch({
      provider: 'companies-house',
      method: 'getEntityDetails',
      queryParams: { id: '01026167' },
      fetchFn,
    });

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bypass cache (scenario 4)
// ---------------------------------------------------------------------------

describe('getOrFetch — bypassCache', () => {
  it('always calls fetchFn when bypassCache is true, even when a valid entry exists', async () => {
    const cache = new DataSourceCache();
    // No mock for _lookup — bypassCache skips it entirely
    mockWrite();

    const fetchFn = jest.fn().mockResolvedValue({ forced: true });
    const result = await cache.getOrFetch({
      provider: 'companies-house',
      method: 'getEntityDetails',
      queryParams: { id: '01026167' },
      bypassCache: true,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
    // _lookup (SELECT) should NOT have been called
    const selectCall = query.mock.calls.find((c) => c[0].includes('SELECT'));
    expect(selectCall).toBeUndefined();
  });

  it('stores the fresh response even when bypassCache is true', async () => {
    const cache = new DataSourceCache();
    mockWrite();

    const fetchFn = jest.fn().mockResolvedValue({ fresh: true });
    await cache.getOrFetch({
      provider: 'companies-house',
      method: 'getEntityDetails',
      queryParams: { id: '01026167' },
      bypassCache: true,
      fetchFn,
    });

    const insertCall = query.mock.calls.find((c) => c[0].includes('INSERT'));
    expect(insertCall).toBeDefined();
  });

  it('never issues a DELETE when bypassCache is true', async () => {
    const cache = new DataSourceCache();
    mockWrite();

    const fetchFn = jest.fn().mockResolvedValue({});
    await cache.getOrFetch({
      provider: 'companies-house',
      method: 'getEntityDetails',
      queryParams: { id: '01026167' },
      bypassCache: true,
      fetchFn,
    });

    const deleteCall = query.mock.calls.find((c) => c[0].toUpperCase().includes('DELETE'));
    expect(deleteCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Metrics (scenario 7)
// ---------------------------------------------------------------------------

describe('getMetrics / resetMetrics', () => {
  it('accurately counts hits and misses', async () => {
    const cache = new DataSourceCache();

    // miss
    mockMiss(); mockWrite();
    await cache.getOrFetch({ provider: 'companies-house', method: 'getEntityDetails', queryParams: { id: '1' }, fetchFn: jest.fn().mockResolvedValue({}) });

    // miss
    mockMiss(); mockWrite();
    await cache.getOrFetch({ provider: 'companies-house', method: 'getEntityDetails', queryParams: { id: '1' }, fetchFn: jest.fn().mockResolvedValue({}) });

    // hit
    mockHit();
    await cache.getOrFetch({ provider: 'companies-house', method: 'getEntityDetails', queryParams: { id: '1' }, fetchFn: jest.fn() });

    const metrics = cache.getMetrics();
    expect(metrics.hits).toBe(1);
    expect(metrics.misses).toBe(2);
    expect(metrics.hitRate).toBeCloseTo(1 / 3);
  });

  it('returns hitRate of 0 when no lookups have been performed', () => {
    const cache = new DataSourceCache();
    expect(cache.getMetrics()).toEqual({ hits: 0, misses: 0, hitRate: 0 });
  });

  it('resets counters to zero after resetMetrics()', async () => {
    const cache = new DataSourceCache();
    mockMiss(); mockWrite();
    await cache.getOrFetch({ provider: 'companies-house', method: 'getEntityDetails', queryParams: { id: '1' }, fetchFn: jest.fn().mockResolvedValue({}) });

    cache.resetMetrics();
    expect(cache.getMetrics()).toEqual({ hits: 0, misses: 0, hitRate: 0 });
  });
});

// ---------------------------------------------------------------------------
// Case linking (scenario 8 & 9)
// ---------------------------------------------------------------------------

describe('getOrFetch — case linking', () => {
  it('passes caseId to _store on cache miss', async () => {
    const cache = new DataSourceCache();
    mockMiss();
    mockWrite();

    const fetchFn = jest.fn().mockResolvedValue({ name: 'Acme' });
    await cache.getOrFetch({
      provider: 'companies-house',
      method: 'getEntityDetails',
      queryParams: { id: '01026167' },
      caseId: 'case-uuid-1',
      fetchFn,
    });

    const insertCall = query.mock.calls.find((c) => c[0].includes('INSERT'));
    expect(insertCall[1][5]).toBe('case-uuid-1'); // caseId is 6th param ($6)
  });

  it('calls _linkToCase when cache hit has no case_id and caseId is provided', async () => {
    const cache = new DataSourceCache();
    mockHit(makeRow({ case_id: null })); // hit with no case linked
    mockWrite(); // for _linkToCase UPDATE

    const fetchFn = jest.fn();
    await cache.getOrFetch({
      provider: 'companies-house',
      method: 'getEntityDetails',
      queryParams: { id: '01026167' },
      caseId: 'case-uuid-1',
      fetchFn,
    });

    expect(fetchFn).not.toHaveBeenCalled();
    const updateCall = query.mock.calls.find((c) => c[0].includes('UPDATE'));
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBe('case-uuid-1');
  });

  it('does NOT call _linkToCase when cached entry already has a case_id', async () => {
    const cache = new DataSourceCache();
    mockHit(makeRow({ case_id: 'existing-case-uuid' }));

    const fetchFn = jest.fn();
    await cache.getOrFetch({
      provider: 'companies-house',
      method: 'getEntityDetails',
      queryParams: { id: '01026167' },
      caseId: 'new-case-uuid',
      fetchFn,
    });

    const updateCall = query.mock.calls.find((c) => c[0].includes('UPDATE'));
    expect(updateCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Audit retention — append-only (scenario 10)
// ---------------------------------------------------------------------------

describe('audit retention', () => {
  it('never issues a DELETE when inserting new entries', async () => {
    const cache = new DataSourceCache();

    // Two sequential misses — two inserts
    mockMiss(); mockWrite();
    await cache.getOrFetch({ provider: 'companies-house', method: 'getEntityDetails', queryParams: { id: '1' }, fetchFn: jest.fn().mockResolvedValue({}) });

    mockMiss(); mockWrite();
    await cache.getOrFetch({ provider: 'companies-house', method: 'getEntityDetails', queryParams: { id: '1' }, fetchFn: jest.fn().mockResolvedValue({}) });

    const insertCalls = query.mock.calls.filter((c) => c[0].includes('INSERT'));
    const deleteCalls = query.mock.calls.filter((c) => c[0].toUpperCase().includes('DELETE'));
    expect(insertCalls).toHaveLength(2);
    expect(deleteCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Unrecognised provider — default TTL fallback (scenario 11)
// ---------------------------------------------------------------------------

describe('getOrFetch — unrecognised provider', () => {
  it('falls back to 24h default TTL for unknown providers', async () => {
    const cache = new DataSourceCache();
    mockMiss();
    mockWrite();

    const fetchFn = jest.fn().mockResolvedValue({});
    await cache.getOrFetch({
      provider: 'unknown-provider-xyz',
      method: 'someMethod',
      queryParams: {},
      fetchFn,
    });

    const insertCall = query.mock.calls.find((c) => c[0].includes('INSERT'));
    expect(insertCall[1][4]).toBe(24);
  });

  it('respects custom TTL overrides passed at construction', async () => {
    const cache = new DataSourceCache({ ttlHours: { 'custom-provider': 6 } });
    mockMiss();
    mockWrite();

    const fetchFn = jest.fn().mockResolvedValue({});
    await cache.getOrFetch({
      provider: 'custom-provider',
      method: 'getData',
      queryParams: {},
      fetchFn,
    });

    const insertCall = query.mock.calls.find((c) => c[0].includes('INSERT'));
    expect(insertCall[1][4]).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Error propagation (scenario 12)
// ---------------------------------------------------------------------------

describe('getOrFetch — error propagation', () => {
  it('propagates errors from fetchFn directly with no fallback', async () => {
    const cache = new DataSourceCache();
    mockMiss();

    const err = new Error('External API unreachable');
    const fetchFn = jest.fn().mockRejectedValue(err);

    await expect(
      cache.getOrFetch({
        provider: 'companies-house',
        method: 'getEntityDetails',
        queryParams: { id: '01026167' },
        fetchFn,
      })
    ).rejects.toThrow('External API unreachable');
  });

  it('increments misses counter before fetchFn throws', async () => {
    const cache = new DataSourceCache();
    mockMiss();

    const fetchFn = jest.fn().mockRejectedValue(new Error('Network error'));
    await cache.getOrFetch({ provider: 'p', method: 'm', queryParams: {}, fetchFn }).catch(() => {});

    expect(cache.getMetrics().misses).toBe(1);
  });
});
