# Research: UK Corporate Registry Data Source (012)

## Decision 1: HTTP Client

**Decision**: Use Node.js native `fetch` with `AbortController` for per-request timeout

**Rationale**: Native `fetch` is stable in Node 22 (required by this project). The existing Ollama LLM provider already uses `fetch` — consistent with project patterns. No new npm dependency needed.

**Alternatives considered**:
- `axios` / `got`: unnecessary dependency for this use case
- `node-fetch`: superseded by native fetch in Node 18+

---

## Decision 2: Token-Bucket Rate Limiter

**Decision**: Pure in-memory token bucket with lazy refill on each `_acquireToken()` call. Queue wait cap of 30 seconds enforced via `Promise.race()` between the proportional wait and a 30-second rejection timer.

**Rationale**: Sufficient for a single deployment instance (Docker Compose). No external state or dependencies. Bucket starts full (600 tokens), refills at 2 tokens/second (= 120/min = 600/5min). Each HTTP request consumes 1 token. If the bucket is empty, the call waits proportionally; if the wait would exceed 30 seconds, a `RATE_LIMITED` error is thrown immediately without queuing.

**Alternatives considered**:
- Redis-backed distributed rate limiter (Bottleneck, rate-limiter-flexible): over-engineered for a single-instance deployment; adds a Redis dependency to Layer 2
- Fixed-window counter: allows burst at window boundaries; token bucket is smoother

---

## Decision 3: Officer Pagination

**Decision**: Paginate using the Companies House API's `start_index` and `items_per_page` query parameters. Use pages of 50 items. Stop when `start_index + page.items.length >= total_results` (or when an empty page is returned).

**Rationale**: The spec requires full officer list regardless of count (FR-003, clarification 2026-04-26). The CH API's default page size is 35; 50 minimises round trips. Each page consumes one rate-limit token.

**CH API pagination reference**:
```
GET /company/{number}/officers?items_per_page=50&start_index=0
Response: { total_results: N, items: [...], items_per_page: 50, start_index: 0 }
```

**Alternatives considered**:
- Single page only: rejected — spec explicitly requires full pagination for PEP screening completeness
- Max page size of 100: CH API does not reliably support >50 items per page

---

## Decision 4: Exponential Backoff for Transient Retries

**Decision**: `delayMs = 200 * 2^(attempt - 1)`. Three attempts produce waits of 200 ms, 400 ms, 800 ms (total: 1,400 ms). No jitter.

**Rationale**: Absorbs brief registry outages within 1.4 seconds total. Well within the 30-second queue wait cap. Single-instance deployment means no thundering-herd concern — jitter is unnecessary complexity.

**Retry conditions** (FR-013): 5xx HTTP responses, connection errors, `fetch` network failures. 404 and 429 are NOT retried.

**Alternatives considered**:
- Full jitter: unnecessary for single-instance deployment
- Fixed 1-second delay × 3: less effective at absorbing brief outages; longer total wait

---

## Decision 5: API Key Configuration

**Decision**: Uncomment and complete the `companies_house` block in `config/data-sources.yaml`. Add `timeout_ms`, `max_queue_wait_ms`, and `retry_attempts` fields alongside the existing `api_key`, `base_url`, `rate_limit`, and `cache_ttl_hours` fields.

**Rationale**: The commented-out stub already exists with the correct structure. Adding the three new fields brings the config in line with the clarified requirements (10s timeout, 30s queue cap, 3 retries) and satisfies Constitution Principle V.

**No hardcoded values**: The provider reads all parameters from the config object passed to its constructor; the config loader resolves environment variable references.
