'use strict';

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
 * @property {string} jurisdiction - ISO 3166-1 alpha-2
 * @property {string} [incorporationDate] - ISO 8601 date
 * @property {string} status - 'active', 'dissolved', etc.
 * @property {string} [entityType] - 'limited-company', 'llp', 'plc', etc.
 * @property {number} [relevanceScore] - Provider-specific relevance ranking
 * @property {Object} rawData - Complete unmodified API response for audit
 */

/**
 * @typedef {Object} EntityDetails
 * @property {string} registrationNumber
 * @property {string} name
 * @property {string} jurisdiction - ISO 3166-1 alpha-2
 * @property {string} incorporationDate - ISO 8601 date
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
 * @property {Object} rawData - Complete unmodified API response for audit
 */

/**
 * @typedef {Object} Officer
 * @property {string} name
 * @property {string} role - 'director', 'secretary', 'llp-member', etc.
 * @property {string} appointedDate - ISO 8601 date
 * @property {string} [resignedDate] - ISO 8601 date; absent for active officers
 * @property {string} [nationality]
 * @property {string} [dateOfBirth] - 'YYYY-MM' format only (privacy-preserving)
 * @property {Object} [address]
 * @property {Object} rawData - Complete unmodified API response for audit
 */

/**
 * @typedef {Object} Shareholder
 * @property {string} name
 * @property {'individual'|'corporate'|'other'} type - Owner classification; required for UBO tracing
 * @property {string} [ownershipPercentage] - May be a range string: '25-50', '75-100'
 * @property {string[]} [naturesOfControl] - e.g., 'ownership-of-shares-25-to-50-percent'
 * @property {string} [notifiedDate] - ISO 8601 date
 * @property {string} [ceasedDate] - ISO 8601 date
 * @property {string} [nationality]
 * @property {string} [countryOfResidence]
 * @property {string} [registrationNumber] - Corporate shareholders only
 * @property {string} [jurisdiction] - Corporate shareholders only; ISO 3166-1 alpha-2
 * @property {Object} rawData - Complete unmodified API response for audit
 */

/**
 * @typedef {Object} Filing
 * @property {string} filingType - e.g., 'AA', 'CS01', 'AD01'
 * @property {string} description
 * @property {string} date - ISO 8601 date
 * @property {string} [category]
 * @property {Object} rawData - Complete unmodified API response for audit
 */

/**
 * @typedef {Object} EntityStatus
 * @property {'active'|'dissolved'|'liquidation'|'administration'|'other'} status
 * @property {string} [dissolvedDate] - ISO 8601 date
 * @property {boolean} accountsOverdue
 * @property {boolean} annualReturnOverdue
 * @property {string[]} activeNotices - e.g., 'compulsory-strike-off', 'first-gazette'
 * @property {Object} rawData - Complete unmodified API response for audit
 */

module.exports = {};
