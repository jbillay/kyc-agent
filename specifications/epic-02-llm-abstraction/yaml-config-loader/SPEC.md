# YAML Configuration Loader

> GitHub Issue: [#12](https://github.com/jbillay/kyc-agent/issues/12)
> Epic: LLM Abstraction Layer (#7)
> Size: S (less than 1 day) | Priority: High

## Context

The KYC Agent platform is configuration-driven — risk rules, LLM provider settings, data source connections, and screening list sources are all defined in YAML files. This allows clients to customize the platform to their regulatory requirements and infrastructure without changing code.

The config loader is a shared service used by multiple layers: the LLM abstraction layer reads `config/llm.yaml`, the rule engine reads `config/risk-rules.yaml`, data sources read `config/data-sources.yaml`, and the screening sync worker reads `config/screening-sources.yaml`.

## Requirements

### Functional

1. Load and parse YAML files: `llm.yaml`, `risk-rules.yaml`, `data-sources.yaml`, `screening-sources.yaml`
2. Interpolate environment variables in YAML values (e.g., `${ANTHROPIC_API_KEY}`)
3. Validate each config file against a Joi schema with meaningful error messages
4. Expose configuration via a singleton service
5. Hot-reload risk rules without restarting the application
6. Ship default configuration files in the repository

### Non-Functional

- Configuration loads in under 100ms
- Invalid config fails fast at startup with clear error messages
- Environment variable references that are undefined throw explicit errors (not silent empty strings)

## Technical Design

### File: `backend/src/services/config-service.js`

```javascript
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Joi = require('joi');

/**
 * Configuration service — singleton that loads and validates YAML config files.
 */
class ConfigService {
  constructor() {
    /** @type {Object} */
    this.llm = null;
    /** @type {Object} */
    this.riskRules = null;
    /** @type {Object} */
    this.dataSources = null;
    /** @type {Object} */
    this.screeningSources = null;

    /** @type {string} */
    this.configDir = process.env.CONFIG_DIR || path.join(process.cwd(), 'config');

    /** @type {fs.FSWatcher|null} */
    this._riskRulesWatcher = null;

    /** @type {Set<Function>} */
    this._riskRulesListeners = new Set();
  }

  /**
   * Load all configuration files. Call once at startup.
   * @throws {Error} if any config file is missing or invalid
   */
  load() {
    this.llm = this._loadAndValidate('llm.yaml', llmSchema);
    this.riskRules = this._loadAndValidate('risk-rules.yaml', riskRulesSchema);
    this.dataSources = this._loadAndValidate('data-sources.yaml', dataSourcesSchema);
    this.screeningSources = this._loadAndValidate('screening-sources.yaml', screeningSourcesSchema);
  }

  /**
   * Start watching risk-rules.yaml for changes (hot-reload).
   */
  watchRiskRules() {
    const filePath = path.join(this.configDir, 'risk-rules.yaml');
    this._riskRulesWatcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        try {
          this.riskRules = this._loadAndValidate('risk-rules.yaml', riskRulesSchema);
          console.log('Risk rules reloaded successfully.');
          for (const listener of this._riskRulesListeners) {
            listener(this.riskRules);
          }
        } catch (err) {
          console.error('Failed to reload risk rules:', err.message);
          // Keep the previous valid config
        }
      }
    });
  }

  /**
   * Register a callback for risk rules changes.
   * @param {(riskRules: Object) => void} listener
   */
  onRiskRulesChange(listener) {
    this._riskRulesListeners.add(listener);
  }

  /**
   * Stop watching for changes. Call on shutdown.
   */
  close() {
    if (this._riskRulesWatcher) {
      this._riskRulesWatcher.close();
      this._riskRulesWatcher = null;
    }
    this._riskRulesListeners.clear();
  }

  /**
   * Load a YAML file, interpolate env vars, parse, and validate.
   * @param {string} filename
   * @param {Joi.ObjectSchema} schema
   * @returns {Object}
   */
  _loadAndValidate(filename, schema) {
    const filePath = path.join(this.configDir, filename);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Configuration file not found: ${filePath}`);
    }

    let raw = fs.readFileSync(filePath, 'utf8');

    // Interpolate environment variables: ${VAR_NAME}
    raw = this._interpolateEnvVars(raw, filename);

    const parsed = yaml.load(raw);

    const { error, value } = schema.validate(parsed, {
      abortEarly: false,
      allowUnknown: true,
      stripUnknown: false,
    });

    if (error) {
      const details = error.details.map((d) => `  - ${d.path.join('.')}: ${d.message}`).join('\n');
      throw new Error(`Invalid configuration in ${filename}:\n${details}`);
    }

    return value;
  }

  /**
   * Replace ${VAR_NAME} references with environment variable values.
   * Throws if a referenced variable is not defined.
   *
   * @param {string} content - Raw YAML string
   * @param {string} filename - For error messages
   * @returns {string}
   */
  _interpolateEnvVars(content, filename) {
    return content.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = process.env[varName.trim()];
      if (value === undefined) {
        throw new Error(
          `Environment variable '${varName.trim()}' referenced in ${filename} is not defined. ` +
          `Set it in your .env file or environment.`
        );
      }
      return value;
    });
  }
}

// ============================================================
// Joi Validation Schemas
// ============================================================

const llmSchema = Joi.object({
  llm: Joi.object({
    default_provider: Joi.string().required(),
    providers: Joi.object().pattern(
      Joi.string(),
      Joi.object({
        base_url: Joi.string().uri(),
        api_key: Joi.string().allow(''),
        timeout_ms: Joi.number().integer().min(1000).max(600000),
        retry: Joi.object({
          max_attempts: Joi.number().integer().min(1).max(10),
          backoff_ms: Joi.number().integer().min(100).max(30000),
        }),
      })
    ).required(),
    routing: Joi.object().pattern(
      Joi.string(),
      Joi.object({
        reasoning: Joi.string().required(),
        extraction: Joi.string().required(),
        screening: Joi.string().required(),
        classification: Joi.string().required(),
        summarization: Joi.string().required(),
      })
    ).required(),
    logging: Joi.object({
      redact_prompts: Joi.boolean().default(false),
      redact_responses: Joi.boolean().default(false),
    }).default(),
  }).required(),
});

const riskRulesSchema = Joi.object({
  risk_rules: Joi.object({
    version: Joi.string().required(),
    country_risk: Joi.object({
      high_risk: Joi.object({
        countries: Joi.array().items(Joi.string().length(2)).required(),
        score_addition: Joi.number().integer().min(0).max(100).required(),
      }).required(),
      medium_risk: Joi.object({
        countries: Joi.array().items(Joi.string().length(2)).required(),
        score_addition: Joi.number().integer().min(0).max(100).required(),
      }).required(),
    }).required(),
    industry_risk: Joi.object().required(),
    ownership_risk: Joi.object().required(),
    screening_risk: Joi.object().required(),
    thresholds: Joi.object({
      low: Joi.object({ min: Joi.number(), max: Joi.number() }).required(),
      medium: Joi.object({ min: Joi.number(), max: Joi.number() }).required(),
      high: Joi.object({ min: Joi.number(), max: Joi.number() }).required(),
      very_high: Joi.object({ min: Joi.number(), max: Joi.number() }).required(),
    }).required(),
    review_routing: Joi.object().required(),
  }).required(),
});

const dataSourcesSchema = Joi.object({
  data_sources: Joi.object().required(),
});

const screeningSourcesSchema = Joi.object({
  screening_sources: Joi.object().required(),
});

// ============================================================
// Singleton
// ============================================================

let instance = null;

/**
 * Get the singleton ConfigService instance.
 * @returns {ConfigService}
 */
function getConfigService() {
  if (!instance) {
    instance = new ConfigService();
  }
  return instance;
}

module.exports = { ConfigService, getConfigService };
```

### Default Config Files

#### `config/llm.yaml`

```yaml
llm:
  default_provider: "ollama"

  providers:
    ollama:
      base_url: "http://ollama:11434"
      timeout_ms: 120000
      retry:
        max_attempts: 3
        backoff_ms: 1000

    # Uncomment to enable additional providers:
    # vllm:
    #   base_url: "http://gpu-server:8000"
    #   api_key: ""
    #   timeout_ms: 60000
    #
    # anthropic:
    #   api_key: "${ANTHROPIC_API_KEY}"
    #   timeout_ms: 30000

  routing:
    ollama:
      reasoning: "mistral-nemo:12b"
      extraction: "llama3:8b"
      screening: "mistral-nemo:12b"
      classification: "llama3:8b"
      summarization: "mistral-nemo:12b"

  logging:
    redact_prompts: false
    redact_responses: false
```

#### `config/risk-rules.yaml`

```yaml
risk_rules:
  version: "1.0"

  country_risk:
    high_risk:
      countries: ["AF", "IR", "KP", "SY", "YE", "MM", "LY", "SO", "SS"]
      score_addition: 30
    medium_risk:
      countries: ["RU", "BY", "VE", "NI", "ZW", "CU", "PK"]
      score_addition: 15

  industry_risk:
    high_risk:
      sic_codes: ["64205", "64209"]
      keywords: ["cryptocurrency", "virtual asset", "money transfer", "gambling"]
      score_addition: 25
    medium_risk:
      sic_codes: ["64191", "64192"]
      keywords: ["precious metals", "art dealing", "real estate"]
      score_addition: 10

  ownership_risk:
    layers_threshold: 3
    score_per_extra_layer: 5
    cross_border_addition: 10
    opaque_jurisdiction_addition: 20
    nominee_detected_addition: 15
    no_ubo_identified_addition: 25

  screening_risk:
    confirmed_sanctions_hit: 100
    pep_identified: 20
    adverse_media_per_hit:
      high_severity: 15
      medium_severity: 8
      low_severity: 3

  thresholds:
    low: { min: 0, max: 25 }
    medium: { min: 26, max: 50 }
    high: { min: 51, max: 75 }
    very_high: { min: 76, max: 100 }

  review_routing:
    low_risk_high_confidence:
      min_confidence: 85
      max_risk_score: 25
      route: "qa_agent"
    standard:
      route: "human_reviewer"
    high_risk:
      min_risk_score: 51
      route: "senior_analyst"
```

#### `config/data-sources.yaml`

```yaml
data_sources:
  registries:
    companies_house:
      api_key: "${COMPANIES_HOUSE_API_KEY}"
      base_url: "https://api.company-information.service.gov.uk"
      rate_limit:
        requests: 600
        period_seconds: 300
      cache_ttl_hours: 24

  # SEC EDGAR — no API key required
  # sec_edgar:
  #   base_url: "https://efts.sec.gov/LATEST/"
  #   cache_ttl_hours: 24
```

#### `config/screening-sources.yaml`

```yaml
screening_sources:
  ofac_sdn:
    type: "sanctions"
    source_url: "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML"
    format: "xml"
    sync_schedule: "0 2 * * *"  # Daily at 2 AM

  uk_hmt:
    type: "sanctions"
    source_url: "https://assets.publishing.service.gov.uk/media/ConList.csv"
    format: "csv"
    sync_schedule: "0 3 * * *"  # Daily at 3 AM

  # un_consolidated:
  #   type: "sanctions"
  #   source_url: "https://scsanctions.un.org/resources/xml/en/consolidated.xml"
  #   format: "xml"
  #   sync_schedule: "0 4 * * *"
```

### Environment Variable Interpolation

The interpolation is simple and intentional — no nested references, no defaults-in-YAML:

| YAML Value | Environment | Result |
|-----------|-------------|--------|
| `${ANTHROPIC_API_KEY}` | `ANTHROPIC_API_KEY=sk-abc` | `sk-abc` |
| `${ANTHROPIC_API_KEY}` | (not set) | **Error**: `Environment variable 'ANTHROPIC_API_KEY' is not defined` |
| `http://ollama:11434` | (no reference) | `http://ollama:11434` (unchanged) |

### Hot-Reload Flow

```
risk-rules.yaml changes on disk
  │
  fs.watch detects 'change' event
  │
  ├─ Re-read and re-validate the file
  │   ├─ Valid → replace this.riskRules, notify listeners
  │   └─ Invalid → log error, keep previous config
  │
  └─ Listeners (e.g., RuleEngine) receive updated config
```

## Interfaces

### ConfigService Public API

| Method | Signature | Purpose |
|--------|-----------|---------|
| `load()` | `() => void` | Load all config files. Call at startup. Throws on invalid config. |
| `watchRiskRules()` | `() => void` | Start fs.watch on risk-rules.yaml |
| `onRiskRulesChange` | `(listener: Function) => void` | Register callback for hot-reload |
| `close()` | `() => void` | Stop watchers and clean up |
| `llm` | `Object` | Parsed and validated LLM config |
| `riskRules` | `Object` | Parsed and validated risk rules |
| `dataSources` | `Object` | Parsed and validated data sources config |
| `screeningSources` | `Object` | Parsed and validated screening sources config |

### Singleton Access

```javascript
const { getConfigService } = require('./services/config-service');
const config = getConfigService();
config.load();
const llmConfig = config.llm;
```

## Acceptance Criteria

- [ ] Reads and parses `config/llm.yaml`, `config/risk-rules.yaml`, `config/data-sources.yaml`, `config/screening-sources.yaml`
- [ ] `${VAR_NAME}` in YAML values is replaced with the corresponding environment variable
- [ ] Undefined environment variable references throw a clear error naming the variable and file
- [ ] Each config file is validated against a Joi schema; invalid configs produce multi-line error with all issues
- [ ] `getConfigService()` returns a singleton instance
- [ ] `config.llm`, `config.riskRules`, `config.dataSources`, `config.screeningSources` are populated after `load()`
- [ ] `watchRiskRules()` detects file changes and reloads risk rules
- [ ] Invalid risk rule changes are logged as errors; previous valid config is retained
- [ ] `onRiskRulesChange(listener)` fires registered callbacks on successful reload
- [ ] Default config files are included in the `config/` directory
- [ ] `close()` stops the file watcher

## Dependencies

- **Depends on**: #4 (Backend scaffold — config is loaded at server startup)
- **Blocks**: #8 (LLM provider interface — needs loaded config), #58 (Rule engine — needs risk rules), all data source stories

## Testing Strategy

1. **Load test**: Create temp YAML files, load them, verify parsed objects match expected structure
2. **Env var interpolation**: Set env vars, reference them in YAML, verify values are replaced
3. **Missing env var**: Reference undefined env var, verify explicit error with variable name
4. **Validation — valid**: Load valid config, verify no errors
5. **Validation — invalid**: Load config with wrong types, missing required fields — verify Joi error details
6. **Missing file**: Reference non-existent file, verify clear file-not-found error
7. **Hot-reload**: Write new risk rules to file, verify `onRiskRulesChange` listener fires
8. **Invalid hot-reload**: Write invalid YAML, verify error logged and previous config retained
9. **Singleton test**: Multiple `getConfigService()` calls return same instance
