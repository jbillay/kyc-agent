# Research: YAML Configuration Loader

**Branch**: `010-yaml-config-loader` | **Date**: 2026-04-22

## Decision 1: Singleton Pattern

**Decision**: Module-level variable with a factory function (`getConfigService()`).

**Rationale**: Node.js `require()` caches module exports, so a module-level `let instance = null` combined with a factory function is the idiomatic singleton pattern. It is lightweight (no Proxy, no WeakRef), testable (tests can reset `instance` by reaching into module internals or using `jest.resetModules()`), and already used by the existing codebase (e.g., `document-service.js` exports a module-level object). The class constructor remains accessible for tests that need isolated instances.

**Alternatives considered**:
- Exported plain object: rejected — mutable, no lazy initialisation, harder to test lifecycle.
- Proxy-based singleton: rejected — unnecessary complexity for a single-process service.

---

## Decision 2: Pre-Load Property Access Guard

**Decision**: JavaScript property getters on the class instance that check an `_loaded` flag and throw if not set.

**Rationale**: Getters intercept property reads transparently without requiring callers to change access patterns. The error is thrown at the exact point of misuse, naming the property accessed. This is simpler than `Proxy` (no exotic object behaviour, no descriptor complexity) and more informative than returning `null` (which defers the failure to a null-dereference deep in business logic).

**Alternatives considered**:
- Return `null` silently: rejected — allows misconfigured startup to proceed until a cryptic null-dereference.
- `Proxy` trap on the instance: rejected — exotic objects complicate debugging and serialisation; overkill for four properties.
- Check in `load()` callers: rejected — pushes the guard responsibility to every dependent service.

**Implementation note**: Store raw values in private fields (`_llm`, `_riskRules`, etc.) and expose them via getters. Before `load()` sets `_loaded = true`, getters throw: `"ConfigService not loaded — call load() before accessing config.{property}"`.

---

## Decision 3: Hot-Reload Debounce

**Decision**: `setTimeout`/`clearTimeout` debounce on the class instance, 500 ms window.

**Rationale**: Text editors and file-copy tools emit multiple `fs.watch` events within milliseconds (truncate + write, or rename + write). Processing each event independently risks reading a partially-written file on the first event. A 500 ms debounce collapses the burst into one reload attempt against the fully-written file. No external library needed — `setTimeout`/`clearTimeout` is sufficient and already used throughout the codebase.

**Alternatives considered**:
- Process every event (no debounce): rejected — race condition with partial writes; multiple redundant reloads.
- Leading-edge suppress (ignore until current reload completes): rejected — second event could be dropped if file write takes < reload time; harder to test deterministically.
- `chokidar` library: rejected — adds a dependency for functionality achievable with 5 lines of stdlib code.

**Implementation note**: Store `this._debounceTimer = null` on the instance. On each `fs.watch` `'change'` event: `clearTimeout(this._debounceTimer); this._debounceTimer = setTimeout(() => this._reloadRiskRules(), 500)`. Clear timer in `close()`.

---

## Decision 4: Secret Redaction in Error Output

**Decision**: Error messages include field paths and failure reasons only — never resolved values. Environment variable interpolation errors include the variable name and source file — never the resolved value.

**Rationale**: Config-time errors occur precisely when secrets are in play (API key fails schema validation, env var is missing). Logging resolved values would expose secrets in application logs, monitoring systems, and crash reports. Joi's `details[].path` and `details[].message` fields provide field-level error detail without embedding raw values when validation uses `.label()` for field names.

**Implementation note**: When building the Joi error string, join `d.path.join('.')` and `d.message` — Joi's `message` field contains the rule description (e.g., `"must be a string"`) not the actual value. For env var interpolation errors: include `varName` and `filename`, never `process.env[varName]`.

---

## Decision 5: `config/llm.yaml` Top-Level Key Update

**Decision**: Update `config/llm.yaml` to wrap all content under a top-level `llm:` key, matching the Joi schema in the spec.

**Rationale**: The current `config/llm.yaml` has `default_provider`, `providers`, `routing`, and `logging` at the root level. The spec's Joi schema (`llmSchema`) requires a top-level `llm:` wrapper: `{ llm: { default_provider, providers, routing, logging } }`. This provides namespace consistency with the other config files (`risk_rules:`, `data_sources:`, `screening_sources:`).

**Impact**: `LLMService` currently receives a flat config object directly from callers (e.g., a `require('./config')` or passed via constructor). After this change, integrating callers will pass `configService.llm.llm` to `LLMService`. This integration is a follow-on concern for the startup wiring; the `LLMService` constructor signature itself does not need to change.

**Note**: The `llm.yaml` update is part of this feature's deliverables. The startup wiring change (`index.js` and `agent-worker.js`) is deferred to a follow-on integration task.

---

## Decision 6: Config File Schema Notes

**`config/llm.yaml`**: Requires `llm.default_provider` and `llm.providers` (at minimum). `llm.routing` and `llm.logging` are validated but have defaults. The `max_concurrent` and `availability_timeout_ms` fields present in the current `config/llm.yaml` are provider-level extras — the Joi schema uses `allowUnknown: true` so they pass through without error.

**`config/risk-rules.yaml`**: Requires `risk_rules.version`, `risk_rules.country_risk`, `risk_rules.industry_risk`, `risk_rules.ownership_risk`, `risk_rules.screening_risk`, `risk_rules.thresholds`, `risk_rules.review_routing`.

**`config/data-sources.yaml`**: Requires `data_sources` object. Minimal default (empty registries block, no env var references) so the platform starts without external API keys.

**`config/screening-sources.yaml`**: Requires `screening_sources` object. Default includes OFAC and UK HMT source definitions — no API keys needed (public URLs).
