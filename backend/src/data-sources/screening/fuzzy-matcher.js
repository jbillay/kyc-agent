'use strict';

/**
 * Fuzzy name matching engine.
 *
 * Full implementation tracked under spec #019.
 * This stub exports the class interface so OFACProvider and tests can reference it.
 */
class FuzzyMatcher {
  constructor({ threshold = 70 } = {}) {
    /** @type {number} Minimum score (0–100) for a match to be returned */
    this.threshold = threshold;
  }

  /**
   * Compare two name strings and return a similarity score 0–100.
   * @param {string} _a
   * @param {string} _b
   * @returns {number}
   */
  compare(_a, _b) {
    throw new Error('FuzzyMatcher.compare() not implemented — see spec #019');
  }
}

module.exports = { FuzzyMatcher };
