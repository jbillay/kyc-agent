'use strict';

const REGISTRY_CACHED_METHODS = [
  'searchEntity',
  'getEntityDetails',
  'getOfficers',
  'getShareholders',
  'getFilingHistory',
  'getEntityStatus',
];

function withCache(provider, cache) {
  const wrapped = Object.create(provider);

  for (const method of REGISTRY_CACHED_METHODS) {
    if (typeof provider[method] !== 'function') continue;

    wrapped[method] = function (queryParams, options = {}) {
      const normalised = typeof queryParams === 'string' ? { id: queryParams } : queryParams;
      return cache
        .getOrFetch({
          provider: provider.name,
          method,
          queryParams: normalised,
          caseId: options.caseId,
          bypassCache: options.bypassCache || false,
          fetchFn: () => provider[method](queryParams),
        })
        .then((result) => result.data);
    };
  }

  return wrapped;
}

function withCacheScreening(provider, cache) {
  const wrapped = Object.create(provider);

  if (typeof provider.search === 'function') {
    wrapped.search = function (queryParams, options = {}) {
      const normalised = typeof queryParams === 'string' ? { id: queryParams } : queryParams;
      return cache
        .getOrFetch({
          provider: provider.name,
          method: 'search',
          queryParams: normalised,
          caseId: options.caseId,
          bypassCache: options.bypassCache || false,
          fetchFn: () => provider.search(queryParams),
        })
        .then((result) => result.data);
    };
  }

  return wrapped;
}

module.exports = { withCache, withCacheScreening };
