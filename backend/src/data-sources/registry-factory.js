'use strict';

const REQUIRED_REGISTRY_METHODS = [
  'searchEntity',
  'getEntityDetails',
  'getOfficers',
  'getShareholders',
  'getFilingHistory',
  'getEntityStatus',
];

/**
 * Validates that a provider object satisfies the RegistryProvider contract.
 * Throws INVALID_PROVIDER if the contract is not met.
 *
 * @param {object} provider
 */
function validateRegistryProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw Object.assign(
      new Error('Registry provider must be a non-null object'),
      { code: 'INVALID_PROVIDER' }
    );
  }

  if (typeof provider.name !== 'string' || provider.name.trim() === '') {
    throw Object.assign(
      new Error('Registry provider must have a non-empty string "name" property'),
      { code: 'INVALID_PROVIDER' }
    );
  }

  if (
    !Array.isArray(provider.jurisdictions) ||
    provider.jurisdictions.length === 0
  ) {
    throw Object.assign(
      new Error(
        `Registry provider "${provider.name}" must have a non-empty "jurisdictions" array`
      ),
      { code: 'INVALID_PROVIDER', provider: provider.name }
    );
  }

  for (const method of REQUIRED_REGISTRY_METHODS) {
    if (typeof provider[method] !== 'function') {
      throw Object.assign(
        new Error(
          `Registry provider "${provider.name}" is missing required method: ${method}`
        ),
        { code: 'INVALID_PROVIDER', provider: provider.name, missingMethod: method }
      );
    }
  }
}

/**
 * Routes requests to the correct RegistryProvider by ISO 3166-1 alpha-2 jurisdiction code.
 *
 * @example
 * const factory = new RegistryFactory();
 * factory.register(companiesHouseProvider);
 * const provider = factory.getProvider('GB');
 */
class RegistryFactory {
  constructor() {
    /** @type {Map<string, import('./registry/types').RegistryProvider>} */
    this._providers = new Map();
  }

  /**
   * Register a provider for its declared jurisdictions.
   * Validates the provider contract at registration time (FR-014).
   * Emits a structured warning if a jurisdiction is already registered (FR-013).
   *
   * @param {import('./registry/types').RegistryProvider} provider
   * @throws {{ code: 'INVALID_PROVIDER' }} if the provider does not satisfy the contract
   */
  register(provider) {
    validateRegistryProvider(provider);

    for (const jurisdiction of provider.jurisdictions) {
      const code = jurisdiction.toUpperCase();
      const existing = this._providers.get(code);

      if (existing) {
        console.warn(
          JSON.stringify({
            event: 'REGISTRY_PROVIDER_OVERWRITTEN',
            jurisdiction: code,
            previous: existing.name,
            replacement: provider.name,
          })
        );
      }

      this._providers.set(code, provider);
    }
  }

  /**
   * Get the provider for a jurisdiction code (case-insensitive).
   *
   * @param {string} jurisdiction - ISO 3166-1 alpha-2 code
   * @returns {import('./registry/types').RegistryProvider}
   * @throws {{ code: 'NO_REGISTRY_PROVIDER', jurisdiction: string }} if no provider is registered
   */
  getProvider(jurisdiction) {
    const code = jurisdiction.toUpperCase();
    const provider = this._providers.get(code);

    if (!provider) {
      throw Object.assign(
        new Error(`No registry provider registered for jurisdiction: ${code}`),
        { code: 'NO_REGISTRY_PROVIDER', jurisdiction: code }
      );
    }

    return provider;
  }

  /**
   * List all jurisdiction codes that have a registered provider.
   *
   * @returns {string[]} Uppercased ISO 3166-1 alpha-2 codes
   */
  getSupportedJurisdictions() {
    return Array.from(this._providers.keys());
  }
}

module.exports = {
  RegistryFactory,
  NO_REGISTRY_PROVIDER: 'NO_REGISTRY_PROVIDER',
  INVALID_PROVIDER: 'INVALID_PROVIDER',
};
