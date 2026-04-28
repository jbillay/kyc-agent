'use strict';

const SOUNDEX_MAP = {
  b: '1', f: '1', p: '1', v: '1',
  c: '2', g: '2', j: '2', k: '2', q: '2', s: '2', x: '2', z: '2',
  d: '3', t: '3',
  l: '4',
  m: '5', n: '5',
  r: '6',
};

class FuzzyMatcher {
  constructor({ threshold = 85, weights } = {}) {
    this.threshold = threshold;
    this.weights = Object.assign(
      { jaroWinkler: 0.40, levenshtein: 0.30, phonetic: 0.15, tokenSort: 0.15 },
      weights
    );
    // Pre-allocated buffers to avoid per-call allocations in JW hot path
    this._jwBuf1 = new Uint8Array(512);
    this._jwBuf2 = new Uint8Array(512);
    this._levRow = new Int32Array(512);
    // Normalize memoize — pure function, safe per-instance
    this._normCache = new Map();
    // compare() memoize — deterministic pure function; same inputs → same output
    this._compareCache = new Map();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * @param {string} query
   * @param {string} candidate
   * @returns {{ score: number, isMatch: boolean, matchedFields: string[] }}
   */
  compare(query, candidate) {
    const q = this.normalize(query);
    const c = this.normalize(candidate);

    if (!q || !c) {
      return { score: 0, isMatch: false, matchedFields: [] };
    }
    if (q === c) {
      return { score: 100, isMatch: true, matchedFields: this._exactMatchedFields(q) };
    }

    // Memoize: avoid re-computing for repeated (q, c) pairs within the same screening run
    const cacheKey = q + '|' + c;
    const cached = this._compareCache.get(cacheKey);
    if (cached !== undefined) return cached;

    // Split tokens once — reused by phonetic, token-sort, matchedFields
    const qToks = q.split(' ');
    const cToks = c.split(' ');

    // Sorted token strings — computed once for both tokenSort weight and reorder bonus
    const qSorted = qToks.slice().sort().join(' ');
    const cSorted = cToks.slice().sort().join(' ');

    // JW on sorted strings: used as the tokenSort weight AND reorder-bonus check
    const tokJW = this.jaroWinkler(qSorted, cSorted);

    const jw = this.jaroWinkler(q, c);
    // Skip Soundex when strings are near-identical (saves 7 soundex calls + phonetic matching)
    const phon = jw > 0.98 ? 1.0 : this._phoneticScore(qToks, cToks);
    const lev = this.levenshteinScore(q, c);

    const w = this.weights;
    const regularScore = Math.round(
      jw * w.jaroWinkler * 100 +
      lev * w.levenshtein * 100 +
      phon * w.phonetic * 100 +
      tokJW * w.tokenSort * 100
    );

    // Reorder bonus: token-sorted comparison via MAX
    // If sorted strings are identical → perfect reorder match (score 100)
    // Otherwise reuse tokJW already computed above — no extra JW call
    let tokenBonusScore = 0;
    const alreadySorted = qSorted === q && cSorted === c;
    if (!alreadySorted) {
      tokenBonusScore = qSorted === cSorted ? 100 : Math.round(tokJW * 100);
    }

    const score = Math.min(100, Math.max(0, Math.max(regularScore, tokenBonusScore)));
    const isMatch = score >= this.threshold;

    const result = {
      score,
      isMatch,
      matchedFields: isMatch ? this._computeMatchedFields(qToks, cToks) : [],
    };

    this._compareCache.set(cacheKey, result);
    return result;
  }

  /**
   * @param {string} name
   * @returns {string}
   */
  normalize(name) {
    if (name == null || name === '') return '';

    const cached = this._normCache.get(name);
    if (cached !== undefined) return cached;

    let s = String(name);

    // 1. Lowercase
    s = s.toLowerCase();

    // 2. NFD decomposition + strip combining diacritics (U+0300–U+036F)
    s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');

    // 3. Explicit transliterations
    s = s
      .replace(/ø/g, 'o')
      .replace(/æ/g, 'ae')
      .replace(/ß/g, 'ss')
      .replace(/ð/g, 'd')
      .replace(/þ/g, 'th');

    // 4. Title removal (word boundary, optional trailing dot)
    s = s.replace(
      /\b(mr|mrs|ms|miss|dr|prof|sir|dame|lord|lady|rev|hon)\.?\s*/g,
      ''
    );

    // 5. Suffix removal (word boundary, optional trailing dot)
    s = s.replace(
      /\s+(jr|sr|ii|iii|iv|esq|phd|md)\.?(?=\s|$)/g,
      ''
    );

    // 6. Replace hyphens with spaces (before stripping punctuation)
    s = s.replace(/-/g, ' ');

    // 7. Strip punctuation except spaces
    s = s.replace(/[^\w\s]|_/g, '');

    // 8. Collapse whitespace and trim
    s = s.replace(/\s+/g, ' ').trim();

    this._normCache.set(name, s);
    return s;
  }

  // ─── Algorithms ────────────────────────────────────────────────────────────

  /**
   * @param {string} s1
   * @param {string} s2
   * @returns {number} 0.0–1.0
   */
  jaroWinkler(s1, s2) {
    if (s1 === s2) return 1.0;
    const len1 = s1.length;
    const len2 = s2.length;
    if (!len1 || !len2) return 0.0;

    const matchWindow = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);

    const m1 = this._jwBuf1;
    const m2 = this._jwBuf2;
    for (let i = 0; i < len1; i++) m1[i] = 0;
    for (let i = 0; i < len2; i++) m2[i] = 0;

    let matches = 0;
    for (let i = 0; i < len1; i++) {
      const c1 = s1.charCodeAt(i);
      const lo = i > matchWindow ? i - matchWindow : 0;
      const hi = i + matchWindow + 1 < len2 ? i + matchWindow + 1 : len2;
      for (let j = lo; j < hi; j++) {
        if (!m2[j] && c1 === s2.charCodeAt(j)) {
          m1[i] = 1;
          m2[j] = 1;
          matches++;
          break;
        }
      }
    }

    if (matches === 0) return 0.0;

    let transpositions = 0;
    let k = 0;
    for (let i = 0; i < len1; i++) {
      if (!m1[i]) continue;
      while (!m2[k]) k++;
      if (s1.charCodeAt(i) !== s2.charCodeAt(k)) transpositions++;
      k++;
    }

    const jaro =
      matches / len1 / 3 +
      matches / len2 / 3 +
      (matches - transpositions / 2) / matches / 3;

    let prefix = 0;
    const maxPre = len1 < len2 ? len1 : len2;
    const maxPre4 = maxPre < 4 ? maxPre : 4;
    for (let i = 0; i < maxPre4; i++) {
      if (s1.charCodeAt(i) === s2.charCodeAt(i)) prefix++;
      else break;
    }

    return jaro + prefix * 0.1 * (1 - jaro);
  }

  /**
   * @param {string} s1
   * @param {string} s2
   * @returns {number} 0.0–1.0
   */
  levenshteinScore(s1, s2) {
    if (s1 === s2) return 1.0;
    const n1 = s1.length;
    const n2 = s2.length;
    const maxLen = n1 > n2 ? n1 : n2;
    if (maxLen === 0) return 1.0;
    return 1.0 - this._levenshteinDistance(s1, s2, n1, n2) / maxLen;
  }

  /**
   * Wagner-Fischer DP with rolling single-row (O(n) space).
   * @param {string} s1
   * @param {string} s2
   * @param {number} [len1]
   * @param {number} [len2]
   * @returns {number}
   */
  _levenshteinDistance(s1, s2, len1, len2) {
    if (len1 === undefined) len1 = s1.length;
    if (len2 === undefined) len2 = s2.length;
    if (s1 === s2) return 0;
    if (!len1) return len2;
    if (!len2) return len1;

    const row = this._levRow;
    for (let j = 0; j <= len2; j++) row[j] = j;

    for (let i = 1; i <= len1; i++) {
      const c1 = s1.charCodeAt(i - 1);
      let prev = i;
      for (let j = 1; j <= len2; j++) {
        const cost = c1 === s2.charCodeAt(j - 1) ? 0 : 1;
        const above = row[j];
        const diagVal = row[j - 1] + cost;
        const next = above + 1 < prev + 1
          ? (above + 1 < diagVal ? above + 1 : diagVal)
          : (prev + 1 < diagVal ? prev + 1 : diagVal);
        row[j - 1] = prev;
        prev = next;
      }
      row[len2] = prev;
    }

    return row[len2];
  }

  /**
   * @param {string} word
   * @returns {string} 4-char Soundex code
   */
  _soundex(word) {
    if (!word) return '0000';
    const w = word.toLowerCase();
    let code = w[0].toUpperCase();
    let prev = SOUNDEX_MAP[w[0]] || '0';

    for (let i = 1; i < w.length && code.length < 4; i++) {
      const digit = SOUNDEX_MAP[w[i]] || '0';
      if (digit !== '0' && digit !== prev) code += digit;
      prev = digit;
    }

    return code.padEnd(4, '0');
  }

  /**
   * @param {string} s1
   * @param {string} s2
   * @returns {number} 0.0–1.0
   */
  phoneticScore(s1, s2) {
    return this._phoneticScore(s1.split(/\s+/), s2.split(/\s+/));
  }

  /**
   * @param {string} s1
   * @param {string} s2
   * @returns {number} 0.0–1.0
   */
  tokenSortScore(s1, s2) {
    const sorted1 = s1.split(/\s+/).sort().join(' ');
    const sorted2 = s2.split(/\s+/).sort().join(' ');
    return this.jaroWinkler(sorted1, sorted2);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  _phoneticScore(toks1, toks2) {
    const n1 = toks1.length;
    const n2 = toks2.length;
    if (!n1 || !n2) return 0.0;

    const codes2 = new Array(n2);
    for (let i = 0; i < n2; i++) codes2[i] = this._soundex(toks2[i]);

    const used = new Array(n2).fill(false);
    let matched = 0;

    for (let i = 0; i < n1; i++) {
      const c1 = this._soundex(toks1[i]);
      for (let j = 0; j < n2; j++) {
        if (!used[j] && c1 === codes2[j]) {
          matched++;
          used[j] = true;
          break;
        }
      }
    }

    const maxLen = n1 > n2 ? n1 : n2;
    return matched / maxLen;
  }

  _exactMatchedFields(normStr) {
    const tokens = normStr.split(' ');
    const fields = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]) fields.push(tokens[i], tokens[i]);
    }
    return fields;
  }

  _computeMatchedFields(qToks, cToks) {
    const fields = [];
    const usedC = new Array(cToks.length).fill(false);

    for (let i = 0; i < qToks.length; i++) {
      const qt = qToks[i];
      if (!qt) continue;
      let bestScore = 0;
      let bestIdx = -1;
      for (let j = 0; j < cToks.length; j++) {
        if (usedC[j] || !cToks[j]) continue;
        const sc = this.jaroWinkler(qt, cToks[j]);
        if (sc > bestScore) {
          bestScore = sc;
          bestIdx = j;
        }
      }
      if (bestScore > 0.5 && bestIdx !== -1) {
        fields.push(qt, cToks[bestIdx]);
        usedC[bestIdx] = true;
      }
    }

    return fields;
  }
}

module.exports = { FuzzyMatcher };
