'use strict';

/**
 * Companies House API endpoints:
 *
 * Search:     GET /search/companies?q={name}&items_per_page=10
 * Profile:    GET /company/{number}
 * Officers:   GET /company/{number}/officers?items_per_page=50&start_index={n}
 * PSC:        GET /company/{number}/persons-with-significant-control
 * Filings:    GET /company/{number}/filing-history?items_per_page=25
 *
 * Auth: HTTP Basic — API key as username, empty password.
 * Rate limit: 600 requests per 5 minutes (token bucket, 2 tokens/second refill).
 *
 * @implements {import('../registry/types').RegistryProvider}
 */
class CompaniesHouseProvider {
  /**
   * @param {Object} config
   * @param {string} config.apiKey
   * @param {string} [config.baseUrl]
   * @param {number} [config.timeoutMs]
   * @param {number} [config.maxQueueWaitMs]
   */
  constructor(config) {
    this.name = 'companies-house';
    this.jurisdictions = ['GB'];
    this.baseUrl = config.baseUrl || 'https://api.company-information.service.gov.uk';
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs || 10000;
    this.maxQueueWaitMs = config.maxQueueWaitMs || 30000;

    this._tokens = 600;
    this._maxTokens = 600;
    this._refillRate = 2;
    this._lastRefill = Date.now();
  }

  // ─── Public API (RegistryProvider interface) ───────────────────────────────

  /**
   * @param {import('../registry/types').EntitySearchQuery} query
   * @returns {Promise<import('../registry/types').EntitySearchResult[]>}
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
   * @param {string} companyNumber
   * @returns {Promise<import('../registry/types').EntityDetails>}
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
   * Retrieves all officers, paginating through all registry pages.
   * @param {string} companyNumber
   * @returns {Promise<import('../registry/types').Officer[]>}
   */
  async getOfficers(companyNumber) {
    const items = await this._paginateOfficers(companyNumber);

    return items.map((item) => ({
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
   * @param {string} companyNumber
   * @returns {Promise<import('../registry/types').Shareholder[]>}
   */
  async getShareholders(companyNumber) {
    const data = await this._get(
      `/company/${companyNumber}/persons-with-significant-control`
    );

    return (data.items || []).map((item) => {
      const name = item.name
        ? item.name
        : `${item.name_elements?.forename || ''} ${item.name_elements?.surname || ''}`.trim() || 'Unknown';

      return {
        name,
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
      };
    });
  }

  /**
   * @param {string} companyNumber
   * @returns {Promise<import('../registry/types').Filing[]>}
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
   * @param {string} companyNumber
   * @returns {Promise<import('../registry/types').EntityStatus>}
   */
  async getEntityStatus(companyNumber) {
    const data = await this._get(`/company/${companyNumber}`);

    const notices = [];
    if (data.has_been_liquidated) notices.push('previously-liquidated');
    if (data.has_insolvency_history) notices.push('insolvency-history');
    if (data.company_status === 'active' && data.company_status_detail) {
      notices.push(data.company_status_detail);
    }

    return {
      status: this._mapStatus(data.company_status),
      dissolvedDate: data.date_of_cessation || undefined,
      accountsOverdue: data.accounts?.overdue === true,
      annualReturnOverdue:
        data.annual_return?.overdue === true ||
        data.confirmation_statement?.overdue === true,
      activeNotices: notices,
      rawData: data,
    };
  }

  // ─── Private: pagination ───────────────────────────────────────────────────

  async _paginateOfficers(companyNumber) {
    const pageSize = 50;
    let startIndex = 0;
    const allItems = [];

    for (;;) {
      const page = await this._get(
        `/company/${companyNumber}/officers?items_per_page=${pageSize}&start_index=${startIndex}`
      );
      const items = page.items || [];
      allItems.push(...items);
      if (allItems.length >= (page.total_results || 0) || items.length === 0) break;
      startIndex += pageSize;
    }

    return allItems;
  }

  // ─── Private: HTTP ─────────────────────────────────────────────────────────

  async _get(path) {
    await this._acquireToken();

    return this._retry(async () => {
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
          throw Object.assign(new Error('Entity not found'), {
            code: 'NOT_FOUND',
            statusCode: 404,
          });
        }
        if (response.status === 429) {
          throw Object.assign(new Error('Rate limit exceeded'), {
            code: 'RATE_LIMITED',
            statusCode: 429,
          });
        }
        if (!response.ok) {
          throw Object.assign(
            new Error(`Companies House API error: ${response.status}`),
            { statusCode: response.status }
          );
        }

        return response.json();
      } finally {
        clearTimeout(timeout);
      }
    });
  }

  async _acquireToken() {
    const now = Date.now();
    const elapsed = (now - this._lastRefill) / 1000;
    this._tokens = Math.min(this._maxTokens, this._tokens + elapsed * this._refillRate);
    this._lastRefill = now;

    if (this._tokens < 1) {
      const waitMs = ((1 - this._tokens) / this._refillRate) * 1000;
      let waitTimer;
      let capTimer;
      await Promise.race([
        new Promise((resolve) => { waitTimer = setTimeout(resolve, waitMs); }),
        new Promise((_, reject) => {
          capTimer = setTimeout(
            () =>
              reject(
                Object.assign(new Error('Rate limit queue wait exceeded'), {
                  code: 'RATE_LIMITED',
                })
              ),
            this.maxQueueWaitMs
          );
        }),
      ]).finally(() => {
        clearTimeout(waitTimer);
        clearTimeout(capTimer);
      });
      this._tokens = 0;
    }

    this._tokens -= 1;
  }

  /**
   * Retries fn up to maxAttempts times with exponential backoff.
   * Does NOT retry on NOT_FOUND, RATE_LIMITED, or AbortError (timeout).
   */
  async _retry(fn, maxAttempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (
          err.code === 'NOT_FOUND' ||
          err.code === 'RATE_LIMITED' ||
          err.name === 'AbortError'
        ) {
          throw err;
        }
        if (attempt < maxAttempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, 200 * Math.pow(2, attempt - 1))
          );
        }
      }
    }
    throw lastError;
  }

  // ─── Private: mapping helpers ──────────────────────────────────────────────

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
    const map = {
      'united kingdom': 'GB',
      england: 'GB',
      wales: 'GB',
      scotland: 'GB',
    };
    return map[country?.toLowerCase()] || country;
  }
}

module.exports = { CompaniesHouseProvider };
