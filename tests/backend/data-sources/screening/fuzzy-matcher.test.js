'use strict';

const { FuzzyMatcher } = require('../../../../backend/src/data-sources/screening/fuzzy-matcher');

describe('FuzzyMatcher', () => {
  let matcher;

  beforeEach(() => {
    matcher = new FuzzyMatcher();
  });

  // ─── normalize ─────────────────────────────────────────────────────────────

  describe('normalize', () => {
    test('empty string → ""', () => {
      expect(matcher.normalize('')).toBe('');
    });

    test('null → ""', () => {
      expect(matcher.normalize(null)).toBe('');
    });

    test('undefined → ""', () => {
      expect(matcher.normalize(undefined)).toBe('');
    });

    test('title-only input → ""', () => {
      expect(matcher.normalize('Mr.')).toBe('');
    });

    test('diacritics: "José García" → "jose garcia"', () => {
      expect(matcher.normalize('José García')).toBe('jose garcia');
    });

    test('title removal: "Dr. John Smith" → "john smith"', () => {
      expect(matcher.normalize('Dr. John Smith')).toBe('john smith');
    });

    test('suffix removal: "John Smith Jr." → "john smith"', () => {
      expect(matcher.normalize('John Smith Jr.')).toBe('john smith');
    });

    test('hyphen-to-space: "al-Rahman" → "al rahman"', () => {
      expect(matcher.normalize('al-Rahman')).toBe('al rahman');
    });

    test('transliteration ß→ss: "Müller-Strauß" → "muller strauss"', () => {
      expect(matcher.normalize('Müller-Strauß')).toBe('muller strauss');
    });

    test('transliteration ø→o: "Bjørn" → "bjorn"', () => {
      expect(matcher.normalize('Bjørn')).toBe('bjorn');
    });

    test('transliteration æ→ae: "Ærling" → "aerling"', () => {
      expect(matcher.normalize('Ærling')).toBe('aerling');
    });

    test('combined pipeline: "Dr. José García-López Jr." → "jose garcia lopez"', () => {
      expect(matcher.normalize('Dr. José García-López Jr.')).toBe('jose garcia lopez');
    });
  });

  // ─── jaroWinkler ────────────────────────────────────────────────────────────

  describe('jaroWinkler', () => {
    test('equal strings → 1.0', () => {
      expect(matcher.jaroWinkler('smith', 'smith')).toBeCloseTo(1.0);
    });

    test('either empty → 0.0', () => {
      expect(matcher.jaroWinkler('', 'smith')).toBe(0.0);
      expect(matcher.jaroWinkler('smith', '')).toBe(0.0);
    });

    test('MARTHA vs MARHTA → ~0.961 (Jaro-Winkler with prefix bonus; Jaro alone is 0.944)', () => {
      // Pure Jaro = 17/18 ≈ 0.944; Winkler prefix bonus of 3 chars pushes to ~0.961
      expect(matcher.jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.961, 2);
    });

    test('DIXON vs DICKSONX → ~0.813', () => {
      expect(matcher.jaroWinkler('DIXON', 'DICKSONX')).toBeCloseTo(0.813, 2);
    });
  });

  // ─── levenshteinScore ──────────────────────────────────────────────────────

  describe('levenshteinScore', () => {
    test('distance("kitten","sitting") = 3', () => {
      expect(matcher._levenshteinDistance('kitten', 'sitting')).toBe(3);
    });

    test('distance("", "") = 0', () => {
      expect(matcher._levenshteinDistance('', '')).toBe(0);
    });

    test('similarity("", "") = 1.0', () => {
      expect(matcher.levenshteinScore('', '')).toBeCloseTo(1.0);
    });

    test('same strings → 1.0', () => {
      expect(matcher.levenshteinScore('john', 'john')).toBeCloseTo(1.0);
    });
  });

  // ─── phoneticScore ─────────────────────────────────────────────────────────

  describe('phoneticScore', () => {
    test('_soundex("Robert") → "R163"', () => {
      expect(matcher._soundex('Robert')).toBe('R163');
    });

    test('_soundex("John") → "J500"', () => {
      expect(matcher._soundex('John')).toBe('J500');
    });

    test('_soundex("Smith") → "S530"', () => {
      expect(matcher._soundex('Smith')).toBe('S530');
    });

    test('_soundex("") → "0000"', () => {
      expect(matcher._soundex('')).toBe('0000');
    });

    test('phonetic match: "Mohammed" vs "Muhammad" → > 0', () => {
      expect(matcher.phoneticScore('mohammed', 'muhammad')).toBeGreaterThan(0);
    });
  });

  // ─── tokenSortScore ────────────────────────────────────────────────────────

  describe('tokenSortScore', () => {
    test('reordered tokens → 1.0', () => {
      expect(matcher.tokenSortScore('john smith', 'smith john')).toBeCloseTo(1.0);
    });

    test('same string → 1.0', () => {
      expect(matcher.tokenSortScore('john smith', 'john smith')).toBeCloseTo(1.0);
    });
  });

  // ─── compare ───────────────────────────────────────────────────────────────

  describe('compare', () => {
    test('exact match → score 100, isMatch true, non-empty matchedFields', () => {
      const r = matcher.compare('John Smith', 'John Smith');
      expect(r.score).toBe(100);
      expect(r.isMatch).toBe(true);
      expect(r.matchedFields.length).toBeGreaterThan(0);
    });

    test('case-insensitive: "JOHN SMITH" vs "john smith" → score 100', () => {
      const r = matcher.compare('JOHN SMITH', 'john smith');
      expect(r.score).toBe(100);
      expect(r.isMatch).toBe(true);
    });

    test('phonetic: "Mohammed" vs "Muhammad" → score ≥ 80', () => {
      const r = matcher.compare('Mohammed', 'Muhammad');
      expect(r.score).toBeGreaterThanOrEqual(80);
    });

    test('typo: "Jonh Smith" vs "John Smith" → score ≥ 85, isMatch true', () => {
      const r = matcher.compare('Jonh Smith', 'John Smith');
      expect(r.score).toBeGreaterThanOrEqual(85);
      expect(r.isMatch).toBe(true);
    });

    test('abbreviation: "J. Smith" vs "John Smith" → score < 85, isMatch false', () => {
      const r = matcher.compare('J. Smith', 'John Smith');
      expect(r.score).toBeLessThan(85);
      expect(r.isMatch).toBe(false);
    });

    test('abbreviation score is ≥ 30 (above noise floor)', () => {
      const r = matcher.compare('J. Smith', 'John Smith');
      expect(r.score).toBeGreaterThanOrEqual(30);
    });

    test('completely different: "John Smith" vs "Alice Jones" → score < 30, isMatch false', () => {
      const r = matcher.compare('John Smith', 'Alice Jones');
      expect(r.score).toBeLessThan(30);
      expect(r.isMatch).toBe(false);
    });

    test('empty input: "" vs "John Smith" → score 0, isMatch false, matchedFields []', () => {
      const r = matcher.compare('', 'John Smith');
      expect(r.score).toBe(0);
      expect(r.isMatch).toBe(false);
      expect(r.matchedFields).toEqual([]);
    });

    test('null input → score 0, isMatch false, matchedFields []', () => {
      const r = matcher.compare(null, 'John Smith');
      expect(r.score).toBe(0);
      expect(r.isMatch).toBe(false);
      expect(r.matchedFields).toEqual([]);
    });

    test('determinism: same inputs × 3 → identical results', () => {
      const r1 = matcher.compare('Mohammed', 'Muhammad');
      const r2 = matcher.compare('Mohammed', 'Muhammad');
      const r3 = matcher.compare('Mohammed', 'Muhammad');
      expect(r1).toEqual(r2);
      expect(r2).toEqual(r3);
    });
  });

  // ─── threshold ─────────────────────────────────────────────────────────────

  describe('threshold', () => {
    test('default threshold is 85', () => {
      expect(new FuzzyMatcher().threshold).toBe(85);
    });

    test('custom threshold respected', () => {
      const m = new FuzzyMatcher({ threshold: 70 });
      expect(m.threshold).toBe(70);
    });

    test('exact match (100) with threshold 85 → isMatch true', () => {
      const m = new FuzzyMatcher({ threshold: 85 });
      const r = m.compare('John Smith', 'John Smith');
      expect(r.isMatch).toBe(true);
    });

    test('typo score ≥ 85 → isMatch true at default threshold', () => {
      const r = matcher.compare('Jonh Smith', 'John Smith');
      expect(r.isMatch).toBe(r.score >= 85);
    });

    test('threshold boundary inclusive: custom threshold 70, typo score → isMatch = score >= 70', () => {
      const m70 = new FuzzyMatcher({ threshold: 70 });
      const r = m70.compare('Jonh Smith', 'John Smith');
      expect(r.isMatch).toBe(r.score >= 70);
      expect(r.isMatch).toBe(true);
    });
  });

  // ─── token-reorder (US3) ───────────────────────────────────────────────────

  describe('token-reorder', () => {
    test('"Smith John" vs "John Smith" → score ≥ 90, isMatch true', () => {
      const r = matcher.compare('Smith John', 'John Smith');
      expect(r.score).toBeGreaterThanOrEqual(90);
      expect(r.isMatch).toBe(true);
    });

    test('"Smith, John" vs "John Smith" → score ≥ 90 (comma stripped by normalize)', () => {
      const r = matcher.compare('Smith, John', 'John Smith');
      expect(r.score).toBeGreaterThanOrEqual(90);
      expect(r.isMatch).toBe(true);
    });

    test('"Garcia Lopez Jose Maria" vs "Jose Maria Garcia Lopez" → score ≥ 90', () => {
      const r = matcher.compare('Garcia Lopez Jose Maria', 'Jose Maria Garcia Lopez');
      expect(r.score).toBeGreaterThanOrEqual(90);
      expect(r.isMatch).toBe(true);
    });
  });

  // ─── performance (US4) ────────────────────────────────────────────────────

  describe('performance', () => {
    test('12,000 comparisons complete in < 500ms', () => {
      const m = new FuzzyMatcher();
      const candidates = Array.from({ length: 12000 }, (_, i) =>
        `Candidate Name ${i % 500} Test`
      );
      const query = 'Mohammed Al-Rahman';

      const start = process.hrtime.bigint();
      for (const c of candidates) {
        m.compare(query, c);
      }
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;

      expect(elapsed).toBeLessThan(500);
    });
  });
});
