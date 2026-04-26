'use strict';

const {
  RegistryFactory,
  NO_REGISTRY_PROVIDER,
  INVALID_PROVIDER,
} = require('../../../backend/src/data-sources/registry-factory');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(name, jurisdictions = ['GB']) {
  return {
    name,
    jurisdictions,
    searchEntity: jest.fn(),
    getEntityDetails: jest.fn(),
    getOfficers: jest.fn(),
    getShareholders: jest.fn(),
    getFilingHistory: jest.fn(),
    getEntityStatus: jest.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RegistryFactory', () => {
  let factory;

  beforeEach(() => {
    factory = new RegistryFactory();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Registration and retrieval
  // -------------------------------------------------------------------------

  describe('register() and getProvider()', () => {
    it('returns the registered provider for its jurisdiction', () => {
      const provider = makeMockProvider('companies-house', ['GB']);
      factory.register(provider);
      expect(factory.getProvider('GB')).toBe(provider);
    });

    it('is case-insensitive — lowercase resolves to the same provider', () => {
      const provider = makeMockProvider('companies-house', ['GB']);
      factory.register(provider);
      expect(factory.getProvider('gb')).toBe(provider);
      expect(factory.getProvider('Gb')).toBe(provider);
    });

    it('registers a provider for multiple jurisdictions simultaneously', () => {
      const provider = makeMockProvider('uk-ie-provider', ['GB', 'IE']);
      factory.register(provider);
      expect(factory.getProvider('GB')).toBe(provider);
      expect(factory.getProvider('IE')).toBe(provider);
    });
  });

  // -------------------------------------------------------------------------
  // Unknown jurisdiction
  // -------------------------------------------------------------------------

  describe('getProvider() — unknown jurisdiction', () => {
    it('throws with code NO_REGISTRY_PROVIDER for an unregistered jurisdiction', () => {
      expect(() => factory.getProvider('XX')).toThrow();
      try {
        factory.getProvider('XX');
      } catch (err) {
        expect(err.code).toBe(NO_REGISTRY_PROVIDER);
        expect(err.jurisdiction).toBe('XX');
        expect(err.message).toMatch(/XX/);
      }
    });

    it('normalises the jurisdiction code to uppercase in the error', () => {
      try {
        factory.getProvider('xx');
      } catch (err) {
        expect(err.jurisdiction).toBe('XX');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Duplicate jurisdiction warning
  // -------------------------------------------------------------------------

  describe('register() — duplicate jurisdiction', () => {
    it('overwrites the existing provider when the same jurisdiction is registered again', () => {
      const first = makeMockProvider('first-provider', ['GB']);
      const second = makeMockProvider('second-provider', ['GB']);

      factory.register(first);
      factory.register(second);

      expect(factory.getProvider('GB')).toBe(second);
    });

    it('emits a structured JSON warning when overwriting', () => {
      const first = makeMockProvider('first-provider', ['GB']);
      const second = makeMockProvider('second-provider', ['GB']);

      factory.register(first);
      factory.register(second);

      expect(console.warn).toHaveBeenCalledTimes(1);
      const warningArg = console.warn.mock.calls[0][0];
      const parsed = JSON.parse(warningArg);
      expect(parsed.event).toBe('REGISTRY_PROVIDER_OVERWRITTEN');
      expect(parsed.jurisdiction).toBe('GB');
      expect(parsed.previous).toBe('first-provider');
      expect(parsed.replacement).toBe('second-provider');
    });

    it('does NOT warn when registering a provider for the first time', () => {
      factory.register(makeMockProvider('only-provider', ['GB']));
      expect(console.warn).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Contract validation at registration time
  // -------------------------------------------------------------------------

  describe('register() — invalid provider', () => {
    it('throws with code INVALID_PROVIDER when provider is null', () => {
      expect(() => factory.register(null)).toThrow(
        expect.objectContaining({ code: INVALID_PROVIDER })
      );
    });

    it('throws with code INVALID_PROVIDER when name is missing', () => {
      const bad = makeMockProvider('ok', ['GB']);
      delete bad.name;
      expect(() => factory.register(bad)).toThrow(
        expect.objectContaining({ code: INVALID_PROVIDER })
      );
    });

    it('throws with code INVALID_PROVIDER when jurisdictions is empty', () => {
      const bad = makeMockProvider('ok', []);
      expect(() => factory.register(bad)).toThrow(
        expect.objectContaining({ code: INVALID_PROVIDER })
      );
    });

    it('throws with code INVALID_PROVIDER when a required method is missing', () => {
      const bad = makeMockProvider('ok', ['GB']);
      delete bad.getOfficers;
      expect(() => factory.register(bad)).toThrow(
        expect.objectContaining({ code: INVALID_PROVIDER, missingMethod: 'getOfficers' })
      );
    });

    it('throws for each missing method individually', () => {
      const methods = [
        'searchEntity',
        'getEntityDetails',
        'getOfficers',
        'getShareholders',
        'getFilingHistory',
        'getEntityStatus',
      ];
      for (const method of methods) {
        const bad = makeMockProvider('ok', ['GB']);
        delete bad[method];
        expect(() => factory.register(bad)).toThrow(
          expect.objectContaining({ code: INVALID_PROVIDER, missingMethod: method })
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // getSupportedJurisdictions
  // -------------------------------------------------------------------------

  describe('getSupportedJurisdictions()', () => {
    it('returns an empty array when no providers are registered', () => {
      expect(factory.getSupportedJurisdictions()).toEqual([]);
    });

    it('returns all registered jurisdiction codes in uppercase', () => {
      factory.register(makeMockProvider('provider-a', ['GB', 'IE']));
      factory.register(makeMockProvider('provider-b', ['US']));
      const codes = factory.getSupportedJurisdictions();
      expect(codes).toHaveLength(3);
      expect(codes).toEqual(expect.arrayContaining(['GB', 'IE', 'US']));
    });

    it('reflects the overwritten provider (no duplicate codes)', () => {
      factory.register(makeMockProvider('first', ['GB']));
      factory.register(makeMockProvider('second', ['GB']));
      expect(factory.getSupportedJurisdictions()).toEqual(['GB']);
    });
  });
});
