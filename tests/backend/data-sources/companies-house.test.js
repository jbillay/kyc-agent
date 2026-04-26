'use strict';

const {
  CompaniesHouseProvider,
} = require('../../../backend/src/data-sources/registry/companies-house');
const {
  RegistryFactory,
} = require('../../../backend/src/data-sources/registry-factory');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOkResponse(body) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  };
}

function makeErrorResponse(status) {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({}),
  };
}

function mockFetch(response) {
  return jest.spyOn(global, 'fetch').mockResolvedValue(response);
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let provider;

beforeEach(() => {
  provider = new CompaniesHouseProvider({
    apiKey: 'test-key',
    timeoutMs: 1000,
    maxQueueWaitMs: 30000,
  });
  // Start with a full bucket so tests don't wait on rate limiting
  provider._tokens = 600;
  provider._lastRefill = Date.now();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// T007 — Foundational layer: _acquireToken, _retry, timeout
// ---------------------------------------------------------------------------

describe('_acquireToken', () => {
  it('decrements tokens on each successful call', async () => {
    provider._tokens = 10;
    provider._lastRefill = Date.now();
    await provider._acquireToken();
    // Allow for tiny floating-point refill in the elapsed ≈ 0ms window
    expect(provider._tokens).toBeLessThanOrEqual(9.01);
    expect(provider._tokens).toBeGreaterThanOrEqual(8.9);
  });

  it('throws RATE_LIMITED when queue wait would exceed maxQueueWaitMs', async () => {
    provider._tokens = 0;
    provider._lastRefill = Date.now();
    provider.maxQueueWaitMs = 10; // cap at 10ms; wait would be 500ms
    await expect(provider._acquireToken()).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  }, 1000);

  it('resolves normally when wait is within maxQueueWaitMs', async () => {
    // waitMs ≈ 1ms (tokens almost at 1)
    provider._tokens = 0.998;
    provider._lastRefill = Date.now();
    provider.maxQueueWaitMs = 5000;
    await expect(provider._acquireToken()).resolves.toBeUndefined();
  }, 1000);
});

describe('_retry (via _get) and timeout', () => {
  beforeEach(() => {
    // Isolate retry tests from rate-limiter logic
    jest.spyOn(provider, '_acquireToken').mockResolvedValue(undefined);
    jest.useFakeTimers();
  });

  it('retries up to 3 times on transient 5xx errors', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeErrorResponse(503))
      .mockResolvedValueOnce(makeOkResponse({ items: [] }));

    const promise = provider._get('/test');
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ items: [] });
  });

  it('propagates error after all 3 retries exhausted', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValue(makeErrorResponse(503));

    const promise = provider._get('/test');
    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const assertion = expect(promise).rejects.toMatchObject({ statusCode: 503 });
    await jest.advanceTimersByTimeAsync(2000);
    await assertion;

    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 404 NOT_FOUND', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValue(makeErrorResponse(404));

    // No timer advancement needed — 404 throws immediately without delay
    await expect(provider._get('/test')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry on 429 RATE_LIMITED', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValue(makeErrorResponse(429));

    // No timer advancement needed — 429 throws immediately without delay
    await expect(provider._get('/test')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('succeeds on the 3rd attempt after 2 transient failures', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeErrorResponse(500))
      .mockResolvedValueOnce(makeOkResponse({ data: 'ok' }));

    const promise = provider._get('/test');
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ data: 'ok' });
  });
});

describe('_get timeout', () => {
  it('aborts request after timeoutMs and does not retry', async () => {
    jest.spyOn(provider, '_acquireToken').mockResolvedValue(undefined);

    let callCount = 0;
    jest.spyOn(global, 'fetch').mockImplementation((_url, { signal }) => {
      callCount++;
      return new Promise((_res, rej) => {
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          rej(err);
        });
      });
    });

    provider.timeoutMs = 20;
    await expect(provider._get('/test')).rejects.toMatchObject({ name: 'AbortError' });
    expect(callCount).toBe(1);
  }, 500);
});

// ---------------------------------------------------------------------------
// T009 — US1: searchEntity
// ---------------------------------------------------------------------------

describe('searchEntity', () => {
  it('maps CH search response to EntitySearchResult[]', async () => {
    mockFetch(
      makeOkResponse({
        items: [
          {
            company_number: '01026167',
            title: 'BARCLAYS BANK PLC',
            company_status: 'active',
            company_type: 'plc',
            date_of_creation: '1896-07-20',
            snippet: 'bank',
          },
          {
            company_number: '00026169',
            title: 'BARCLAYS PLC',
            company_status: 'active',
            company_type: 'plc',
            date_of_creation: '1896-01-01',
            snippet: undefined,
          },
        ],
      })
    );

    const results = await provider.searchEntity({ name: 'Barclays' });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      entityId: '01026167',
      name: 'BARCLAYS BANK PLC',
      registrationNumber: '01026167',
      jurisdiction: 'GB',
      incorporationDate: '1896-07-20',
      status: 'active',
      entityType: 'plc',
      relevanceScore: 100,
    });
    expect(results[0].rawData).toBeDefined();
    expect(results[1].relevanceScore).toBe(80); // no snippet
  });

  it('returns empty array when no matches found', async () => {
    mockFetch(makeOkResponse({ items: [] }));
    const results = await provider.searchEntity({ name: 'nonexistent-xyz' });
    expect(results).toEqual([]);
  });

  it('returns empty array when items key is absent', async () => {
    mockFetch(makeOkResponse({}));
    const results = await provider.searchEntity({ name: 'test' });
    expect(results).toEqual([]);
  });

  it('propagates RATE_LIMITED error from registry', async () => {
    mockFetch(makeErrorResponse(429));
    await expect(provider.searchEntity({ name: 'test' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});

// ---------------------------------------------------------------------------
// T011 — US2: getEntityDetails
// ---------------------------------------------------------------------------

describe('getEntityDetails', () => {
  const fullProfile = {
    company_number: '01026167',
    company_name: 'BARCLAYS BANK PLC',
    date_of_creation: '1896-07-20',
    type: 'plc',
    company_status: 'active',
    registered_office_address: {
      address_line_1: '1 Churchill Place',
      address_line_2: 'Canary Wharf',
      locality: 'London',
      postal_code: 'E14 5HP',
      country: 'United Kingdom',
    },
    sic_codes: ['64110'],
    previous_company_names: [
      { name: 'BARCLAY & CO LIMITED', effective_from: '1896-07-20', ceased_on: '1917-01-01' },
      { name: 'BARCLAYS BANK LIMITED', effective_from: '1917-01-01', ceased_on: null },
    ],
  };

  it('maps full CH profile response to EntityDetails', async () => {
    mockFetch(makeOkResponse(fullProfile));
    const details = await provider.getEntityDetails('01026167');

    expect(details).toMatchObject({
      registrationNumber: '01026167',
      name: 'BARCLAYS BANK PLC',
      jurisdiction: 'GB',
      incorporationDate: '1896-07-20',
      entityType: 'plc',
      status: 'active',
      sicCodes: ['64110'],
    });

    expect(details.registeredAddress).toMatchObject({
      addressLine1: '1 Churchill Place',
      addressLine2: 'Canary Wharf',
      locality: 'London',
      postalCode: 'E14 5HP',
      country: 'United Kingdom',
    });

    expect(details.rawData).toBe(fullProfile);
  });

  it('maps previousNames with effectiveTo null for open-ended names', async () => {
    mockFetch(makeOkResponse(fullProfile));
    const details = await provider.getEntityDetails('01026167');

    expect(details.previousNames).toHaveLength(2);
    expect(details.previousNames[0]).toMatchObject({
      name: 'BARCLAY & CO LIMITED',
      effectiveFrom: '1896-07-20',
      effectiveTo: '1917-01-01',
    });
    expect(details.previousNames[1]).toMatchObject({
      name: 'BARCLAYS BANK LIMITED',
      effectiveTo: null,
    });
  });

  it('returns empty sicCodes when absent', async () => {
    const profileNoSic = { ...fullProfile, sic_codes: undefined };
    mockFetch(makeOkResponse(profileNoSic));
    const details = await provider.getEntityDetails('01026167');
    expect(details.sicCodes).toEqual([]);
  });

  it('uses default address values when address fields are absent', async () => {
    const profileNoAddr = { ...fullProfile, registered_office_address: {} };
    mockFetch(makeOkResponse(profileNoAddr));
    const details = await provider.getEntityDetails('01026167');
    expect(details.registeredAddress.addressLine1).toBe('');
    expect(details.registeredAddress.locality).toBe('');
    expect(details.registeredAddress.country).toBe('United Kingdom');
  });

  it('throws NOT_FOUND on 404', async () => {
    mockFetch(makeErrorResponse(404));
    await expect(provider.getEntityDetails('INVALID')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

// ---------------------------------------------------------------------------
// T014 — US3: getOfficers
// ---------------------------------------------------------------------------

describe('getOfficers', () => {
  it('maps officer response to Officer[] with YYYY-MM dateOfBirth', async () => {
    mockFetch(
      makeOkResponse({
        total_results: 1,
        items: [
          {
            name: 'SMITH, John David',
            officer_role: 'director',
            appointed_on: '2010-03-15',
            nationality: 'British',
            date_of_birth: { year: 1965, month: 8 },
            address: { premises: '1 Main St' },
          },
        ],
      })
    );

    const officers = await provider.getOfficers('01026167');

    expect(officers).toHaveLength(1);
    expect(officers[0]).toMatchObject({
      name: 'SMITH, John David',
      role: 'director',
      appointedDate: '2010-03-15',
      nationality: 'British',
      dateOfBirth: '1965-08',
    });
    expect(officers[0].resignedDate).toBeUndefined();
    expect(officers[0].rawData).toBeDefined();
  });

  it('pads single-digit month in dateOfBirth to YYYY-MM', async () => {
    mockFetch(
      makeOkResponse({
        total_results: 1,
        items: [{ name: 'TEST', officer_role: 'director', appointed_on: '2020-01-01', date_of_birth: { year: 1980, month: 3 } }],
      })
    );
    const [officer] = await provider.getOfficers('12345');
    expect(officer.dateOfBirth).toBe('1980-03');
  });

  it('includes resignedDate for resigned officers', async () => {
    mockFetch(
      makeOkResponse({
        total_results: 1,
        items: [
          {
            name: 'JONES, Alice',
            officer_role: 'secretary',
            appointed_on: '2005-06-01',
            resigned_on: '2015-12-31',
          },
        ],
      })
    );
    const [officer] = await provider.getOfficers('01026167');
    expect(officer.resignedDate).toBe('2015-12-31');
  });

  it('omits resignedDate for active officers', async () => {
    mockFetch(
      makeOkResponse({
        total_results: 1,
        items: [{ name: 'ACTIVE', officer_role: 'director', appointed_on: '2020-01-01' }],
      })
    );
    const [officer] = await provider.getOfficers('01026167');
    expect(officer.resignedDate).toBeUndefined();
  });

  it('paginates across multiple pages when total_results > page size', async () => {
    const page1Items = Array.from({ length: 50 }, (_, i) => ({
      name: `OFFICER_${i}`,
      officer_role: 'director',
      appointed_on: '2020-01-01',
    }));
    const page2Items = Array.from({ length: 10 }, (_, i) => ({
      name: `OFFICER_${50 + i}`,
      officer_role: 'director',
      appointed_on: '2020-01-01',
    }));

    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce(makeOkResponse({ total_results: 60, items: page1Items }))
      .mockResolvedValueOnce(makeOkResponse({ total_results: 60, items: page2Items }));

    const officers = await provider.getOfficers('01026167');

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(officers).toHaveLength(60);
    expect(officers[59].name).toBe('OFFICER_59');
  });

  it('throws NOT_FOUND when company does not exist', async () => {
    mockFetch(makeErrorResponse(404));
    await expect(provider.getOfficers('INVALID')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

// ---------------------------------------------------------------------------
// T016 — US4: getShareholders
// ---------------------------------------------------------------------------

describe('getShareholders', () => {
  it('constructs name from name_elements when item.name is absent', async () => {
    mockFetch(
      makeOkResponse({
        items: [
          {
            kind: 'individual-person-with-significant-control',
            name_elements: { forename: 'Alice', surname: 'Johnson' },
            natures_of_control: ['ownership-of-shares-25-to-50-percent'],
            notified_on: '2016-04-06',
          },
        ],
      })
    );

    const [shareholder] = await provider.getShareholders('01026167');
    expect(shareholder.name).toBe('Alice Johnson');
    expect(shareholder.type).toBe('individual');
    expect(shareholder.ownershipPercentage).toBe('25-50');
  });

  it('uses item.name directly when present', async () => {
    mockFetch(
      makeOkResponse({
        items: [
          {
            name: 'BIG CORP LTD',
            kind: 'corporate-entity-with-significant-control',
            natures_of_control: ['ownership-of-shares-75-to-100-percent'],
            notified_on: '2016-04-06',
            identification: {
              registration_number: '12345678',
              country_registered: 'United Kingdom',
            },
          },
        ],
      })
    );

    const [shareholder] = await provider.getShareholders('01026167');
    expect(shareholder.name).toBe('BIG CORP LTD');
    expect(shareholder.type).toBe('corporate');
    expect(shareholder.ownershipPercentage).toBe('75-100');
    expect(shareholder.registrationNumber).toBe('12345678');
    expect(shareholder.jurisdiction).toBe('GB');
  });

  it('maps ceased PSC with ceasedDate', async () => {
    mockFetch(
      makeOkResponse({
        items: [
          {
            name: 'FORMER OWNER',
            kind: 'individual-person-with-significant-control',
            natures_of_control: ['ownership-of-shares-50-to-75-percent'],
            notified_on: '2016-04-06',
            ceased_on: '2020-01-01',
          },
        ],
      })
    );

    const [shareholder] = await provider.getShareholders('01026167');
    expect(shareholder.ceasedDate).toBe('2020-01-01');
    expect(shareholder.ownershipPercentage).toBe('50-75');
  });

  it('classifies PSC kinds correctly', () => {
    expect(provider._classifyPSCType('individual-person-with-significant-control')).toBe('individual');
    expect(provider._classifyPSCType('corporate-entity-with-significant-control')).toBe('corporate');
    expect(provider._classifyPSCType('legal-person-with-significant-control')).toBe('corporate');
    expect(provider._classifyPSCType('unknown-kind')).toBe('other');
    expect(provider._classifyPSCType(undefined)).toBe('other');
  });

  it('extracts ownership percentage ranges correctly', () => {
    expect(provider._extractOwnershipPercentage(['ownership-of-shares-75-to-100-percent'])).toBe('75-100');
    expect(provider._extractOwnershipPercentage(['ownership-of-shares-50-to-75-percent'])).toBe('50-75');
    expect(provider._extractOwnershipPercentage(['ownership-of-shares-25-to-50-percent'])).toBe('25-50');
    expect(provider._extractOwnershipPercentage(['ownership-of-shares-more-than-25-percent'])).toBe('25-50');
    expect(provider._extractOwnershipPercentage(['voting-rights-less-than-25-percent'])).toBeUndefined();
    expect(provider._extractOwnershipPercentage(null)).toBeUndefined();
  });

  it('returns empty array when items is absent (exempt company)', async () => {
    mockFetch(makeOkResponse({}));
    const shareholders = await provider.getShareholders('01026167');
    expect(shareholders).toEqual([]);
  });

  it('returns empty array for empty items', async () => {
    mockFetch(makeOkResponse({ items: [] }));
    const shareholders = await provider.getShareholders('01026167');
    expect(shareholders).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T018 — US5: getEntityStatus
// ---------------------------------------------------------------------------

describe('getEntityStatus', () => {
  it('sets accountsOverdue from accounts.overdue flag', async () => {
    mockFetch(
      makeOkResponse({
        company_status: 'active',
        accounts: { overdue: true },
        confirmation_statement: { overdue: false },
      })
    );

    const status = await provider.getEntityStatus('01026167');
    expect(status.accountsOverdue).toBe(true);
    expect(status.annualReturnOverdue).toBe(false);
    expect(status.status).toBe('active');
  });

  it('sets annualReturnOverdue from confirmation_statement.overdue when annual_return absent', async () => {
    mockFetch(
      makeOkResponse({
        company_status: 'active',
        accounts: { overdue: false },
        confirmation_statement: { overdue: true },
      })
    );

    const status = await provider.getEntityStatus('01026167');
    expect(status.annualReturnOverdue).toBe(true);
  });

  it('sets annualReturnOverdue from annual_return.overdue', async () => {
    mockFetch(
      makeOkResponse({
        company_status: 'active',
        annual_return: { overdue: true },
        accounts: { overdue: false },
      })
    );

    const status = await provider.getEntityStatus('01026167');
    expect(status.annualReturnOverdue).toBe(true);
  });

  it('includes previously-liquidated in activeNotices', async () => {
    mockFetch(
      makeOkResponse({
        company_status: 'active',
        has_been_liquidated: true,
        accounts: { overdue: false },
        confirmation_statement: { overdue: false },
      })
    );

    const status = await provider.getEntityStatus('01026167');
    expect(status.activeNotices).toContain('previously-liquidated');
  });

  it('includes insolvency-history in activeNotices', async () => {
    mockFetch(
      makeOkResponse({
        company_status: 'active',
        has_insolvency_history: true,
        accounts: { overdue: false },
        confirmation_statement: { overdue: false },
      })
    );

    const status = await provider.getEntityStatus('01026167');
    expect(status.activeNotices).toContain('insolvency-history');
  });

  it('includes company_status_detail in activeNotices for active companies', async () => {
    mockFetch(
      makeOkResponse({
        company_status: 'active',
        company_status_detail: 'first-gazette',
        accounts: { overdue: false },
        confirmation_statement: { overdue: false },
      })
    );

    const status = await provider.getEntityStatus('01026167');
    expect(status.activeNotices).toContain('first-gazette');
  });

  it('returns empty activeNotices for a clean active company', async () => {
    mockFetch(
      makeOkResponse({
        company_status: 'active',
        accounts: { overdue: false },
        confirmation_statement: { overdue: false },
      })
    );

    const status = await provider.getEntityStatus('01026167');
    expect(status.activeNotices).toEqual([]);
    expect(status.accountsOverdue).toBe(false);
    expect(status.annualReturnOverdue).toBe(false);
  });

  it('includes dissolvedDate for dissolved companies', async () => {
    mockFetch(
      makeOkResponse({
        company_status: 'dissolved',
        date_of_cessation: '2020-06-15',
        accounts: {},
        confirmation_statement: {},
      })
    );

    const status = await provider.getEntityStatus('01026167');
    expect(status.status).toBe('dissolved');
    expect(status.dissolvedDate).toBe('2020-06-15');
  });

  it('throws NOT_FOUND on 404', async () => {
    mockFetch(makeErrorResponse(404));
    await expect(provider.getEntityStatus('INVALID')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('preserves rawData', async () => {
    const raw = { company_status: 'active', accounts: {}, confirmation_statement: {} };
    mockFetch(makeOkResponse(raw));
    const status = await provider.getEntityStatus('01026167');
    expect(status.rawData).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// T020 — US6: getFilingHistory
// ---------------------------------------------------------------------------

describe('getFilingHistory', () => {
  it('maps filing history response to Filing[]', async () => {
    mockFetch(
      makeOkResponse({
        items: [
          { type: 'CS01', description: 'Confirmation statement', date: '2024-03-01', category: 'confirmation-statement' },
          { type: 'AA', description: 'Annual accounts', date: '2024-01-15', category: 'accounts' },
          { type: 'AD01', description: 'Change of registered office', date: '2023-11-20' },
        ],
      })
    );

    const filings = await provider.getFilingHistory('01026167');

    expect(filings).toHaveLength(3);
    expect(filings[0]).toMatchObject({
      filingType: 'CS01',
      description: 'Confirmation statement',
      date: '2024-03-01',
      category: 'confirmation-statement',
    });
    expect(filings[0].rawData).toBeDefined();
    expect(filings[2].category).toBeUndefined(); // no category in source
  });

  it('falls back to filingType when description is absent', async () => {
    mockFetch(
      makeOkResponse({
        items: [{ type: 'MISC', date: '2024-01-01' }],
      })
    );

    const [filing] = await provider.getFilingHistory('01026167');
    expect(filing.description).toBe('MISC');
    expect(filing.filingType).toBe('MISC');
  });

  it('returns empty array when items is absent', async () => {
    mockFetch(makeOkResponse({}));
    const filings = await provider.getFilingHistory('01026167');
    expect(filings).toEqual([]);
  });

  it('returns empty array for empty items', async () => {
    mockFetch(makeOkResponse({ items: [] }));
    const filings = await provider.getFilingHistory('01026167');
    expect(filings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T022 — RegistryFactory registration contract validation
// ---------------------------------------------------------------------------

describe('RegistryFactory registration', () => {
  it('registers successfully and resolves for GB jurisdiction', () => {
    const factory = new RegistryFactory();
    const p = new CompaniesHouseProvider({ apiKey: 'test' });
    expect(() => factory.register(p)).not.toThrow();
    expect(factory.getProvider('GB')).toBe(p);
  });

  it('satisfies the full RegistryProvider contract (all methods present)', () => {
    const p = new CompaniesHouseProvider({ apiKey: 'test' });
    const methods = ['searchEntity', 'getEntityDetails', 'getOfficers', 'getShareholders', 'getFilingHistory', 'getEntityStatus'];
    for (const method of methods) {
      expect(typeof p[method]).toBe('function');
    }
    expect(p.name).toBe('companies-house');
    expect(p.jurisdictions).toEqual(['GB']);
  });
});

// ---------------------------------------------------------------------------
// Status and helper mapping coverage
// ---------------------------------------------------------------------------

describe('_mapStatus', () => {
  const cases = [
    ['active', 'active'],
    ['dissolved', 'dissolved'],
    ['liquidation', 'liquidation'],
    ['administration', 'administration'],
    ['voluntary-arrangement', 'administration'],
    ['converted-closed', 'dissolved'],
    ['insolvency-proceedings', 'liquidation'],
    ['unknown-status', 'other'],
    [undefined, 'other'],
  ];

  it.each(cases)('maps %s → %s', (input, expected) => {
    expect(provider._mapStatus(input)).toBe(expected);
  });
});

describe('_countryToCode', () => {
  it('maps known country names to ISO codes', () => {
    expect(provider._countryToCode('United Kingdom')).toBe('GB');
    expect(provider._countryToCode('England')).toBe('GB');
    expect(provider._countryToCode('Wales')).toBe('GB');
    expect(provider._countryToCode('Scotland')).toBe('GB');
  });

  it('returns the original value for unknown countries', () => {
    expect(provider._countryToCode('France')).toBe('France');
  });

  it('handles undefined gracefully', () => {
    expect(provider._countryToCode(undefined)).toBeUndefined();
  });
});
