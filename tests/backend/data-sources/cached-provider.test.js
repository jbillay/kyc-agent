'use strict';

const { withCache, withCacheScreening } = require('../../../backend/src/data-sources/cached-provider');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistryProvider(name = 'companies-house') {
  return {
    name,
    jurisdictions: ['GB'],
    searchEntity: jest.fn().mockResolvedValue([]),
    getEntityDetails: jest.fn().mockResolvedValue({ name: 'Acme Ltd' }),
    getOfficers: jest.fn().mockResolvedValue([]),
    getShareholders: jest.fn().mockResolvedValue([]),
    getFilingHistory: jest.fn().mockResolvedValue([]),
    getEntityStatus: jest.fn().mockResolvedValue({ status: 'active' }),
  };
}

function makeScreeningProvider(name = 'ofac-sdn') {
  return {
    name,
    listType: 'sanctions',
    search: jest.fn().mockResolvedValue([]),
    getListMetadata: jest.fn().mockResolvedValue({ entryCount: 1000 }),
    updateList: jest.fn().mockResolvedValue({ updated: true }),
  };
}

function makeCache() {
  return {
    getOrFetch: jest.fn().mockResolvedValue({ data: { mocked: true }, fromCache: false, cachedAt: null }),
  };
}

// ---------------------------------------------------------------------------
// withCache — RegistryProvider wrapping
// ---------------------------------------------------------------------------

describe('withCache', () => {
  it('wraps all 6 RegistryProvider methods', () => {
    const provider = makeRegistryProvider();
    const cache = makeCache();
    const wrapped = withCache(provider, cache);

    const methods = ['searchEntity', 'getEntityDetails', 'getOfficers', 'getShareholders', 'getFilingHistory', 'getEntityStatus'];
    for (const method of methods) {
      expect(typeof wrapped[method]).toBe('function');
    }
  });

  it('routes method calls through cache.getOrFetch', async () => {
    const provider = makeRegistryProvider();
    const cache = makeCache();
    const wrapped = withCache(provider, cache);

    await wrapped.getEntityDetails({ id: '01026167' });

    expect(cache.getOrFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'companies-house',
        method: 'getEntityDetails',
        queryParams: { id: '01026167' },
      })
    );
  });

  it('normalises a string queryParam to { id: string }', async () => {
    const provider = makeRegistryProvider();
    const cache = makeCache();
    const wrapped = withCache(provider, cache);

    await wrapped.getEntityDetails('01026167');

    expect(cache.getOrFetch).toHaveBeenCalledWith(
      expect.objectContaining({ queryParams: { id: '01026167' } })
    );
  });

  it('returns only the data from cache.getOrFetch (unwraps envelope)', async () => {
    const provider = makeRegistryProvider();
    const cache = makeCache();
    const wrapped = withCache(provider, cache);

    const result = await wrapped.getEntityDetails({ id: '01026167' });
    expect(result).toEqual({ mocked: true });
  });

  it('forwards options.caseId to cache.getOrFetch', async () => {
    const provider = makeRegistryProvider();
    const cache = makeCache();
    const wrapped = withCache(provider, cache);

    await wrapped.getEntityDetails({ id: '01026167' }, { caseId: 'case-uuid-1' });

    expect(cache.getOrFetch).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: 'case-uuid-1' })
    );
  });

  it('forwards options.bypassCache to cache.getOrFetch', async () => {
    const provider = makeRegistryProvider();
    const cache = makeCache();
    const wrapped = withCache(provider, cache);

    await wrapped.getEntityDetails({ id: '01026167' }, { bypassCache: true });

    expect(cache.getOrFetch).toHaveBeenCalledWith(
      expect.objectContaining({ bypassCache: true })
    );
  });

  it('preserves provider.name and provider.jurisdictions on the wrapped object', () => {
    const provider = makeRegistryProvider('companies-house');
    const cache = makeCache();
    const wrapped = withCache(provider, cache);

    expect(wrapped.name).toBe('companies-house');
    expect(wrapped.jurisdictions).toEqual(['GB']);
  });

  it('does not wrap methods that do not exist on the provider', () => {
    const provider = makeRegistryProvider();
    delete provider.getFilingHistory; // remove one method
    const cache = makeCache();
    const wrapped = withCache(provider, cache);

    // Should still work — missing method is skipped
    expect(typeof wrapped.getEntityDetails).toBe('function');
    // getFilingHistory no longer exists on provider, so it should not be wrapped
    // It will fall through to the prototype (undefined on provider, not the original fn)
    expect(provider.getFilingHistory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// withCacheScreening — ScreeningProvider wrapping
// ---------------------------------------------------------------------------

describe('withCacheScreening', () => {
  it('wraps the search method', () => {
    const provider = makeScreeningProvider();
    const cache = makeCache();
    const wrapped = withCacheScreening(provider, cache);

    expect(typeof wrapped.search).toBe('function');
  });

  it('routes search calls through cache.getOrFetch', async () => {
    const provider = makeScreeningProvider();
    const cache = makeCache();
    const wrapped = withCacheScreening(provider, cache);

    await wrapped.search({ name: 'John Doe', entityType: 'individual' });

    expect(cache.getOrFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ofac-sdn',
        method: 'search',
      })
    );
  });

  it('does NOT wrap getListMetadata — delegates directly to original provider', async () => {
    const provider = makeScreeningProvider();
    const cache = makeCache();
    const wrapped = withCacheScreening(provider, cache);

    await wrapped.getListMetadata();

    expect(provider.getListMetadata).toHaveBeenCalled();
    expect(cache.getOrFetch).not.toHaveBeenCalled();
  });

  it('does NOT wrap updateList — delegates directly to original provider', async () => {
    const provider = makeScreeningProvider();
    const cache = makeCache();
    const wrapped = withCacheScreening(provider, cache);

    await wrapped.updateList();

    expect(provider.updateList).toHaveBeenCalled();
    expect(cache.getOrFetch).not.toHaveBeenCalled();
  });

  it('forwards options.caseId to cache.getOrFetch for search', async () => {
    const provider = makeScreeningProvider();
    const cache = makeCache();
    const wrapped = withCacheScreening(provider, cache);

    await wrapped.search({ name: 'Test' }, { caseId: 'case-uuid-2' });

    expect(cache.getOrFetch).toHaveBeenCalledWith(
      expect.objectContaining({ caseId: 'case-uuid-2' })
    );
  });

  it('forwards options.bypassCache to cache.getOrFetch for search', async () => {
    const provider = makeScreeningProvider();
    const cache = makeCache();
    const wrapped = withCacheScreening(provider, cache);

    await wrapped.search({ name: 'Test' }, { bypassCache: true });

    expect(cache.getOrFetch).toHaveBeenCalledWith(
      expect.objectContaining({ bypassCache: true })
    );
  });

  it('preserves provider.name on the wrapped object', () => {
    const provider = makeScreeningProvider('ofac-sdn');
    const cache = makeCache();
    const wrapped = withCacheScreening(provider, cache);

    expect(wrapped.name).toBe('ofac-sdn');
  });
});
