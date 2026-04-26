'use strict';

/**
 * Integration tests against the live Companies House API.
 *
 * These tests are SKIPPED automatically when COMPANIES_HOUSE_API_KEY is not set.
 * To run them: COMPANIES_HOUSE_API_KEY=<your-key> npx jest companies-house.integration
 */

const {
  CompaniesHouseProvider,
} = require('../../../backend/src/data-sources/registry/companies-house');

const BARCLAYS_NUMBER = '01026167';

const hasApiKey = Boolean(process.env.COMPANIES_HOUSE_API_KEY);
const describeIf = hasApiKey ? describe : describe.skip;

describeIf('CompaniesHouseProvider — integration (live API)', () => {
  let provider;

  beforeAll(() => {
    provider = new CompaniesHouseProvider({
      apiKey: process.env.COMPANIES_HOUSE_API_KEY,
    });
  });

  it('searchEntity returns results including Barclays Bank PLC', async () => {
    const results = await provider.searchEntity({ name: 'Barclays' });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    const barclays = results.find((r) => /barclays/i.test(r.name));
    expect(barclays).toBeDefined();
    expect(barclays.entityId).toBeTruthy();
    expect(barclays.rawData).toBeDefined();
  }, 15000);

  it('getEntityDetails returns active profile for Barclays Bank (01026167)', async () => {
    const details = await provider.getEntityDetails(BARCLAYS_NUMBER);
    expect(details.status).toBe('active');
    expect(details.registeredAddress.country).toBeTruthy();
    expect(details.rawData).toBeDefined();
  }, 15000);

  it('getOfficers returns at least one officer with role and appointedDate', async () => {
    const officers = await provider.getOfficers(BARCLAYS_NUMBER);
    expect(Array.isArray(officers)).toBe(true);
    expect(officers.length).toBeGreaterThan(0);
    expect(officers[0].role).toBeTruthy();
    expect(officers[0].appointedDate).toBeTruthy();
    expect(officers[0].rawData).toBeDefined();
  }, 30000); // may paginate

  it('getShareholders returns an array without throwing (may be empty for listed company)', async () => {
    const shareholders = await provider.getShareholders(BARCLAYS_NUMBER);
    expect(Array.isArray(shareholders)).toBe(true);
    // Barclays is a listed company — PSC list may be empty; that is valid behaviour
  }, 15000);
});
