# Data Source Provider Interface and Registry Abstraction

> GitHub Issue: [#14](https://github.com/jbillay/kyc-agent/issues/14)
> Epic: Data Integration Layer (#13)
> Size: M (1-3 days) | Priority: Critical

## Context

Agents need data from external sources — corporate registries and sanctions lists — but must never call external APIs directly. This story defines the provider interfaces that all data sources implement, plus a registry factory that routes requests to the correct provider by jurisdiction.

Every provider returns a `rawData` field containing the original API response, ensuring the audit trail captures exactly what the external source returned.

## Requirements

### Functional

1. `RegistryProvider` interface: `searchEntity`, `getEntityDetails`, `getOfficers`, `getShareholders`, `getFilingHistory`, `getEntityStatus`
2. Full type definitions: `EntitySearchQuery`, `EntityDetails`, `Officer`, `Shareholder`, `Filing`, `EntityStatus`
3. Registry factory returns the correct provider by ISO 3166-1 alpha-2 jurisdiction code
4. `ScreeningProvider` interface: `search`, `getListMetadata`, `updateList`
5. Full type definitions: `ScreeningQuery`, `ScreeningHit`, `ListMetadata`
6. All providers include `rawData` in responses

### Non-Functional

- Interfaces defined via JSDoc (no TypeScript)
- Provider implementations are stateless and can be registered at startup

## Technical Design

### File: `backend/src/data-sources/registry/types.js`

```javascript
/**
 * @typedef {Object} RegistryProvider
 * @property {string} name - Provider identifier (e.g., 'companies-house')
 * @property {string[]} jurisdictions - ISO 3166-1 alpha-2 codes this provider covers
 * @property {(query: EntitySearchQuery) => Promise<EntitySearchResult[]>} searchEntity
 * @property {(entityId: string) => Promise<EntityDetails>} getEntityDetails
 * @property {(entityId: string) => Promise<Officer[]>} getOfficers
 * @property {(entityId: string) => Promise<Shareholder[]>} getShareholders
 * @property {(entityId: string) => Promise<Filing[]>} getFilingHistory
 * @property {(entityId: string) => Promise<EntityStatus>} getEntityStatus
 */

/**
 * @typedef {Object} EntitySearchQuery
 * @property {string} name - Company name to search
 * @property {string} [jurisdiction] - ISO 3166-1 alpha-2
 * @property {string} [registrationNumber] - Known registration/company number
 * @property {string} [incorporationDate] - ISO 8601 date
 */

/**
 * @typedef {Object} EntitySearchResult
 * @property {string} entityId - Provider-specific entity identifier
 * @property {string} name - Company name
 * @property {string} registrationNumber
 * @property {string} jurisdiction
 * @property {string} [incorporationDate]
 * @property {string} status - 'active', 'dissolved', etc.
 * @property {string} [entityType] - 'limited-company', 'llp', 'plc', etc.
 * @property {number} [relevanceScore] - Provider-specific relevance ranking
 * @property {Object} rawData
 */

/**
 * @typedef {Object} EntityDetails
 * @property {string} registrationNumber
 * @property {string} name
 * @property {string} jurisdiction
 * @property {string} incorporationDate
 * @property {string} entityType
 * @property {Object} registeredAddress
 * @property {string} registeredAddress.addressLine1
 * @property {string} [registeredAddress.addressLine2]
 * @property {string} registeredAddress.locality
 * @property {string} [registeredAddress.region]
 * @property {string} registeredAddress.postalCode
 * @property {string} registeredAddress.country
 * @property {'active'|'dissolved'|'liquidation'|'administration'|'other'} status
 * @property {string[]} [sicCodes]
 * @property {{ name: string, effectiveFrom: string, effectiveTo: string|null }[]} [previousNames]
 * @property {Object} rawData
 */

/**
 * @typedef {Object} Officer
 * @property {string} name
 * @property {string} role - 'director', 'secretary', 'llp-member', etc.
 * @property {string} appointedDate
 * @property {string} [resignedDate]
 * @property {string} [nationality]
 * @property {string} [dateOfBirth] - 'YYYY-MM' format (month/year only from Companies House)
 * @property {Object} [address]
 * @property {Object} rawData
 */

/**
 * @typedef {Object} Shareholder
 * @property {string} name
 * @property {'individual'|'corporate'|'other'} type
 * @property {string} [ownershipPercentage] - May be a range: '25-50', '75-100'
 * @property {string[]} [naturesOfControl] - e.g., 'ownership-of-shares-25-to-50-percent'
 * @property {string} [notifiedDate]
 * @property {string} [ceasedDate]
 * @property {string} [nationality]
 * @property {string} [countryOfResidence]
 * @property {string} [registrationNumber] - For corporate shareholders
 * @property {string} [jurisdiction] - For corporate shareholders
 * @property {Object} rawData
 */

/**
 * @typedef {Object} Filing
 * @property {string} filingType - e.g., 'AA', 'CS01', 'AD01'
 * @property {string} description
 * @property {string} date
 * @property {string} [category]
 * @property {Object} rawData
 */

/**
 * @typedef {Object} EntityStatus
 * @property {'active'|'dissolved'|'liquidation'|'administration'|'other'} status
 * @property {string} [dissolvedDate]
 * @property {boolean} accountsOverdue
 * @property {boolean} annualReturnOverdue
 * @property {string[]} activeNotices - e.g., 'compulsory-strike-off', 'first-gazette'
 * @property {Object} rawData
 */

module.exports = {};
```

### File: `backend/src/data-sources/screening/types.js`

```javascript
/**
 * @typedef {Object} ScreeningProvider
 * @property {string} name - Provider identifier (e.g., 'ofac-sdn')
 * @property {'sanctions'|'pep'|'adverse_media'} listType
 * @property {(query: ScreeningQuery) => Promise<ScreeningHit[]>} search
 * @property {() => Promise<ListMetadata>} getListMetadata
 * @property {() => Promise<UpdateResult>} updateList
 */

/**
 * @typedef {Object} ScreeningQuery
 * @property {string} name - Name to screen
 * @property {string} [dateOfBirth] - ISO 8601 date or 'YYYY-MM'
 * @property {string} [nationality] - ISO 3166-1 alpha-2
 * @property {'individual'|'entity'} entityType
 * @property {string[]} [aliases] - Known alternative names
 */

/**
 * @typedef {Object} ScreeningHit
 * @property {string} source - List identifier: 'OFAC-SDN', 'UK-HMT', etc.
 * @property {string} matchedName - Name on the list that matched
 * @property {number} matchScore - 0-100 fuzzy match score
 * @property {string[]} matchedFields - Which query fields contributed to the match
 * @property {Object} listEntry
 * @property {string} listEntry.id - Entry identifier on the list
 * @property {string[]} listEntry.names - All known names/aliases
 * @property {string} [listEntry.dateOfBirth]
 * @property {string[]} [listEntry.nationality]
 * @property {string[]} [listEntry.programs] - Sanctions programs (e.g., 'SDGT', 'IRAN')
 * @property {string} [listEntry.remarks]
 * @property {string} [listEntry.listedDate]
 * @property {Object} rawData
 */

/**
 * @typedef {Object} ListMetadata
 * @property {string} listName
 * @property {string} listType
 * @property {string} sourceUrl
 * @property {string} lastUpdated - ISO 8601 timestamp
 * @property {number} entryCount
 */

/**
 * @typedef {Object} UpdateResult
 * @property {boolean} updated - Whether new data was found
 * @property {number} entriesAdded
 * @property {number} entriesRemoved
 * @property {number} entriesModified
 * @property {string} timestamp
 */

module.exports = {};
```

### File: `backend/src/data-sources/registry-factory.js`

```javascript
/**
 * Registry factory — returns the correct provider for a jurisdiction.
 */
class RegistryFactory {
  constructor() {
    /** @type {Map<string, RegistryProvider>} jurisdiction code → provider */
    this._providers = new Map();
  }

  /**
   * Register a provider for its jurisdictions.
   * @param {RegistryProvider} provider
   */
  register(provider) {
    for (const jurisdiction of provider.jurisdictions) {
      this._providers.set(jurisdiction.toUpperCase(), provider);
    }
  }

  /**
   * Get the provider for a jurisdiction.
   * @param {string} jurisdiction - ISO 3166-1 alpha-2 code
   * @returns {RegistryProvider}
   * @throws {Error} if no provider registered for the jurisdiction
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
   * List all supported jurisdictions.
   * @returns {string[]}
   */
  getSupportedJurisdictions() {
    return Array.from(this._providers.keys());
  }
}

module.exports = { RegistryFactory };
```

## Interfaces

### RegistryProvider Contract

| Method | Signature | Returns |
|--------|-----------|---------|
| `searchEntity` | `(query: EntitySearchQuery) => Promise<EntitySearchResult[]>` | Ranked search results |
| `getEntityDetails` | `(entityId: string) => Promise<EntityDetails>` | Full company profile |
| `getOfficers` | `(entityId: string) => Promise<Officer[]>` | Directors and officers |
| `getShareholders` | `(entityId: string) => Promise<Shareholder[]>` | PSC / ownership entries |
| `getFilingHistory` | `(entityId: string) => Promise<Filing[]>` | Recent filings |
| `getEntityStatus` | `(entityId: string) => Promise<EntityStatus>` | Status and red flags |

### ScreeningProvider Contract

| Method | Signature | Returns |
|--------|-----------|---------|
| `search` | `(query: ScreeningQuery) => Promise<ScreeningHit[]>` | Fuzzy matches with scores |
| `getListMetadata` | `() => Promise<ListMetadata>` | List update info |
| `updateList` | `() => Promise<UpdateResult>` | Sync from source |

### RegistryFactory

| Method | Signature | Purpose |
|--------|-----------|---------|
| `register` | `(provider: RegistryProvider) => void` | Register for jurisdictions |
| `getProvider` | `(jurisdiction: string) => RegistryProvider` | Lookup by jurisdiction code |
| `getSupportedJurisdictions` | `() => string[]` | List supported codes |

## Acceptance Criteria

- [ ] `RegistryProvider` interface fully defined with JSDoc: all 6 methods plus `name` and `jurisdictions`
- [ ] Types defined: `EntitySearchQuery`, `EntitySearchResult`, `EntityDetails`, `Officer`, `Shareholder`, `Filing`, `EntityStatus`
- [ ] `ScreeningProvider` interface defined: `search`, `getListMetadata`, `updateList`
- [ ] Types defined: `ScreeningQuery`, `ScreeningHit`, `ListMetadata`, `UpdateResult`
- [ ] `RegistryFactory` returns correct provider by jurisdiction code (case-insensitive)
- [ ] `RegistryFactory` throws `NO_REGISTRY_PROVIDER` for unsupported jurisdictions
- [ ] All response types include `rawData` field for audit
- [ ] `Shareholder.type` distinguishes individual vs corporate (needed for ownership tracing)

## Dependencies

- **Depends on**: #4 (Backend scaffold)
- **Blocks**: #15 (Companies House), #16 (Caching), #17 (OFAC), #18 (UK HMT)

## Testing Strategy

1. **Factory registration**: Register a mock provider for 'GB', verify `getProvider('GB')` returns it
2. **Factory case insensitivity**: `getProvider('gb')` returns same as `getProvider('GB')`
3. **Factory unknown jurisdiction**: `getProvider('XX')` throws with clear error
4. **Multiple jurisdictions**: Register provider covering ['GB', 'IE'], verify both resolve
5. **Type completeness**: Verify all JSDoc types are importable and autocomplete in editor
