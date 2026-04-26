# Contract: ConfigService Public Interface

**Module**: `backend/src/services/config-service.js`  
**Export pattern**: CommonJS — `module.exports = { ConfigService, getConfigService }`

---

## Factory Function

### `getConfigService()`

Returns the singleton `ConfigService` instance. Creates it on first call.

```
getConfigService() → ConfigService
```

| | |
|-|-|
| **Returns** | The singleton `ConfigService` instance |
| **Side effects** | Creates instance on first call; subsequent calls return the same object |
| **Throws** | Never |

---

## Class: ConfigService

### Constructor

```
new ConfigService()
```

Initialises private fields. Does NOT load config files. Callers MUST call `load()` before accessing config properties.

---

### Methods

#### `load()`

Load all four config files synchronously. Validates each against its schema. Populates `llm`, `riskRules`, `dataSources`, `screeningSources`. Sets `_loaded = true`.

```
load() → void
```

| | |
|-|-|
| **Throws** | `Error` — if any config file is missing, unreadable, unparseable, or fails schema validation |
| **Error format** | `"Configuration file not found: {filePath}"` |
| **Error format** | `"Environment variable '{varName}' referenced in {filename} is not defined. Set it in your .env file or environment."` |
| **Error format** | `"Invalid configuration in {filename}:\n  - {field}: {reason}\n  - {field}: {reason}"` |
| **Secret safety** | Error messages MUST NOT include resolved config values |
| **Idempotency** | Calling `load()` on an already-loaded service reloads all files and replaces in-memory values |

---

#### `watchRiskRules()`

Start an `fs.watch` watcher on `risk-rules.yaml`. Debounces change events within a 500 ms window. After debounce, reloads and re-validates the file. On success, replaces `riskRules` and notifies listeners. On failure, logs the error and retains the previous valid config.

```
watchRiskRules() → void
```

| | |
|-|-|
| **Requires** | `load()` MUST have been called first |
| **Side effects** | Starts OS file watcher; console output on reload success/failure |
| **Throws** | Never (errors are caught and logged internally) |

---

#### `onRiskRulesChange(listener)`

Register a callback to be invoked after each successful hot-reload of `risk-rules.yaml`.

```
onRiskRulesChange(listener: (riskRules: Object) => void) → void
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `listener` | `Function` | Called with the new `riskRules` object after each successful reload |

| | |
|-|-|
| **Side effects** | Adds `listener` to the internal `Set`; duplicate registrations are silently ignored (Set semantics) |

---

#### `close()`

Stop the file watcher (if active), clear the debounce timer, and remove all registered listeners. Safe to call in any lifecycle state.

```
close() → void
```

| | |
|-|-|
| **Side effects** | Closes `fs.FSWatcher`; clears `_riskRulesListeners` set; clears `_debounceTimer` |
| **Throws** | Never |

---

### Properties (Getters)

All four properties are guarded — accessing them before `load()` throws:

```
Error: ConfigService not loaded — call load() before accessing config.{propertyName}
```

#### `llm` → `Object`

The fully parsed and validated content of `config/llm.yaml`. Shape: `{ llm: { default_provider, providers, routing, logging } }`.

#### `riskRules` → `Object`

The fully parsed and validated content of `config/risk-rules.yaml`. Updated in-place on successful hot-reload. Shape: `{ risk_rules: { version, country_risk, industry_risk, ownership_risk, screening_risk, thresholds, review_routing } }`.

#### `dataSources` → `Object`

The fully parsed and validated content of `config/data-sources.yaml`. Shape: `{ data_sources: { ... } }`.

#### `screeningSources` → `Object`

The fully parsed and validated content of `config/screening-sources.yaml`. Shape: `{ screening_sources: { ... } }`.

---

## Usage Pattern (startup)

```javascript
const { getConfigService } = require('./services/config-service');

const config = getConfigService();
config.load();                     // throws on invalid config → halts startup
config.watchRiskRules();           // begin watching for risk rule changes

// Pass to dependent services:
const llmConfig = config.llm.llm; // flat LLM config for LLMService
const riskRulesConfig = config.riskRules.risk_rules;
```

## Usage Pattern (shutdown)

```javascript
process.on('SIGTERM', () => {
  getConfigService().close();
  // ... other cleanup
});
```
