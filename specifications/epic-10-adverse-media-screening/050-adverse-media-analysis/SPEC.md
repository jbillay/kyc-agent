# Adverse Media Screening — LLM-Based Adverse Media Relevance Analysis

> GitHub Issue: [#51](https://github.com/jbillay/kyc-agent/issues/51)
> Epic: Adverse Media Screening (#49)
> Size: L (3-5 days) | Priority: High

## Context

News search APIs return articles based on keyword matching, which produces many irrelevant results: articles about a different person with the same name, historical matters that have been resolved, competitor mentions, neutral business news, etc. This story adds step 4 (`run_adverse_media_screening`) to the Screening Agent pipeline, where an LLM evaluates each news article to determine: (1) is this about the same person/entity being screened? (2) is the content genuinely adverse? (3) what is the severity and category? The agent then produces decision fragments and extends the `ScreeningReport` with an adverse media section.

This follows the same conservative pattern as sanctions hit evaluation (Story #33): when in doubt, flag the article as relevant for human review.

## Requirements

### Functional

1. New step `run_adverse_media_screening` added to the Screening Agent (step 4, before `compile_screening_report`)
2. For each subject on the screening list, calls `NewsSearchProvider.search()` to get news articles
3. If no articles found for a subject, produces an `adverse_media_clear` fragment
4. If articles found, LLM evaluates each article with structured output:
   - `relevant`: boolean — is this about the same person/entity?
   - `adverse`: boolean — is the content genuinely adverse (not neutral business news)?
   - `category`: one of `financial_crime`, `fraud`, `corruption`, `tax_evasion`, `regulatory_action`, `litigation`, `terrorism`, `organized_crime`, `other`
   - `severity`: `high`, `medium`, `low`
   - `summary`: one-sentence summary of the adverse finding
   - `reasoning`: explanation of relevance/severity determination
   - `confidence`: 0-100 confidence in the assessment
5. For each relevant adverse article, produces an `adverse_media_hit` fragment with:
   - Article reference (title, source, date, URL)
   - Category, severity, summary
   - LLM reasoning
   - Status: `pending_review` for high severity, `auto_approved` for medium/low
6. For subjects where all articles are irrelevant, produces `adverse_media_clear` fragment
7. Handles common false positive patterns: same name different person, historical resolved matters, competitor/industry mentions, opinion pieces, duplicate coverage of same event
8. `ScreeningReport` extended with `adverseMedia` section containing per-subject results

### Non-Functional

- LLM evaluation of all articles across all subjects completes within 60 seconds
- Conservative: ambiguous relevance → mark as relevant
- LLM task type: `screening`
- Temperature: 0.1
- Batch articles per subject in a single LLM call (up to 10 articles per call; split into multiple calls if >10)

## Technical Design

### File: `backend/src/agents/screening/adverse-media.js`

```javascript
/**
 * Adverse media screening module.
 *
 * Orchestrates news search and LLM-based relevance analysis for each
 * subject on the screening list. Produces decision fragments and
 * adverse media results for the ScreeningReport.
 */

const { FragmentType } = require('../decision-fragment');

const MAX_ARTICLES_PER_LLM_CALL = 10;

/**
 * Run adverse media screening for all subjects.
 *
 * @param {Object} params
 * @param {import('./screening-list').ScreeningSubject[]} params.subjects - Screening subjects
 * @param {import('../../data-sources/media/types').NewsSearchProvider} params.newsProvider
 * @param {import('../../llm/llm-service')} params.llmService
 * @param {Object} params.context - Agent context (caseId, etc.)
 * @returns {Promise<{description: string, decisionFragments: Object[], llmCalls: Object[], adverseMediaResults: Map}>}
 */
async function runAdverseMediaScreening({ subjects, newsProvider, llmService, context }) {
  const fragments = [];
  const llmCalls = [];
  const adverseMediaResults = new Map();

  // Check if news search provider is available
  const available = await newsProvider.isAvailable();
  if (!available) {
    return {
      description: 'Adverse media screening skipped — news search provider unavailable',
      decisionFragments: [],
      llmCalls: [],
      adverseMediaResults,
    };
  }

  for (const subject of subjects) {
    // Search for news articles
    const articles = await newsProvider.search({
      name: subject.name,
      entityType: subject.entityType,
      aliases: subject.aliases || [],
      nationality: subject.nationality,
    });

    if (articles.length === 0) {
      // No articles found — clear
      fragments.push({
        type: FragmentType.ADVERSE_MEDIA_CLEAR,
        decision: `No adverse media found for "${subject.name}" — no news articles returned`,
        confidence: 90,
        evidence: {
          dataSources: ['news-search'],
          dataPoints: [
            { source: 'news-search', field: 'articles_found', value: 0, fetchedAt: new Date().toISOString() },
          ],
          llmReasoning: null,
        },
        status: 'auto_approved',
      });

      adverseMediaResults.set(subject.id, {
        subject,
        articles: [],
        evaluations: [],
        status: 'clear',
      });
      continue;
    }

    // Evaluate articles with LLM (batch up to MAX_ARTICLES_PER_LLM_CALL)
    const allEvaluations = [];
    const articleBatches = batchArray(articles, MAX_ARTICLES_PER_LLM_CALL);

    for (const batch of articleBatches) {
      const { evaluations, llmCall } = await evaluateArticles({
        subject,
        articles: batch,
        llmService,
        context,
      });
      allEvaluations.push(...evaluations);
      llmCalls.push(llmCall);
    }

    // Produce fragments from evaluations
    const relevantHits = allEvaluations.filter((ev) => ev.relevant && ev.adverse);

    if (relevantHits.length === 0) {
      fragments.push({
        type: FragmentType.ADVERSE_MEDIA_CLEAR,
        decision: `No relevant adverse media for "${subject.name}" — ${articles.length} articles evaluated, none adverse`,
        confidence: 85,
        evidence: {
          dataSources: ['news-search'],
          dataPoints: [
            { source: 'news-search', field: 'articles_evaluated', value: articles.length, fetchedAt: new Date().toISOString() },
            { source: 'news-search', field: 'relevant_hits', value: 0, fetchedAt: new Date().toISOString() },
          ],
          llmReasoning: 'All articles evaluated as not relevant or not adverse.',
        },
        status: 'auto_approved',
      });
    } else {
      for (const hit of relevantHits) {
        const article = articles.find((a) => a.id === hit.articleId);
        fragments.push({
          type: FragmentType.ADVERSE_MEDIA_HIT,
          decision: `Adverse media found for "${subject.name}": ${hit.summary} [${hit.category}, ${hit.severity} severity]`,
          confidence: hit.confidence || 80,
          evidence: {
            dataSources: ['news-search'],
            dataPoints: [
              { source: 'news-search', field: 'article_title', value: article?.title, fetchedAt: article?.fetchedAt },
              { source: 'news-search', field: 'article_source', value: article?.source, fetchedAt: article?.fetchedAt },
              { source: 'news-search', field: 'article_date', value: article?.publishedDate, fetchedAt: article?.fetchedAt },
              { source: 'news-search', field: 'article_url', value: article?.url, fetchedAt: article?.fetchedAt },
              { source: 'news-search', field: 'category', value: hit.category, fetchedAt: new Date().toISOString() },
              { source: 'news-search', field: 'severity', value: hit.severity, fetchedAt: new Date().toISOString() },
            ],
            llmReasoning: hit.reasoning,
          },
          // High severity → always needs human review; medium/low → auto-approved
          status: hit.severity === 'high' ? 'pending_review' : 'auto_approved',
        });
      }
    }

    adverseMediaResults.set(subject.id, {
      subject,
      articles,
      evaluations: allEvaluations,
      status: relevantHits.length > 0 ? 'hits_found' : 'clear',
    });
  }

  const totalHits = fragments.filter((f) => f.type === FragmentType.ADVERSE_MEDIA_HIT).length;
  const totalClear = fragments.filter((f) => f.type === FragmentType.ADVERSE_MEDIA_CLEAR).length;

  return {
    description: `Adverse media screening complete — ${totalClear} clear, ${totalHits} adverse media hits across ${subjects.length} subjects`,
    decisionFragments: fragments,
    llmCalls,
    adverseMediaResults,
  };
}

/**
 * Evaluate a batch of articles for a subject using LLM.
 *
 * @param {Object} params
 * @param {import('./screening-list').ScreeningSubject} params.subject
 * @param {import('../../data-sources/media/types').NewsArticle[]} params.articles
 * @param {import('../../llm/llm-service')} params.llmService
 * @param {Object} params.context
 * @returns {Promise<{evaluations: Object[], llmCall: Object}>}
 */
async function evaluateArticles({ subject, articles, llmService, context }) {
  const prompt = buildAdverseMediaPrompt({ subject, articles });

  const response = await llmService.complete({
    messages: prompt.messages,
    taskType: 'screening',
    structuredOutput: {
      name: 'adverse_media_evaluation',
      schema: {
        type: 'object',
        properties: {
          evaluations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                articleId: { type: 'string' },
                relevant: { type: 'boolean', description: 'Is this about the same person/entity?' },
                adverse: { type: 'boolean', description: 'Is the content genuinely adverse?' },
                category: {
                  type: 'string',
                  enum: ['financial_crime', 'fraud', 'corruption', 'tax_evasion',
                         'regulatory_action', 'litigation', 'terrorism',
                         'organized_crime', 'other'],
                },
                severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                summary: { type: 'string', description: 'One-sentence summary of the adverse finding' },
                reasoning: { type: 'string', description: 'Explanation of relevance and severity determination' },
                confidence: { type: 'number', description: '0-100 confidence in assessment' },
              },
              required: ['articleId', 'relevant', 'adverse', 'reasoning', 'confidence'],
            },
          },
        },
        required: ['evaluations'],
      },
    },
    temperature: 0.1,
    callContext: {
      caseId: context.caseId,
      agentType: 'screening',
      stepName: 'run_adverse_media_screening',
    },
  });

  return {
    evaluations: response.structured?.evaluations || [],
    llmCall: {
      model: response.model,
      provider: response.provider,
      latencyMs: response.latencyMs,
    },
  };
}

/**
 * Split an array into batches.
 */
function batchArray(array, batchSize) {
  const batches = [];
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }
  return batches;
}

module.exports = { runAdverseMediaScreening, evaluateArticles, batchArray };
```

### File: `backend/src/agents/screening/prompts.js` (additions)

```javascript
  /**
   * Evaluate news articles for adverse media relevance.
   *
   * @param {Object} params
   * @param {Object} params.subject - The person/entity being screened
   * @param {import('../../data-sources/media/types').NewsArticle[]} params.articles
   * @returns {{ messages: import('../../llm/types').LLMMessage[] }}
   */
  evaluateAdverseMedia({ subject, articles }) {
    const articleDetails = articles.map((a, i) =>
      `Article ${i + 1} (ID: ${a.id}):
  Title: "${a.title}"
  Source: ${a.source}
  Date: ${a.publishedDate}
  Snippet: "${a.snippet}"
  URL: ${a.url}`
    ).join('\n\n');

    return {
      messages: [
        {
          role: 'system',
          content: `You are a KYC compliance analyst evaluating news articles for adverse media screening.

For each article, determine:

1. **Relevance — Same person/entity?**
   - Is this article about the SAME person or entity being screened, or someone with a similar name?
   - Consider: name match quality, location/nationality match, role/industry match, time period
   - Common names (e.g., "John Smith") require more corroborating evidence

2. **Adverse nature — Is the content genuinely adverse?**
   - Adverse media includes: criminal allegations, regulatory enforcement, sanctions violations, fraud, corruption, money laundering, tax evasion, terrorism financing, organized crime, material litigation
   - NOT adverse: routine business news, opinion/editorial, competitor mentions, job changes, positive coverage, resolved historical matters with no ongoing risk

3. **Category** (if adverse):
   - financial_crime: money laundering, sanctions evasion, terrorist financing
   - fraud: financial fraud, misrepresentation, Ponzi schemes
   - corruption: bribery, kickbacks, abuse of public office
   - tax_evasion: tax fraud, undeclared income, offshore evasion
   - regulatory_action: fines, enforcement actions, license revocations
   - litigation: material lawsuits, class actions, significant legal disputes
   - terrorism: terrorism charges, links to designated organizations
   - organized_crime: links to organized crime groups, RICO
   - other: adverse content not fitting above categories

4. **Severity**:
   - high: criminal charges/convictions, sanctions designations, terrorism links, active investigations by law enforcement
   - medium: regulatory fines/actions, ongoing material litigation, credible allegations
   - low: historical resolved matters, minor regulatory issues, tangential mentions

IMPORTANT — Be CONSERVATIVE:
- If you are UNCERTAIN whether an article is about the same person, err on the side of marking it as relevant
- If you are UNCERTAIN whether content is adverse, err on the side of marking it as adverse
- Missing genuine adverse media is far worse than flagging false positives for human review

For non-relevant or non-adverse articles, you may omit category, severity, and summary — just set relevant/adverse to false with reasoning.`,
        },
        {
          role: 'user',
          content: `Subject being screened:
  Name: "${subject.name}"
  Type: ${subject.entityType}
  Roles: ${subject.roles.join(', ')}
  Nationality: ${subject.nationality || 'Not available'}
  Country of Residence: ${subject.countryOfResidence || 'Not available'}

News articles to evaluate:

${articleDetails}

Evaluate each article and return a JSON object with an "evaluations" array. For each article include: articleId, relevant, adverse, category (if adverse), severity (if adverse), summary (if adverse), reasoning, confidence.`,
        },
      ],
    };
  },
```

### File: `backend/src/agents/screening/index.js` (additions)

The Screening Agent's step list is extended to insert `run_adverse_media_screening` as step 4:

```javascript
const { runAdverseMediaScreening } = require('./adverse-media');

// In the constructor or step definition:
this.steps = [
  { name: 'compile_screening_list', handler: '_compileScreeningList' },
  { name: 'run_sanctions_screening', handler: '_runSanctionsScreening' },
  { name: 'evaluate_sanctions_hits', handler: '_evaluateSanctionsHits' },
  { name: 'run_adverse_media_screening', handler: '_runAdverseMediaScreening' },  // NEW
  { name: 'compile_screening_report', handler: '_compileScreeningReport' },
];

// ─── Step 4: Run Adverse Media Screening ────

/**
 * Search for and evaluate adverse media for each screening subject.
 */
async _runAdverseMediaScreening(context) {
  const result = await runAdverseMediaScreening({
    subjects: this._subjects,
    newsProvider: this._newsProvider,
    llmService: this.llmService,
    context,
  });

  // Store results for report compilation
  this._adverseMediaResults = result.adverseMediaResults;

  return {
    description: result.description,
    decisionFragments: result.decisionFragments,
    llmCalls: result.llmCalls,
  };
}
```

### File: `backend/src/agents/screening/screening-report.js` (extensions)

```javascript
/**
 * @typedef {Object} ScreeningReport
 * @property {number} totalSubjects
 * @property {number} totalClear
 * @property {number} totalWithHits
 * @property {number} totalConfirmedHits
 * @property {number} totalDismissedHits
 * @property {AdverseMediaSummary} adverseMedia          // NEW
 * @property {'clear'|'low'|'medium'|'high'|'critical'} overallRisk
 * @property {string[]} listsScreened
 * @property {ScreeningSubjectResult[]} subjects
 */

/**
 * @typedef {Object} AdverseMediaSummary
 * @property {number} totalSubjectsScreened
 * @property {number} totalArticlesEvaluated
 * @property {number} totalRelevantHits
 * @property {number} highSeverityHits
 * @property {number} mediumSeverityHits
 * @property {number} lowSeverityHits
 * @property {string[]} categoriesFound - Unique categories across all hits
 */

/**
 * @typedef {Object} AdverseMediaHit
 * @property {string} articleId
 * @property {string} title
 * @property {string} source
 * @property {string} publishedDate
 * @property {string} url
 * @property {string} category
 * @property {string} severity
 * @property {string} summary
 * @property {string} reasoning
 * @property {number} confidence
 */

/**
 * Extended ScreeningSubjectResult now includes adverseMedia field:
 *
 * @typedef {Object} ScreeningSubjectResult
 * @property {string} id
 * @property {string} name
 * @property {'individual'|'entity'} entityType
 * @property {string[]} roles
 * @property {'clear'|'hits_confirmed'|'hits_dismissed'} screeningStatus
 * @property {EvaluatedHit[]} hits
 * @property {AdverseMediaSubjectResult} adverseMedia    // NEW
 */

/**
 * @typedef {Object} AdverseMediaSubjectResult
 * @property {'clear'|'hits_found'} status
 * @property {number} articlesEvaluated
 * @property {AdverseMediaHit[]} relevantHits
 */
```

### Updated `_compileScreeningReport` (report compilation additions)

```javascript
  // In _compileScreeningReport, after existing logic:

  // Aggregate adverse media results
  let totalArticlesEvaluated = 0;
  let totalRelevantHits = 0;
  let highSeverityHits = 0;
  let mediumSeverityHits = 0;
  let lowSeverityHits = 0;
  const categoriesFound = new Set();

  for (const [subjectId, entry] of this._adverseMediaResults || new Map()) {
    const relevantEvals = (entry.evaluations || []).filter((ev) => ev.relevant && ev.adverse);
    totalArticlesEvaluated += entry.articles.length;
    totalRelevantHits += relevantEvals.length;

    for (const ev of relevantEvals) {
      if (ev.severity === 'high') highSeverityHits++;
      else if (ev.severity === 'medium') mediumSeverityHits++;
      else lowSeverityHits++;
      if (ev.category) categoriesFound.add(ev.category);
    }

    // Add adverseMedia to the subject entry in subjects array
    const subjectEntry = subjects.find((s) => s.id === subjectId);
    if (subjectEntry) {
      subjectEntry.adverseMedia = {
        status: relevantEvals.length > 0 ? 'hits_found' : 'clear',
        articlesEvaluated: entry.articles.length,
        relevantHits: relevantEvals.map((ev) => {
          const article = entry.articles.find((a) => a.id === ev.articleId);
          return {
            articleId: ev.articleId,
            title: article?.title,
            source: article?.source,
            publishedDate: article?.publishedDate,
            url: article?.url,
            category: ev.category,
            severity: ev.severity,
            summary: ev.summary,
            reasoning: ev.reasoning,
            confidence: ev.confidence,
          };
        }),
      };
    }
  }

  this._report.adverseMedia = {
    totalSubjectsScreened: this._adverseMediaResults?.size || 0,
    totalArticlesEvaluated,
    totalRelevantHits,
    highSeverityHits,
    mediumSeverityHits,
    lowSeverityHits,
    categoriesFound: [...categoriesFound],
  };

  // Update overall risk to account for adverse media
  if (totalConfirmed > 0) overallRisk = 'critical';
  else if (highSeverityHits > 0) overallRisk = 'high';          // NEW
  else if (mediumSeverityHits > 0) overallRisk = 'medium';      // NEW
  else if (totalDismissed > 0 || lowSeverityHits > 0) overallRisk = 'low';
  else overallRisk = 'clear';
```

### LLM Evaluation Flow

```
Subject "John Smith" — 5 articles from news search
  │
  ├── Build prompt with subject metadata + all 5 articles (snippets)
  │
  ├── LLM (screening task type, temperature 0.1)
  │     │
  │     ├── Article 1: "John Smith Convicted of Wire Fraud" — relevant ✓, adverse ✓
  │     │   → category: fraud, severity: high, confidence: 95
  │     │
  │     ├── Article 2: "John Smith Promoted to VP at Bank" — relevant ✓, adverse ✗
  │     │   → not adverse (positive business news)
  │     │
  │     ├── Article 3: "Smith & Associates Fined by SEC" — relevant ?, adverse ✓
  │     │   → relevant (conservative: same last name, finance industry), severity: medium
  │     │
  │     ├── Article 4: "John Smith Wins Tennis Tournament" — relevant ✗
  │     │   → different person (sports context, no financial connection)
  │     │
  │     └── Article 5: "Former CEO John Smith Under Investigation" — relevant ✓, adverse ✓
  │         → category: regulatory_action, severity: high, confidence: 88
  │
  ├── Article 1 → adverse_media_hit fragment (pending_review — high severity)
  ├── Article 3 → adverse_media_hit fragment (auto_approved — medium severity)
  ├── Article 5 → adverse_media_hit fragment (pending_review — high severity)
  └── Articles 2,4 → excluded from fragments (not adverse / not relevant)
```

### Severity → Review Status Mapping

| Severity | Fragment Status | Risk Score Addition | Rationale |
|----------|----------------|-------------------|-----------|
| high | `pending_review` | +15 per hit | Criminal, sanctions, terrorism — always needs human review |
| medium | `auto_approved` | +8 per hit | Regulatory action, litigation — significant but less urgent |
| low | `auto_approved` | +3 per hit | Historical, minor issues — informational |

### ScreeningReport Output Shape (Extended)

```javascript
{
  totalSubjects: 12,
  totalClear: 9,
  totalWithHits: 3,
  totalConfirmedHits: 1,        // sanctions
  totalDismissedHits: 3,        // sanctions
  adverseMedia: {               // NEW
    totalSubjectsScreened: 12,
    totalArticlesEvaluated: 47,
    totalRelevantHits: 4,
    highSeverityHits: 2,
    mediumSeverityHits: 1,
    lowSeverityHits: 1,
    categoriesFound: ['fraud', 'regulatory_action', 'corruption'],
  },
  overallRisk: 'critical',
  listsScreened: ['OFAC-SDN', 'UK-HMT'],
  subjects: [
    {
      id: 'uuid',
      name: 'John Smith',
      entityType: 'individual',
      roles: ['director'],
      screeningStatus: 'hits_confirmed',
      hits: [ /* sanctions hits */ ],
      adverseMedia: {            // NEW
        status: 'hits_found',
        articlesEvaluated: 5,
        relevantHits: [
          {
            articleId: 'sha256hash',
            title: 'John Smith Convicted of Wire Fraud',
            source: 'reuters.com',
            publishedDate: '2025-06-15',
            url: 'https://reuters.com/...',
            category: 'fraud',
            severity: 'high',
            summary: 'Former director convicted of wire fraud scheme involving $2M in client funds.',
            reasoning: 'Name matches exactly, article describes same individual as director in financial services...',
            confidence: 95,
          },
        ],
      },
    },
    {
      id: 'uuid',
      name: 'Acme Holdings',
      entityType: 'entity',
      roles: ['subject-entity'],
      screeningStatus: 'clear',
      hits: [],
      adverseMedia: {
        status: 'clear',
        articlesEvaluated: 8,
        relevantHits: [],
      },
    },
  ],
}
```

## Decision Fragment Types

| Fragment Type | When Produced | Status | Evidence |
|--------------|---------------|--------|----------|
| `adverse_media_clear` | No articles found OR all articles evaluated as irrelevant/not adverse | `auto_approved` | Article count, evaluation summary |
| `adverse_media_hit` | Article is relevant AND adverse | `pending_review` (high) or `auto_approved` (medium/low) | Article reference, category, severity, summary, LLM reasoning |

## Acceptance Criteria

- [ ] Step `run_adverse_media_screening` added to Screening Agent as step 4 (before report compilation)
- [ ] Calls `NewsSearchProvider.search()` for each subject on the screening list
- [ ] No articles found → `adverse_media_clear` fragment with `auto_approved` status
- [ ] Articles found → LLM evaluates each article with structured output
- [ ] LLM evaluates: relevant (same person?), adverse (genuinely negative?), category, severity, summary
- [ ] Categories: financial_crime, fraud, corruption, tax_evasion, regulatory_action, litigation, terrorism, organized_crime, other
- [ ] Severity: high, medium, low
- [ ] Relevant + adverse → `adverse_media_hit` fragment with article reference, category, severity, summary
- [ ] High severity → `pending_review`; medium/low → `auto_approved`
- [ ] All articles irrelevant → `adverse_media_clear` fragment
- [ ] Conservative approach: uncertain relevance → mark as relevant; uncertain adversity → mark as adverse
- [ ] Prompt handles false positive patterns: name disambiguation, historical matters, neutral business news
- [ ] Articles batched per subject (max 10 per LLM call)
- [ ] `ScreeningReport` extended with `adverseMedia` section (summary + per-subject results)
- [ ] Report includes: totalArticlesEvaluated, totalRelevantHits, severity breakdown, categories found
- [ ] Overall risk updated: high severity adverse media → `high` risk (if no sanctions hits)
- [ ] LLM task type: `screening`, temperature: 0.1
- [ ] News provider unavailable → step completes with warning, no fragments (does not crash agent)

## Dependencies

- **Depends on**: #50 (News search provider), #31 (Screening list — subject data), #8 (LLM service), #22 (Decision fragments)
- **Blocks**: #57-#58 (Risk Assessment Agent — uses extended ScreeningReport with adverse media data)

## Testing Strategy

1. **No articles — clear**: News search returns empty → verify `adverse_media_clear` fragment
2. **All irrelevant**: 3 articles, none relevant → verify `adverse_media_clear`
3. **All not adverse**: 3 articles, relevant but positive news → verify `adverse_media_clear`
4. **Single hit — high severity**: Article about same person, criminal charges → verify `adverse_media_hit` with `pending_review`, category `financial_crime`, severity `high`
5. **Single hit — medium severity**: Regulatory fine → verify `auto_approved`, severity `medium`
6. **Single hit — low severity**: Historical resolved matter → verify `auto_approved`, severity `low`
7. **Multiple hits**: 3 relevant adverse articles → verify 3 separate `adverse_media_hit` fragments
8. **Name disambiguation**: Articles about different "John Smith" → verify marked as not relevant
9. **Conservative — ambiguous relevance**: Article might be about subject → verify marked relevant
10. **Conservative — ambiguous adversity**: Article might be adverse → verify marked adverse
11. **Article batching**: 15 articles → verify split into 2 LLM calls (10 + 5)
12. **Report — adverse media section**: Verify `adverseMedia` summary has correct counts and categories
13. **Report — per-subject**: Verify each subject has `adverseMedia` field with correct status
14. **Report — overall risk**: High severity hits with no sanctions → verify `overallRisk: 'high'`
15. **Report — risk scoring**: Verify severity maps to correct risk score additions (15/8/3)
16. **News provider unavailable**: Provider returns `isAvailable: false` → verify step completes with warning
17. **LLM structured output**: Mock LLM returns evaluations → verify correct fragment creation
18. **LLM failure**: LLM throws → verify step retried via BaseAgent retry logic
19. **Prompt content**: Verify prompt includes subject metadata and all article details
20. **Entity screening**: Entity name searched → verify articles evaluated for entity context
21. **Integration**: Search for known adverse media subject, verify end-to-end fragment creation
