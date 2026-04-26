# Tasks: YAML Configuration Loader

**Input**: Design documents from `/specs/010-yaml-config-loader/`  
**Prerequisites**: plan.md ✅ | spec.md ✅ | research.md ✅ | data-model.md ✅ | contracts/ ✅

**Tests**: Included — the spec defines 9 explicit test scenarios (see plan.md §Task 3).

**Organization**: Tasks grouped by user story (US1 → US2 → US3). Each story is independently deliverable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files or independent sections within the same file)
- **[Story]**: User story this task belongs to
- Tests go in `tests/backend/services/config-service.test.js`
- Implementation goes in `backend/src/services/config-service.js` unless noted

---

## Phase 1: Setup (Default Config Files)

**Purpose**: Create the three missing config files and update `llm.yaml` to use the required top-level `llm:` wrapper. These files must exist before any test or code can reference them.

- [x] T001 Update `config/llm.yaml` — wrap all existing content under a top-level `llm:` key (add `llm:` and indent existing keys: `default_provider`, `providers`, `routing`, `logging`)
- [x] T00X [P] Create `config/risk-rules.yaml` with default risk rules per spec: `risk_rules.version: "1.0"`, country risk (high: AF/IR/KP/SY/YE/MM/LY/SO/SS +30, medium: RU/BY/VE/NI/ZW/CU/PK +15), industry risk (high: crypto/gambling keywords +25, medium: precious-metals/real-estate keywords +10), ownership risk (layers_threshold: 3, score_per_extra_layer: 5, cross_border: 10, opaque_jurisdiction: 20, nominee: 15, no_ubo: 25), screening risk (confirmed_sanctions: 100, pep: 20, adverse_media per severity), thresholds (low 0-25, medium 26-50, high 51-75, very_high 76-100), review_routing (low_risk_high_confidence, standard, high_risk routes)
- [x] T00X [P] Create `config/data-sources.yaml` with minimal default content: `data_sources:` key with a `registries:` block containing a commented-out `companies_house` entry that references `${COMPANIES_HOUSE_API_KEY}` — the active default MUST NOT reference any env var so the platform starts without external keys
- [x] T00X [P] Create `config/screening-sources.yaml` with two default sources under `screening_sources:`: `ofac_sdn` (type: sanctions, source_url for OFAC SDN XML, format: xml, sync_schedule: "0 2 * * *") and `uk_hmt` (type: sanctions, source_url for UK HMT CSV, format: csv, sync_schedule: "0 3 * * *")

**Checkpoint**: All four config files exist. Verify with: `node -e "['llm','risk-rules','data-sources','screening-sources'].forEach(f => require('js-yaml').load(require('fs').readFileSync('config/'+f+'.yaml','utf8')))" ` (no errors expected).

---

## Phase 2: Foundational (Core Service Infrastructure)

**Purpose**: Service skeleton, Joi schemas, and the two private helpers (`_interpolateEnvVars`, `_loadAndValidate`) that all three user stories depend on. No user story tasks can begin until this phase is complete.

**⚠️ CRITICAL**: Do not begin Phase 3–5 until all Phase 2 tasks are done.

- [x] T00X Create `backend/src/services/config-service.js` with: `'use strict';` header, `require` statements for `fs`, `path`, `js-yaml`, `joi`; empty `ConfigService` class with constructor that initialises `_llm = null`, `_riskRules = null`, `_dataSources = null`, `_screeningSources = null`, `_loaded = false`, `configDir = process.env.CONFIG_DIR || path.join(process.cwd(), 'config')`, `_riskRulesWatcher = null`, `_riskRulesListeners = new Set()`, `_debounceTimer = null`; and `module.exports = { ConfigService, getConfigService };`
- [x] T00X [P] Implement `llmSchema` Joi schema in `backend/src/services/config-service.js`: top-level `llm` object requiring `default_provider` (string), `providers` (object pattern: optional `base_url` uri, `api_key` string allow(''), `timeout_ms` integer 1000–600000, `retry.max_attempts` 1–10, `retry.backoff_ms` 100–30000), `routing` (object pattern: required `reasoning`, `extraction`, `screening`, `classification`, `summarization` strings), `logging` object with `redact_prompts` and `redact_responses` booleans defaulting to false
- [x] T00X [P] Implement `riskRulesSchema` Joi schema in `backend/src/services/config-service.js`: top-level `risk_rules` object requiring `version` (string), `country_risk` with `high_risk` and `medium_risk` each having `countries` (array of 2-char strings) and `score_addition` (integer 0–100), `industry_risk` (object required), `ownership_risk` (object required), `screening_risk` (object required), `thresholds` with `low`/`medium`/`high`/`very_high` each having `min` and `max` numbers, `review_routing` (object required)
- [x] T00X [P] Implement `dataSourcesSchema` (`data_sources` object required) and `screeningSourcesSchema` (`screening_sources` object required) Joi schemas in `backend/src/services/config-service.js` — both intentionally loose to allow downstream layers to define their own sub-schemas
- [x] T00X Implement `_interpolateEnvVars(content, filename)` in `backend/src/services/config-service.js`: regex `content.replace(/\$\{([^}]+)\}/g, ...)` — for each match, read `process.env[varName.trim()]`; if undefined throw `Error("Environment variable '${varName}' referenced in ${filename} is not defined. Set it in your .env file or environment.")` — error MUST include `varName` and `filename` but MUST NOT include any resolved value
- [x] T0XX Implement `_loadAndValidate(filename, schema)` in `backend/src/services/config-service.js` (depends on T005, T009): check file exists (`fs.existsSync`) else throw with full file path; `fs.readFileSync(filePath, 'utf8')`; call `_interpolateEnvVars(raw, filename)`; `yaml.load(raw)`; `schema.validate(parsed, { abortEarly: false, allowUnknown: true, stripUnknown: false })`; on error throw `"Invalid configuration in ${filename}:\n" + details.map(d => "  - " + d.path.join('.') + ": " + d.message).join('\n')` — use `d.path` and `d.message` ONLY, never `d.context.value`; return `value`
- [x] T0XX Implement `getConfigService()` singleton factory in `backend/src/services/config-service.js`: `let instance = null;` module-level variable; `function getConfigService() { if (!instance) instance = new ConfigService(); return instance; }` — exported via `module.exports`

**Checkpoint**: Foundation ready. `require('./src/services/config-service')` should load without errors.

---

## Phase 3: User Story 1 — Application Loads All Configuration at Startup (Priority: P1) 🎯 MVP

**Goal**: Calling `load()` on a ConfigService instance populates all four config domain properties from disk; accessing those properties before `load()` is called throws a clear error; `getConfigService()` returns the same instance on every call.

**Independent Test**: `node -e "const {getConfigService}=require('./src/services/config-service'); const c=getConfigService(); c.load(); console.log(c.llm.llm.default_provider);"` prints `ollama`.

### Tests for User Story 1

- [x] T0XX [P] [US1] Write test scenario 1 in `tests/backend/services/config-service.test.js`: create temp dir with valid YAML for all four files; call `load()`; assert all four properties (`llm`, `riskRules`, `dataSources`, `screeningSources`) are non-null objects with expected top-level keys
- [x] T0XX [P] [US1] Write test scenario 2 in `tests/backend/services/config-service.test.js`: create temp dir missing one config file; assert `load()` throws with the file path in the error message
- [x] T0XX [P] [US1] Write test scenario 5 in `tests/backend/services/config-service.test.js`: create a `llm.yaml` with a type violation (e.g., `timeout_ms: "not-a-number"`); assert `load()` throws an error whose message contains all invalid field paths and DOES NOT contain the literal value `"not-a-number"`
- [x] T0XX [P] [US1] Write test scenario 6 in `tests/backend/services/config-service.test.js`: create a fresh `ConfigService` instance without calling `load()`; assert accessing `config.llm` throws with message matching `"ConfigService not loaded — call load() before accessing config.llm"`
- [x] T0XX [P] [US1] Write test scenario 7 in `tests/backend/services/config-service.test.js`: call `getConfigService()` twice; assert the two return values are `===` (same reference); reset module singleton between test files using `jest.resetModules()` in `afterEach`

### Implementation for User Story 1

- [x] T0XX [US1] Implement `load()` method in `backend/src/services/config-service.js` (depends on T010, T011): call `_loadAndValidate` for all four files with their respective schemas; assign results to `_llm`, `_riskRules`, `_dataSources`, `_screeningSources`; set `_loaded = true` — all four calls must succeed before setting `_loaded`
- [x] T0XX [US1] Implement property getters `llm`, `riskRules`, `dataSources`, `screeningSources` in `backend/src/services/config-service.js` (depends on T005): each getter checks `if (!this._loaded) throw new Error("ConfigService not loaded — call load() before accessing config.{propertyName}")` then returns the corresponding private field (`_llm`, `_riskRules`, etc.)

**Checkpoint**: Run `npx jest ../tests/backend/services/config-service.test.js -t "User Story 1"` — all 5 US1 tests must pass.

---

## Phase 4: User Story 2 — Secrets Kept Out of Config Files via Environment Variables (Priority: P2)

**Goal**: `${VAR_NAME}` references in YAML config values are replaced with the corresponding environment variable at load time. Undefined variable references throw errors that name the variable and file but never reveal resolved values.

**Independent Test**: `VAR=secret123 node -e "process.env.VAR='secret123'; const {ConfigService}=require('./src/services/config-service'); const c=new ConfigService(); c._configDir='/tmp/test'; /* write test yaml */ c.load(); console.log('ok');"` — verifies substitution works end-to-end.

### Tests for User Story 2

- [x] T0XX [P] [US2] Write test scenario 3 in `tests/backend/services/config-service.test.js`: create a `llm.yaml` where `api_key` contains `"${TEST_API_KEY}"`; set `process.env.TEST_API_KEY = 'test-secret-value'`; call `load()`; assert the loaded config contains `'test-secret-value'` (not the placeholder string); clean up env var in `afterEach`
- [x] T0XX [P] [US2] Write test scenario 4 in `tests/backend/services/config-service.test.js`: create a `llm.yaml` referencing `"${UNDEFINED_VAR_XYZ}"`; ensure env var is not set; assert `load()` throws an error whose message contains `'UNDEFINED_VAR_XYZ'` and the filename, and does NOT contain any resolved value (assert error message does not match `/secret|key|value|=/i` beyond the variable name itself)

### Implementation for User Story 2

- [x] T0XX [US2] Review `_interpolateEnvVars` in `backend/src/services/config-service.js` and confirm it handles multiple occurrences of the same `${VAR_NAME}` in a single file independently (each occurrence must be replaced via the regex replace callback — verify the replace is global, not just first-match)
- [x] T0XX [US2] Review `_loadAndValidate` error formatting in `backend/src/services/config-service.js` and confirm the Joi error string uses only `d.path.join('.')` and `d.message` — not `d.context.value` or `d.context.label` with raw values — add a code comment `// d.context.value intentionally excluded — secret redaction (FR-014)` above the `map` call

**Checkpoint**: Run `npx jest ../tests/backend/services/config-service.test.js -t "User Story 2"` — both US2 tests must pass.

---

## Phase 5: User Story 3 — Risk Rules Updated Without Restart (Priority: P3)

**Goal**: `watchRiskRules()` detects changes to `risk-rules.yaml` on disk, debounces burst events within 500 ms, reloads and re-validates, and invokes registered listeners on success. Invalid changes are logged and the previous valid config is retained unchanged.

**Independent Test**: Register a listener, write a new `risk-rules.yaml`, and verify the listener fires with the updated rules within 2 seconds. Write an invalid file and verify the listener does not fire.

### Tests for User Story 3

- [x] T0XX [P] [US3] Write test scenario 8 in `tests/backend/services/config-service.test.js`: load valid config from temp dir; register a listener via `onRiskRulesChange`; call `watchRiskRules()`; overwrite `risk-rules.yaml` with new valid content (change `version` to `"2.0"`); assert listener fires within 2 seconds with `risk_rules.version === "2.0"`; call `close()` in `afterEach`
- [x] T0XX [P] [US3] Write test scenario 9 in `tests/backend/services/config-service.test.js`: load valid config; register a listener; call `watchRiskRules()`; overwrite `risk-rules.yaml` with invalid YAML (e.g., `risk_rules: "not-an-object"`); assert listener does NOT fire within 2 seconds; assert `config.riskRules.risk_rules.version` still equals the original value; call `close()` in `afterEach`

### Implementation for User Story 3

- [x] T0XX [US3] Implement `_reloadRiskRules()` private method in `backend/src/services/config-service.js`: call `this._loadAndValidate('risk-rules.yaml', riskRulesSchema)`; on success assign result to `this._riskRules`, log reload success message, iterate `this._riskRulesListeners` and call each listener with `this._riskRules`; on error log `"Failed to reload risk rules: " + err.message` and retain previous `_riskRules` — do NOT rethrow
- [x] T0XX [US3] Implement `watchRiskRules()` in `backend/src/services/config-service.js` (depends on T025): `const filePath = path.join(this.configDir, 'risk-rules.yaml')`; `this._riskRulesWatcher = fs.watch(filePath, (eventType) => { if (eventType === 'change') { clearTimeout(this._debounceTimer); this._debounceTimer = setTimeout(() => this._reloadRiskRules(), 500); } })`
- [x] T0XX [US3] Implement `onRiskRulesChange(listener)` in `backend/src/services/config-service.js`: `this._riskRulesListeners.add(listener)` — Set semantics handle duplicate registration silently
- [x] T0XX [US3] Implement `close()` in `backend/src/services/config-service.js`: `if (this._riskRulesWatcher) { this._riskRulesWatcher.close(); this._riskRulesWatcher = null; }` then `clearTimeout(this._debounceTimer); this._debounceTimer = null;` then `this._riskRulesListeners.clear()`

**Checkpoint**: Run `npx jest ../tests/backend/services/config-service.test.js -t "User Story 3"` — both US3 tests must pass.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Full test suite validation and quickstart verification.

- [x] T0XX Run full test suite for this feature: `cd backend && npx jest ../tests/backend/services/config-service.test.js` — all 9 tests must pass with no skipped or pending tests
- [x] T0XX [P] Run quickstart.md pre-load guard verification: `cd backend && node -e "const {getConfigService}=require('./src/services/config-service'); const c=getConfigService(); try { c.llm; } catch(e) { console.log('Guard works:', e.message); }"` — verify output matches expected message
- [x] T0XX [P] Run quickstart.md startup verification: `cd backend && node -e "const {getConfigService}=require('./src/services/config-service'); const c=getConfigService(); c.load(); console.log('default_provider:', c.llm.llm.default_provider); console.log('risk rules version:', c.riskRules.risk_rules.version); console.log('OK');"` — verify prints `default_provider: ollama` and `risk rules version: 1.0`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1 (Setup)**: No dependencies — can start immediately; T002/T003/T004 can run in parallel with T001
- **Phase 2 (Foundational)**: Depends on Phase 1 (config files must exist for integration tests) — T006/T007/T008 can run in parallel with T005; T009 depends on T005; T010 depends on T005 and T009; T011 depends on T005
- **Phase 3 (US1)**: Depends on Phase 2 completion — T012–T016 (tests) can run in parallel; T018 can run in parallel with T017; T017 depends on T010
- **Phase 4 (US2)**: Depends on Phase 2 completion — T019/T020 (tests) run in parallel; T021/T022 run in parallel
- **Phase 5 (US3)**: Depends on Phase 3 completion (US3 requires `load()` from US1) — T023/T024 (tests) run in parallel; T025 first, then T026/T027/T028 can run in parallel
- **Phase 6 (Polish)**: Depends on all prior phases — T030/T031 can run in parallel with each other

### User Story Dependencies

- **US1 (P1)**: Depends on Foundational (Phase 2) only
- **US2 (P2)**: Depends on Foundational (Phase 2) only — `_interpolateEnvVars` is already implemented in Phase 2
- **US3 (P3)**: Depends on US1 (Phase 3) — `watchRiskRules()` requires `load()` to have been called first

### Parallel Opportunities

- **Phase 1**: T002 + T003 + T004 in parallel (different files)
- **Phase 2**: T006 + T007 + T008 in parallel (separate schema constants in same file — implement as separate code blocks)
- **Phase 3**: All 5 test tasks (T012–T016) in parallel; T017 + T018 in parallel
- **Phase 4**: T019 + T020 in parallel; T021 + T022 in parallel
- **Phase 5**: T023 + T024 in parallel; T026 + T027 + T028 in parallel (after T025)
- **Phase 6**: T030 + T031 in parallel

---

## Parallel Example: User Story 1

```text
# All test stubs can be written simultaneously (different describe blocks):
Task T012: "Load valid config — all four properties populated"
Task T013: "Missing file — error names the file"
Task T014: "Joi validation failure — multi-line error, no raw values"
Task T015: "Pre-load guard — accessing llm before load() throws"
Task T016: "Singleton — two getConfigService() calls return === same instance"

# Then implement in parallel:
Task T017: load() method
Task T018: property getters with pre-load guard
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (config files)
2. Complete Phase 2: Foundational (service skeleton + schemas + helpers)
3. Complete Phase 3: User Story 1 (load + getters + guard + singleton)
4. **STOP and VALIDATE**: Run T029 tests subset; run T031 quickstart check
5. ConfigService is usable for startup wiring — platform can boot with config

### Incremental Delivery

1. Phase 1 + Phase 2 → Core infrastructure
2. + Phase 3 (US1) → Startup config loading works; platform bootable (**MVP**)
3. + Phase 4 (US2) → Secrets can be managed via env vars; staging/prod config differentiation works
4. + Phase 5 (US3) → Risk rules hot-reloadable; no downtime for rule changes
5. + Phase 6 → All tests green, quickstart verified

### Single-Developer Strategy

Work through phases sequentially:
1. Create all four config files (Phase 1 — ~20 min)
2. Build the service skeleton and helpers (Phase 2 — ~45 min)
3. Add `load()` + getters + tests (Phase 3 — ~30 min) → **stop and verify**
4. Add env var interpolation tests + secret redaction review (Phase 4 — ~20 min)
5. Add hot-reload + tests (Phase 5 — ~40 min)
6. Full validation pass (Phase 6 — ~10 min)

---

## Notes

- `[P]` tasks involve different files or separate non-conflicting sections — safe to parallelize
- Test tasks (T012–T016, T019–T020, T023–T024) should be written to FAIL before Phase 3–5 implementation
- Use `jest.resetModules()` in `afterEach` to reset the module-level singleton between tests
- Hot-reload tests (T023, T024) must use `fs.writeFileSync` with a small delay after `watchRiskRules()` to allow watcher registration; use `jest.setTimeout(5000)` for these tests
- Each phase is a commit-worthy checkpoint — commit after each phase completes
- The `configDir` override (`process.env.CONFIG_DIR`) makes all tests self-contained; no test should read from the real `config/` directory
