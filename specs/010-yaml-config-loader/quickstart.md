# Quickstart: YAML Configuration Loader

**Branch**: `010-yaml-config-loader` | **Date**: 2026-04-22

## What Is Being Built

A singleton configuration service (`backend/src/services/config-service.js`) that loads, validates, and exposes four YAML config files at application startup. It also hot-reloads `risk-rules.yaml` without a process restart.

---

## Files Changed / Created

| File | Action | Notes |
|------|--------|-------|
| `backend/src/services/config-service.js` | **Create** | The ConfigService class + Joi schemas + singleton factory |
| `config/llm.yaml` | **Update** | Wrap all content under top-level `llm:` key |
| `config/risk-rules.yaml` | **Create** | Default risk rules (country/industry/ownership/screening/thresholds/routing) |
| `config/data-sources.yaml` | **Create** | Default data sources (minimal, no required env vars) |
| `config/screening-sources.yaml` | **Create** | Default screening sources (OFAC SDN + UK HMT) |
| `tests/backend/services/config-service.test.js` | **Create** | Unit + integration tests (9 scenarios) |

---

## Running the Tests

```bash
cd backend
npx jest ../tests/backend/services/config-service.test.js
```

All tests are self-contained — they create temp directories with test YAML files and do not touch the real `config/` directory.

---

## Verifying the Integration

After implementing, verify the service boots correctly:

```bash
cd backend
node -e "
  const { getConfigService } = require('./src/services/config-service');
  const c = getConfigService();
  c.load();
  console.log('default_provider:', c.llm.llm.default_provider);
  console.log('risk rules version:', c.riskRules.risk_rules.version);
  console.log('OK');
"
```

Expected output:
```
default_provider: ollama
risk rules version: 1.0
OK
```

---

## Pre-Load Guard Verification

```bash
node -e "
  const { getConfigService } = require('./src/services/config-service');
  const c = getConfigService();
  try { c.llm; } catch (e) { console.log('Guard works:', e.message); }
"
```

Expected: `Guard works: ConfigService not loaded — call load() before accessing config.llm`

---

## Hot-Reload Verification

```bash
node -e "
  const { getConfigService } = require('./src/services/config-service');
  const c = getConfigService();
  c.load();
  c.onRiskRulesChange((rules) => {
    console.log('Reloaded — version:', rules.risk_rules.version);
    c.close();
    process.exit(0);
  });
  c.watchRiskRules();

  // Simulate a change after 1 second
  setTimeout(() => {
    const fs = require('fs');
    const content = fs.readFileSync('config/risk-rules.yaml', 'utf8');
    fs.writeFileSync('config/risk-rules.yaml', content);
    console.log('File touched — waiting for reload...');
  }, 1000);
"
```

Expected: prints `Reloaded — version: 1.0` within ~2 seconds of the file touch.

---

## Key Design Decisions

| Decision | Choice | See |
|----------|--------|-----|
| Singleton pattern | Module-level `let instance` + factory | `research.md` §1 |
| Pre-load guard | Property getters with `_loaded` flag | `research.md` §2 |
| Hot-reload debounce | 500 ms `setTimeout`/`clearTimeout` | `research.md` §3 |
| Secret redaction | Field paths only in errors, never values | `research.md` §4 |
| `llm.yaml` restructure | Wrap in `llm:` top-level key | `research.md` §5 |
