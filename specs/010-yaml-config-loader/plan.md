# Implementation Plan: YAML Configuration Loader

**Branch**: `010-yaml-config-loader` | **Date**: 2026-04-22 | **Spec**: [spec.md](spec.md)  
**Input**: Feature specification from `/specs/010-yaml-config-loader/spec.md`

## Summary

Build a singleton `ConfigService` that loads, validates (via Joi schemas), and exposes four YAML configuration files at application startup. Support `${VAR_NAME}` environment variable interpolation with explicit errors for missing variables. Implement `fs.watch`-based hot-reload for `risk-rules.yaml` with a 500 ms debounce, listener callbacks, and safe fallback to the last valid config on invalid reload. Update `config/llm.yaml` to use the required top-level `llm:` wrapper and create default files for the three missing config domains.

---

## Technical Context

**Language/Version**: Node.js ≥22, JavaScript (CommonJS, `'use strict'`)  
**Primary Dependencies**: `joi` ^17 (already in `package.json`), `js-yaml` ^4 (already in `package.json`), Node.js built-ins (`fs`, `path`)  
**Storage**: No database changes — all state is in-memory within the singleton  
**Testing**: Jest ^29 — tests in `tests/backend/services/config-service.test.js`  
**Target Platform**: Linux server (Docker); same Node.js 22+ process as the rest of the backend  
**Project Type**: Backend internal service module (Layer 4 — Core Services)  
**Performance Goals**: Config load completes in < 100 ms (SC-001); hot-reload notifies listeners in < 2 s (SC-003)  
**Constraints**: No new npm dependencies; Node.js stdlib `fs.watch` only; no database writes  
**Scale/Scope**: Four config files, single process, one watcher

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I — Auditability First | ✅ Pass | ConfigService reads local files; no agent decisions, no `decision_events` interaction |
| II — LLM-Agnostic Interface | ✅ Pass | ConfigService makes no LLM calls |
| III — Layered Architecture | ✅ Pass | Layer 4 (Core Services). Only deps: Node built-ins + `joi`/`js-yaml`. No upward dependencies. |
| IV — Data Sovereignty | ✅ Pass | All config read from local disk. No external calls. |
| V — Configuration-Driven | ✅ Pass | This feature *implements* Constitution V — it is the config loader. |

**Post-Phase 1 re-check**: No design decisions introduced any layer violations. The ConfigService getter pattern and debounce implementation use only stdlib — no new dependencies. **All gates remain green.**

---

## Project Structure

### Documentation (this feature)

```text
specs/010-yaml-config-loader/
├── plan.md                              # This file
├── research.md                          # Phase 0 — decisions on singleton, guard, debounce, redaction
├── data-model.md                        # Phase 1 — in-memory shapes and lifecycle
├── quickstart.md                        # Phase 1 — how to run and verify
├── contracts/
│   └── config-service-interface.md      # Phase 1 — public API contract
└── tasks.md                             # Phase 2 output (/speckit.tasks — not yet created)
```

### Source Code (repository root)

```text
backend/
└── src/
    └── services/
        └── config-service.js            # NEW — ConfigService class + Joi schemas + singleton

config/
├── llm.yaml                             # UPDATE — wrap in top-level `llm:` key
├── risk-rules.yaml                      # NEW — default risk rules
├── data-sources.yaml                    # NEW — default data sources (no required env vars)
└── screening-sources.yaml               # NEW — default screening sources (OFAC SDN + UK HMT)

tests/
└── backend/
    └── services/
        └── config-service.test.js       # NEW — 9 test scenarios
```

**Structure decision**: Single project (Option 1 variant). All new source code is in the existing `backend/src/services/` directory; tests follow the established `tests/backend/` pattern.

---

## Complexity Tracking

> No constitution violations — this section is not required.

---

## Implementation Tasks (ordered)

### Task 1 — Create default config files

Create the three missing config files. Update `config/llm.yaml` with the top-level `llm:` wrapper.

**Deliverables**:
- `config/llm.yaml` — wrapped under `llm:`, existing content preserved
- `config/risk-rules.yaml` — default content per spec (country/industry/ownership/screening/thresholds/routing)
- `config/data-sources.yaml` — minimal default (no required env vars; uses `${COMPANIES_HOUSE_API_KEY}` as optional)
- `config/screening-sources.yaml` — OFAC SDN + UK HMT sources

**Acceptance**: Running `node -e "require('js-yaml').load(require('fs').readFileSync('config/llm.yaml','utf8'))"` exits 0 for each file.

---

### Task 2 — Implement ConfigService

Create `backend/src/services/config-service.js`.

**Subtasks**:

1. **Class skeleton** — constructor with all private fields (`_llm`, `_riskRules`, `_dataSources`, `_screeningSources`, `_loaded`, `configDir`, `_riskRulesWatcher`, `_riskRulesListeners`, `_debounceTimer`)

2. **Property getters** — `llm`, `riskRules`, `dataSources`, `screeningSources` — each throws if `_loaded === false`:
   ```
   ConfigService not loaded — call load() before accessing config.{propertyName}
   ```

3. **`_interpolateEnvVars(content, filename)`** — regex replace `${VAR_NAME}`, throw on undefined vars. Error message includes `varName` and `filename`, never the resolved value.

4. **`_loadAndValidate(filename, schema)`** — read file, interpolate, `yaml.load()`, Joi validate with `{ abortEarly: false, allowUnknown: true }`. Format multi-line error from `details[].path` and `details[].message` only.

5. **`load()`** — call `_loadAndValidate` for all four files; set `_loaded = true` on success.

6. **`_reloadRiskRules()`** — private method called by debounce timer; loads `risk-rules.yaml`, replaces `_riskRules`, notifies listeners, or logs error on failure.

7. **`watchRiskRules()`** — `fs.watch` with debounce: `clearTimeout(this._debounceTimer); this._debounceTimer = setTimeout(() => this._reloadRiskRules(), 500)` on `'change'` events.

8. **`onRiskRulesChange(listener)`** — adds to `_riskRulesListeners` Set.

9. **`close()`** — closes watcher, clears debounce timer, clears listener set.

10. **Joi schemas** — `llmSchema`, `riskRulesSchema`, `dataSourcesSchema`, `screeningSourcesSchema` as defined in the spec (see `contracts/config-service-interface.md` for field constraints).

11. **Singleton factory** — `let instance = null; function getConfigService() { if (!instance) instance = new ConfigService(); return instance; }`

12. **Module export** — `module.exports = { ConfigService, getConfigService };`

---

### Task 3 — Write tests

Create `tests/backend/services/config-service.test.js`.

Each test creates isolated temp directories with YAML files; none modify `config/`.

**Test scenarios** (from spec + clarifications):

| # | Scenario | What it verifies |
|---|----------|-----------------|
| 1 | Load valid config | All four properties populated; `_loaded = true` |
| 2 | Missing file | Throws with file path in message |
| 3 | Env var interpolation | `${VAR}` replaced with env value |
| 4 | Missing env var | Throws naming variable and file; no value in error |
| 5 | Joi validation failure | Throws multi-line error with all invalid fields; no values in error |
| 6 | Pre-load guard | Accessing `config.llm` before `load()` throws correct message |
| 7 | Singleton | Two `getConfigService()` calls return `===` same instance |
| 8 | Hot-reload (valid) | Listener fires with new rules after file write + 500 ms+ |
| 9 | Hot-reload (invalid) | Error logged; listener does not fire; previous rules retained |

**Cleanup**: Each test that creates a watcher calls `configService.close()` in `afterEach`.

---

### Task 4 — Update agent context

Run the agent context update script to register the new service in the Claude agent file.

```bash
powershell.exe -File ".specify/scripts/powershell/update-agent-context.ps1" -AgentType claude
```

---

## Integration Notes (out of scope for this feature)

The following integration steps are **not** part of this feature's tasks but are required before `ConfigService` is wired into the running application:

1. **`backend/src/index.js`**: Call `getConfigService().load()` at startup; pass `config.llm.llm` to `LLMService` constructor instead of the current raw config object.
2. **`backend/src/workers/agent-worker.js`**: Same config wiring.
3. **`backend/src/services/rule-engine.js`**: Receive `config.riskRules.risk_rules` from ConfigService; register `onRiskRulesChange` listener.

These are tracked as follow-on work for the startup wiring story.
