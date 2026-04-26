# Adverse Media Screening — News Search Integration

> GitHub Issue: [#50](https://github.com/jbillay/kyc-agent/issues/50)
> Epic: Adverse Media Screening (#49)
> Size: M (1-3 days) | Priority: High

## Context

The Screening Agent currently handles sanctions screening (OFAC SDN, UK HMT) but has no adverse media capability. Step 5 of the architecture's Screening Agent pipeline (`run_adverse_media_screening`) requires a news search data source. This story implements a `NewsSearchProvider` that searches news APIs for articles about screened individuals and entities, using risk-relevant keywords to filter results. Results are normalized, deduplicated, and cached in `data_source_cache` for audit reproducibility.

The provider follows the same pattern as existing data integration providers (Companies House, OFAC, UK HMT): a common interface, configurable via YAML, with responses cached in PostgreSQL.

## Requirements

### Functional

1. `NewsSearchProvider` implementing a common interface: `search(query)` returning normalized `NewsArticle[]`
2. Search queries constructed from: subject name + risk-relevant keywords (fraud, sanctions, money laundering, corruption, investigation, arrest, charged, convicted, regulatory action, fine)
3. Configurable keyword list in `config/data-sources.yaml`
4. Results include: article title, source/publisher, publication date, snippet/description, URL
5. Configurable date range filter (default: last 3 years)
6. Deduplication of results across multiple search queries for the same subject (by URL)
7. Results cached in `data_source_cache` table with standard query hash + TTL pattern
8. Graceful handling of: API rate limits (429 → exponential backoff), API errors (500 → retry), API unavailability (timeout → skip with warning)
9. Maximum results per subject configurable (default: 20)
10. Support for both individual and entity name search (entity names may need special handling — remove "Ltd", "Inc" suffixes for better results)

### Non-Functional

- News search for all subjects in a typical case (10-15 subjects) completes within 60 seconds
- API key stored as environment variable, referenced via configuration
- No full article scraping — use search API snippets only (legal/IP compliance)
- Provider is swappable: Google Custom Search is default; Bing News API is an alternative

## Technical Design

### File: `backend/src/data-sources/media/types.js`

```javascript
/**
 * News Search Provider Interface.
 *
 * @typedef {Object} NewsSearchProvider
 * @property {string} name - Provider identifier (e.g., 'google-custom-search')
 * @property {(query: NewsSearchQuery) => Promise<NewsArticle[]>} search
 * @property {() => Promise<boolean>} isAvailable - Health check
 */

/**
 * @typedef {Object} NewsSearchQuery
 * @property {string} name - Person or entity name to search
 * @property {'individual'|'entity'} entityType
 * @property {string[]} [aliases] - Alternative name spellings
 * @property {string} [nationality] - Helps narrow results
 * @property {string[]} [keywords] - Override default risk keywords
 * @property {number} [maxResults] - Max articles to return (default: 20)
 * @property {number} [dateRangeYears] - How far back to search (default: 3)
 */

/**
 * @typedef {Object} NewsArticle
 * @property {string} id - Deterministic ID (SHA-256 of URL)
 * @property {string} title
 * @property {string} source - Publisher name
 * @property {string} publishedDate - ISO 8601
 * @property {string} snippet - Article description / summary text
 * @property {string} url
 * @property {string} query - The search query that found this article
 * @property {string} fetchedAt - ISO 8601 timestamp
 */
```

### File: `backend/src/data-sources/media/news-search.js`

```javascript
/**
 * Google Custom Search–based news search provider.
 *
 * Uses the Google Custom Search JSON API with a search engine configured
 * for news results. Falls back gracefully on rate limits or errors.
 */

const crypto = require('crypto');
const { getDataSourceCache, setDataSourceCache } = require('../../services/data-cache');

const DEFAULT_KEYWORDS = [
  'fraud', 'sanctions', 'money laundering', 'corruption',
  'investigation', 'arrest', 'charged', 'convicted',
  'regulatory action', 'fine', 'indicted', 'penalty',
];

const DEFAULT_MAX_RESULTS = 20;
const DEFAULT_DATE_RANGE_YEARS = 3;

class GoogleNewsSearchProvider {
  /**
   * @param {Object} config
   * @param {string} config.apiKey - Google API key
   * @param {string} config.searchEngineId - Custom Search Engine ID
   * @param {string[]} [config.keywords] - Override default risk keywords
   * @param {number} [config.maxResults]
   * @param {number} [config.dateRangeYears]
   * @param {number} [config.cacheTtlMinutes] - Cache TTL (default: 1440 = 24h)
   */
  constructor(config) {
    this.name = 'google-custom-search';
    this.apiKey = config.apiKey;
    this.searchEngineId = config.searchEngineId;
    this.keywords = config.keywords || DEFAULT_KEYWORDS;
    this.maxResults = config.maxResults || DEFAULT_MAX_RESULTS;
    this.dateRangeYears = config.dateRangeYears || DEFAULT_DATE_RANGE_YEARS;
    this.cacheTtlMinutes = config.cacheTtlMinutes || 1440;
  }

  /**
   * Search for news articles about a subject.
   *
   * Constructs multiple queries (name + keyword groups), deduplicates results
   * by URL, and returns normalized NewsArticle objects.
   *
   * @param {import('./types').NewsSearchQuery} query
   * @returns {Promise<import('./types').NewsArticle[]>}
   */
  async search(query) {
    const maxResults = query.maxResults || this.maxResults;
    const dateRangeYears = query.dateRangeYears || this.dateRangeYears;

    // Check cache first
    const cacheKey = this._buildCacheKey(query);
    const cached = await getDataSourceCache(this.name, cacheKey);
    if (cached) return cached;

    const searchName = this._normalizeNameForSearch(query.name, query.entityType);
    const keywords = query.keywords || this.keywords;

    // Build search queries: name + keyword groups (batch keywords to reduce API calls)
    const keywordGroups = this._groupKeywords(keywords, 3);
    const searchQueries = keywordGroups.map(
      (group) => `"${searchName}" ${group.join(' OR ')}`
    );

    // Add aliases as additional queries
    if (query.aliases?.length) {
      for (const alias of query.aliases) {
        const aliasName = this._normalizeNameForSearch(alias, query.entityType);
        searchQueries.push(`"${aliasName}" ${keywords.slice(0, 3).join(' OR ')}`);
      }
    }

    // Execute searches with rate limit handling
    const allArticles = [];
    for (const searchQuery of searchQueries) {
      const articles = await this._executeSearch(searchQuery, dateRangeYears);
      allArticles.push(...articles);
    }

    // Deduplicate by URL
    const seen = new Set();
    const deduplicated = allArticles.filter((article) => {
      if (seen.has(article.url)) return false;
      seen.add(article.url);
      return true;
    });

    // Sort by date (most recent first) and limit
    const results = deduplicated
      .sort((a, b) => new Date(b.publishedDate) - new Date(a.publishedDate))
      .slice(0, maxResults);

    // Cache results
    await setDataSourceCache(this.name, cacheKey, results, this.cacheTtlMinutes);

    return results;
  }

  /**
   * Remove corporate suffixes for entity searches to improve results.
   */
  _normalizeNameForSearch(name, entityType) {
    if (entityType === 'entity') {
      return name
        .replace(/\b(Ltd|Limited|Inc|Corp|Corporation|LLC|LLP|PLC|SA|GmbH|AG)\b\.?/gi, '')
        .trim();
    }
    return name;
  }

  /**
   * Group keywords into batches for OR queries.
   */
  _groupKeywords(keywords, groupSize) {
    const groups = [];
    for (let i = 0; i < keywords.length; i += groupSize) {
      groups.push(keywords.slice(i, i + groupSize));
    }
    return groups;
  }

  /**
   * Execute a single search query against Google Custom Search API.
   *
   * @param {string} searchQuery
   * @param {number} dateRangeYears
   * @returns {Promise<import('./types').NewsArticle[]>}
   */
  async _executeSearch(searchQuery, dateRangeYears) {
    const dateRestrict = `d[${dateRangeYears * 365}]`;
    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('cx', this.searchEngineId);
    url.searchParams.set('q', searchQuery);
    url.searchParams.set('dateRestrict', dateRestrict);
    url.searchParams.set('num', '10');
    url.searchParams.set('sort', 'date');

    const response = await this._fetchWithRetry(url.toString());
    if (!response || !response.items) return [];

    return response.items.map((item) => ({
      id: crypto.createHash('sha256').update(item.link).digest('hex'),
      title: item.title,
      source: item.displayLink || new URL(item.link).hostname,
      publishedDate: item.pagemap?.metatags?.[0]?.['article:published_time']
        || item.snippet?.match(/\w+ \d+, \d{4}/)?.[0]
        || new Date().toISOString(),
      snippet: item.snippet || '',
      url: item.link,
      query: searchQuery,
      fetchedAt: new Date().toISOString(),
    }));
  }

  /**
   * Fetch with exponential backoff on rate limits and transient errors.
   *
   * @param {string} url
   * @param {number} [retries=3]
   * @returns {Promise<Object|null>}
   */
  async _fetchWithRetry(url, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(url);

        if (response.status === 429) {
          // Rate limited — backoff
          const delay = Math.pow(2, attempt) * 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        if (!response.ok) {
          if (response.status >= 500 && attempt < retries) {
            const delay = Math.pow(2, attempt) * 500;
            await new Promise((resolve) => setTimeout(resolve, delay));
            continue;
          }
          console.error(`News search API error: ${response.status} ${response.statusText}`);
          return null;
        }

        return await response.json();
      } catch (error) {
        if (attempt < retries) {
          const delay = Math.pow(2, attempt) * 500;
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        console.error(`News search API unavailable: ${error.message}`);
        return null;
      }
    }
    return null;
  }

  /**
   * Build a deterministic cache key from query parameters.
   */
  _buildCacheKey(query) {
    const keyData = JSON.stringify({
      name: query.name,
      entityType: query.entityType,
      aliases: query.aliases?.sort() || [],
      dateRangeYears: query.dateRangeYears || this.dateRangeYears,
    });
    return crypto.createHash('sha256').update(keyData).digest('hex');
  }

  async isAvailable() {
    return !!(this.apiKey && this.searchEngineId);
  }
}

module.exports = { GoogleNewsSearchProvider, DEFAULT_KEYWORDS };
```

### Configuration: `config/data-sources.yaml` (additions)

```yaml
media:
  provider: google-custom-search
  api_key_env: GOOGLE_SEARCH_API_KEY
  search_engine_id_env: GOOGLE_SEARCH_ENGINE_ID
  keywords:
    - fraud
    - sanctions
    - money laundering
    - corruption
    - investigation
    - arrest
    - charged
    - convicted
    - regulatory action
    - fine
    - indicted
    - penalty
  max_results: 20
  date_range_years: 3
  cache_ttl_minutes: 1440  # 24 hours
```

### Data Caching

News search results use the same `data_source_cache` table as all other data sources:

```
provider:     'google-custom-search'
query_hash:   SHA-256 of { name, entityType, aliases, dateRangeYears }
response_data: NewsArticle[] as JSONB
fetched_at:   timestamp of search
expires_at:   fetched_at + cache_ttl_minutes
case_id:      linked to the triggering case
```

### Query Construction Strategy

```
Subject: "John Smith" (individual)
  Query 1: "John Smith" fraud OR sanctions OR money laundering
  Query 2: "John Smith" corruption OR investigation OR arrest
  Query 3: "John Smith" charged OR convicted OR regulatory action
  Query 4: "John Smith" fine OR indicted OR penalty

Subject: "Acme Holdings Ltd" (entity)
  Name normalized: "Acme Holdings" (suffix removed)
  Query 1: "Acme Holdings" fraud OR sanctions OR money laundering
  Query 2: "Acme Holdings" corruption OR investigation OR arrest
  ...

Subject with alias: "Mohammed Al-Rashid" (alias: "Mohamed Al Rashid")
  Queries for primary name + queries for alias
```

## Acceptance Criteria

- [ ] `NewsSearchProvider` interface defined in `types.js` with `search()` and `isAvailable()`
- [ ] `GoogleNewsSearchProvider` implements the interface using Google Custom Search JSON API
- [ ] Search queries constructed from subject name + risk-relevant keywords grouped in OR batches
- [ ] Entity names normalized: corporate suffixes (Ltd, Inc, Corp, etc.) removed for search
- [ ] Alias names generate additional search queries
- [ ] Results normalized to `NewsArticle` format: id, title, source, publishedDate, snippet, url
- [ ] Article `id` is deterministic (SHA-256 of URL) for deduplication
- [ ] Date range filter applied (configurable, default: 3 years)
- [ ] Results deduplicated by URL across all queries for same subject
- [ ] Results sorted by publication date (most recent first)
- [ ] Maximum results per subject enforced (configurable, default: 20)
- [ ] Results cached in `data_source_cache` with standard query hash + TTL pattern
- [ ] Cache hit returns stored results without API call
- [ ] API rate limits (429) handled with exponential backoff (up to 3 retries)
- [ ] API errors (5xx) retried with backoff; non-retryable errors (4xx) logged and skipped
- [ ] API unavailability (timeout/network error) does not crash the agent — returns empty results with warning
- [ ] Configuration loaded from `config/data-sources.yaml` (provider, API key env var, keywords, limits)
- [ ] API key read from environment variable, not hardcoded

## Dependencies

- **Depends on**: #16 (Data caching service)
- **Blocks**: #51 (LLM-based adverse media analysis — needs news articles as input)

## Testing Strategy

1. **Successful search**: Mock API returns 10 results → verify normalization to `NewsArticle[]`
2. **Query construction — individual**: Verify queries include quoted name + keyword groups
3. **Query construction — entity**: Verify corporate suffix stripped from name
4. **Query construction — aliases**: Verify alias names generate additional queries
5. **Deduplication**: Same URL from two queries → only one `NewsArticle` returned
6. **Date range**: Verify `dateRestrict` parameter set correctly for 3-year default
7. **Max results**: 30 results returned → only 20 after limit
8. **Sort order**: Results sorted by publishedDate descending
9. **Cache hit**: Second call with same query → returns cached, no API call
10. **Cache miss**: Different query → API called, results cached
11. **Rate limit (429)**: API returns 429 → retries with backoff, succeeds on retry
12. **Server error (500)**: API returns 500 → retries, returns null after exhausting retries
13. **Network error**: fetch throws → retries, returns empty array with warning
14. **API unavailable**: `isAvailable()` returns false when API key missing
15. **Empty results**: API returns no items → returns empty array
16. **Entity suffix removal**: "Acme Holdings Ltd" → searched as "Acme Holdings"
17. **Integration**: Real API call (guarded by env var presence) → verify response shape
