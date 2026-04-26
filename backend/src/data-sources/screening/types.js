'use strict';

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
 * @property {'individual'|'entity'} entityType
 * @property {string} [dateOfBirth] - ISO 8601 date or 'YYYY-MM'
 * @property {string} [nationality] - ISO 3166-1 alpha-2
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
 * @property {Object} rawData - Complete unmodified list entry for audit
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
 * @property {boolean} updated - Whether new data was found; false when source was unchanged
 * @property {number} entriesAdded - 0 when updated is false
 * @property {number} entriesRemoved - 0 when updated is false
 * @property {number} entriesModified - 0 when updated is false
 * @property {string} timestamp - ISO 8601 timestamp of the update check
 */

module.exports = {};
