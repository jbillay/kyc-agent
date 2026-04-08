# Companies House API Integration

> GitHub Issue: [#15](https://github.com/jbillay/kyc-agent/issues/15)
> Epic: Data Integration Layer (#13)
> Size: L (3-5 days) | Priority: Critical

## Context

Companies House is the UK corporate registry and the primary data source for Phase 1. It provides free API access (with a key) to search companies, retrieve profiles, officers, PSC (Persons with Significant Control) data, and filing history. The API has a rate limit of 600 requests per 5 minutes.

The Entity Resolution Agent and Ownership Agent both depend heavily on this provider.

## Requirements

### Functional

1. `CompaniesHouseProvider` implements `RegistryProvider` interface
2. `searchEntity`: search by company name, return ranked results
3. `getEntityDetails`: full company profile with address, SIC codes, previous names
4. `getOfficers`: current and resigned officers with roles, dates, nationality, DOB
5. `getShareholders`: PSC register entries with ownership percentages and nature of control
6. `getFilingHistory`: recent filings with types and dates
7. `getEntityStatus`: status, overdue flags, active notices
8. Rate limiting: 600 requests per 5 minutes
9. API key authentication via config

### Non-Functional

- All responses cached via the data caching layer (#16)
- Rate limiter is token-bucket based, shared across all concurrent requests
- Timeout: 10 seconds per request

## Technical Design

### File: `backend/src/data-sources/registry/companies-house.js`

```javascript
const crypto = require('crypto');

/**
 * Companies House API endpoints:
 *
 * Search:     GET /search/companies?q={name}&items_per_page=10
 * Profile:    GET /company/{number}
 * Officers:   GET /company/{number}/officers
 * PSC:        GET /company/{number}/persons-with-significant-control
 * Filings:    GET /company/{number}/filing-history?items_per_page=25
 *
 * Auth: HTTP Basic with API key as username, empty password.
 * Rate limit: 600 requests per 5 minutes (sliding window).
 *
 * @implements {RegistryProvider}
 */
class CompaniesHouseProvider {
  /**
   * @param {Object} config
   * @param {string} config.apiKey - Companies House API key
   * @param {string} [config.baseUrl='https://api.company-information.service.gov.uk']
   * @param {number} [config.timeoutMs=10000]
   */
  constructor(config) {
    this.name = 'companies-house';
    this.jurisdictions = ['GB'];
    this.baseUrl = config.baseUrl || 'https://api.company-information.service.gov.uk';
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs || 10000;

    // Token bucket rate limiter: 600 tokens, refill 2/sec
    this._tokens = 600;
    this._maxTokens = 600;
    this._refillRate = 2; // tokens per second
    this._lastRefill = Date.now();
  }

  /**
   * Search for companies by name.
   * @param {EntitySearchQuery} query
   * @returns {Promise<EntitySearchResult[]>}
   */
  async searchEntity(query) {
    const params = new URLSearchParams({ q: query.name, items_per_page: '10' });
    const data = await this._get(`/search/companies?${params}`);

    return (data.items || []).map((item) => ({
      entityId: item.company_number,
      name: item.title,
      registrationNumber: item.company_number,
      jurisdiction: 'GB',
      incorporationDate: item.date_of_creation,
      status: this._mapStatus(item.company_status),
      entityType: item.company_type,
      relevanceScore: item.snippet ? 100 : 80,
      rawData: item,
    }));
  }

  /**
   * Get full company profile.
   * @param {string} companyNumber
   * @returns {Promise<EntityDetails>}
   */
  async getEntityDetails(companyNumber) {
    const data = await this._get(`/company/${companyNumber}`);

    return {
      registrationNumber: data.company_number,
      name: data.company_name,
      jurisdiction: 'GB',
      incorporationDate: data.date_of_creation,
      entityType: data.type,
      registeredAddress: {
        addressLine1: data.registered_office_address?.address_line_1 || '',
        addressLine2: data.registered_office_address?.address_line_2 || undefined,
        locality: data.registered_office_address?.locality || '',
        region: data.registered_office_address?.region || undefined,
        postalCode: data.registered_office_address?.postal_code || '',
        country: data.registered_office_address?.country || 'United Kingdom',
      },
      status: this._mapStatus(data.company_status),
      sicCodes: data.sic_codes || [],
      previousNames: (data.previous_company_names || []).map((pn) => ({
        name: pn.name,
        effectiveFrom: pn.effective_from,
        effectiveTo: pn.ceased_on || null,
      })),
      rawData: data,
    };
  }

  /**
   * Get officers (directors, secretaries).
   * @param {string} companyNumber
   * @returns {Promise<Officer[]>}
   */
  async getOfficers(companyNumber) {
    const data = await this._get(`/company/${companyNumber}/officers`);

    return (data.items || []).map((item) => ({
      name: item.name,
      role: item.officer_role,
      appointedDate: item.appointed_on,
      resignedDate: item.resigned_on || undefined,
      nationality: item.nationality || undefined,
      dateOfBirth: item.date_of_birth
        ? `${item.date_of_birth.year}-${String(item.date_of_birth.month).padStart(2, '0')}`
        : undefined,
      address: item.address || undefined,
      rawData: item,
    }));
  }

  /**
   * Get Persons with Significant Control (shareholders/UBOs).
   * @param {string} companyNumber
   * @returns {Promise<Shareholder[]>}
   */
  async getShareholders(companyNumber) {
    const data = await this._get(
      `/company/${companyNumber}/persons-with-significant-control`
    );

    return (data.items || []).map((item) => ({
      name: item.name || item.name_elements
        ? `${item.name_elements?.forename || ''} ${item.name_elements?.surname || ''}`.trim()
        : 'Unknown',
      type: this._classifyPSCType(item.kind),
      ownershipPercentage: this._extractOwnershipPercentage(item.natures_of_control),
      naturesOfControl: item.natures_of_control || [],
      notifiedDate: item.notified_on,
      ceasedDate: item.ceased_on || undefined,
      nationality: item.nationality || undefined,
      countryOfResidence: item.country_of_residence || undefined,
      registrationNumber: item.identification?.registration_number || undefined,
      jurisdiction: item.identification?.country_registered
        ? this._countryToCode(item.identification.country_registered)
        : undefined,
      rawData: item,
    }));
  }

  /**
   * Get filing history.
   * @param {string} companyNumber
   * @returns {Promise<Filing[]>}
   */
  async getFilingHistory(companyNumber) {
    const data = await this._get(
      `/company/${companyNumber}/filing-history?items_per_page=25`
    );

    return (data.items || []).map((item) => ({
      filingType: item.type,
      description: item.description || item.type,
      date: item.date,
      category: item.category || undefined,
      rawData: item,
    }));
  }

  /**
   * Get entity status with red flag indicators.
   * @param {string} companyNumber
   * @returns {Promise<EntityStatus>}
   */
  async getEntityStatus(companyNumber) {
    const data = await this._get(`/company/${companyNumber}`);

    const notices = [];
    if (data.has_been_liquidated) notices.push('previously-liquidated');
    if (data.has_insolvency_history) notices.push('insolvency-history');
    // Gazette notices from status
    if (data.company_status === 'active' && data.company_status_detail) {
      notices.push(data.company_status_detail);
    }

    return {
      status: this._mapStatus(data.company_status),
      dissolvedDate: data.date_of_cessation || undefined,
      accountsOverdue: data.accounts?.overdue === true,
      annualReturnOverdue: data.annual_return?.overdue === true
        || data.confirmation_statement?.overdue === true,
      activeNotices: notices,
      rawData: data,
    };
  }

  // ─── Helpers ──────────────────────────────────────────

  /**
   * HTTP GET with auth, rate limiting, and timeout.
   */
  async _get(path) {
    await this._acquireToken();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${this.apiKey}:`).toString('base64'),
        },
        signal: controller.signal,
      });

      if (response.status === 404) {
        throw Object.assign(new Error('Entity not found'), { statusCode: 404, code: 'NOT_FOUND' });
      }
      if (response.status === 429) {
        throw Object.assign(new Error('Rate limit exceeded'), { statusCode: 429, code: 'RATE_LIMITED' });
      }
      if (!response.ok) {
        throw Object.assign(
          new Error(`Companies House API error: ${response.status}`),
          { statusCode: response.status }
        );
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Token bucket rate limiter.
   */
  async _acquireToken() {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;
    this._tokens = Math.min(this._maxTokens, this._tokens + elapsed * this._refillRate);
    this._lastRefill = now;

    if (this._tokens < 1) {
      const waitMs = ((1 - this._tokens) / this._refillRate) * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this._tokens = 0;
    }
    this._tokens -= 1;
  }

  _mapStatus(chStatus) {
    const map = {
      active: 'active',
      dissolved: 'dissolved',
      liquidation: 'liquidation',
      administration: 'administration',
      'voluntary-arrangement': 'administration',
      'converted-closed': 'dissolved',
      'insolvency-proceedings': 'liquidation',
    };
    return map[chStatus] || 'other';
  }

  _classifyPSCType(kind) {
    if (kind?.includes('individual')) return 'individual';
    if (kind?.includes('corporate') || kind?.includes('legal')) return 'corporate';
    return 'other';
  }

  _extractOwnershipPercentage(naturesOfControl) {
    if (!naturesOfControl) return undefined;
    for (const nature of naturesOfControl) {
      if (nature.includes('75-to-100')) return '75-100';
      if (nature.includes('50-to-75')) return '50-75';
      if (nature.includes('25-to-50')) return '25-50';
      if (nature.includes('more-than-25')) return '25-50';
    }
    return undefined;
  }

  _countryToCode(country) {
    // Simplified mapping — extend as needed
    const map = { 'united kingdom': 'GB', 'england': 'GB', 'wales': 'GB', 'scotland': 'GB' };
    return map[country?.toLowerCase()] || country;
  }
}

module.exports = { CompaniesHouseProvider };
```

### API Endpoint Mapping

| Method | CH Endpoint | Notes |
|--------|------------|-------|
| `searchEntity` | `GET /search/companies?q=` | Returns up to 10 results |
| `getEntityDetails` | `GET /company/{number}` | Full profile |
| `getOfficers` | `GET /company/{number}/officers` | Current + resigned |
| `getShareholders` | `GET /company/{number}/persons-with-significant-control` | PSC register |
| `getFilingHistory` | `GET /company/{number}/filing-history` | Last 25 filings |
| `getEntityStatus` | `GET /company/{number}` | Same as profile, different mapping |

### Authentication

Companies House uses HTTP Basic Auth: API key as username, empty password.

```
Authorization: Basic base64(apiKey + ":")
```

### Rate Limiting

Token bucket with 600 tokens, refilling at 2/second:
- Burst: up to 600 requests instantly
- Sustained: 120 requests/minute
- If tokens exhausted: waits proportionally before proceeding

### PSC Ownership Percentage Mapping

Companies House reports ownership as nature-of-control strings, not exact percentages:

| CH Nature of Control | Mapped Percentage |
|---------------------|-------------------|
| `*75-to-100*` | `75-100` |
| `*50-to-75*` | `50-75` |
| `*25-to-50*` | `25-50` |
| `*more-than-25*` | `25-50` |

## Acceptance Criteria

- [ ] `CompaniesHouseProvider` implements full `RegistryProvider` interface
- [ ] `searchEntity`: searches by name, returns results with company number, status, date
- [ ] `getEntityDetails`: returns registered address, SIC codes, previous names, entity type
- [ ] `getOfficers`: returns current and resigned officers with roles, dates, nationality, DOB (month/year)
- [ ] `getShareholders`: returns PSC entries with name, type (individual/corporate), ownership percentage, nature of control
- [ ] `getFilingHistory`: returns recent filings with type and date
- [ ] `getEntityStatus`: returns status, overdue flags, active notices
- [ ] Rate limiter respects 600 requests per 5 minutes
- [ ] API key auth via Basic header
- [ ] 404 → `NOT_FOUND` error, 429 → `RATE_LIMITED` error
- [ ] All responses include `rawData` with original API response
- [ ] Integration tests with known company numbers (e.g., Barclays: 01026167)

## Dependencies

- **Depends on**: #14 (Provider interface), #16 (Data caching), #12 (Config — API key)
- **Blocks**: #27-#28 (Entity Resolution Agent), #45-#46 (Ownership Agent)

## Testing Strategy

1. **Unit tests (mocked HTTP)**:
   - `searchEntity`: mock search response, verify mapping to `EntitySearchResult[]`
   - `getEntityDetails`: mock profile, verify address/SIC/previousNames mapping
   - `getOfficers`: mock officers list, verify DOB formatting (YYYY-MM)
   - `getShareholders`: mock PSC, verify type classification and ownership extraction
   - `getFilingHistory`: mock filings, verify mapping
   - `getEntityStatus`: mock profile with overdue flags, verify status extraction
   - Rate limiter: exhaust tokens, verify wait behavior
   - HTTP errors: mock 404, 429, 500 — verify error codes

2. **Integration tests (requires API key)**:
   - Search for "Barclays" — verify results include Barclays Bank PLC
   - Get details for company 01026167 — verify active status
   - Get officers for a known company — verify at least one director
   - Get PSC for a known company — verify shareholder data present
