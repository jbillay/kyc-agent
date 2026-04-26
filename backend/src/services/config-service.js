'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const Joi = require('joi');

// ============================================================
// ConfigService
// ============================================================

/**
 * Configuration service — singleton that loads and validates YAML config files.
 *
 * Call load() once at startup before accessing any config properties.
 * Call watchRiskRules() to enable hot-reload of risk-rules.yaml.
 * Call close() on graceful shutdown.
 */
class ConfigService {
  constructor() {
    /** @type {Object|null} */
    this._llm = null;
    /** @type {Object|null} */
    this._riskRules = null;
    /** @type {Object|null} */
    this._dataSources = null;
    /** @type {Object|null} */
    this._screeningSources = null;

    /** @type {boolean} */
    this._loaded = false;

    /** @type {string} */
    this.configDir = process.env.CONFIG_DIR || path.join(process.cwd(), 'config');

    /** @type {fs.FSWatcher|null} */
    this._riskRulesWatcher = null;

    /** @type {Set<Function>} */
    this._riskRulesListeners = new Set();

    /** @type {ReturnType<typeof setTimeout>|null} */
    this._debounceTimer = null;
  }

  // ----------------------------------------------------------
  // Public property getters (guarded — throw before load())
  // ----------------------------------------------------------

  get llm() {
    if (!this._loaded) {
      throw new Error(
        'ConfigService not loaded — call load() before accessing config.llm'
      );
    }
    return this._llm;
  }

  get riskRules() {
    if (!this._loaded) {
      throw new Error(
        'ConfigService not loaded — call load() before accessing config.riskRules'
      );
    }
    return this._riskRules;
  }

  get dataSources() {
    if (!this._loaded) {
      throw new Error(
        'ConfigService not loaded — call load() before accessing config.dataSources'
      );
    }
    return this._dataSources;
  }

  get screeningSources() {
    if (!this._loaded) {
      throw new Error(
        'ConfigService not loaded — call load() before accessing config.screeningSources'
      );
    }
    return this._screeningSources;
  }

  // ----------------------------------------------------------
  // Public methods
  // ----------------------------------------------------------

  /**
   * Load all four configuration files. Call once at startup.
   * Throws if any file is missing, unparseable, or fails schema validation.
   */
  load() {
    this._llm = this._loadAndValidate('llm.yaml', llmSchema);
    this._riskRules = this._loadAndValidate('risk-rules.yaml', riskRulesSchema);
    this._dataSources = this._loadAndValidate('data-sources.yaml', dataSourcesSchema);
    this._screeningSources = this._loadAndValidate('screening-sources.yaml', screeningSourcesSchema);
    this._loaded = true;
  }

  /**
   * Start watching risk-rules.yaml for file-system changes (hot-reload).
   * Change events are debounced within a 500 ms window to handle burst writes.
   */
  watchRiskRules() {
    const filePath = path.join(this.configDir, 'risk-rules.yaml');
    this._riskRulesWatcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this._reloadRiskRules(), 500);
      }
    });
  }

  /**
   * Register a callback invoked after each successful hot-reload of risk-rules.yaml.
   * @param {(riskRules: Object) => void} listener
   */
  onRiskRulesChange(listener) {
    this._riskRulesListeners.add(listener);
  }

  /**
   * Stop the file watcher, clear the debounce timer, and remove all listeners.
   * Safe to call in any lifecycle state.
   */
  close() {
    if (this._riskRulesWatcher) {
      this._riskRulesWatcher.close();
      this._riskRulesWatcher = null;
    }
    clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    this._riskRulesListeners.clear();
  }

  // ----------------------------------------------------------
  // Private methods
  // ----------------------------------------------------------

  /**
   * Reload risk-rules.yaml after a debounced change event.
   * On success: replaces this._riskRules and notifies listeners.
   * On failure: logs the error and retains the previous valid config.
   * @private
   */
  _reloadRiskRules() {
    try {
      this._riskRules = this._loadAndValidate('risk-rules.yaml', riskRulesSchema);
      console.log('[ConfigService] Risk rules reloaded successfully.');
      for (const listener of this._riskRulesListeners) {
        listener(this._riskRules);
      }
    } catch (err) {
      console.error('[ConfigService] Failed to reload risk rules:', err.message);
      // Retain the previous valid config — do not rethrow
    }
  }

  /**
   * Load a YAML file, interpolate env vars, parse, and validate against schema.
   * @param {string} filename
   * @param {Joi.ObjectSchema} schema
   * @returns {Object}
   * @private
   */
  _loadAndValidate(filename, schema) {
    const filePath = path.join(this.configDir, filename);

    if (!fs.existsSync(filePath)) {
      throw new Error(`Configuration file not found: ${filePath}`);
    }

    let raw = fs.readFileSync(filePath, 'utf8');

    // Interpolate ${VAR_NAME} references before YAML parsing
    raw = this._interpolateEnvVars(raw, filename);

    const parsed = yaml.load(raw);

    const { error, value } = schema.validate(parsed, {
      abortEarly: false,
      allowUnknown: true,
      stripUnknown: false,
    });

    if (error) {
      // d.context.value intentionally excluded — secret redaction (FR-014)
      const details = error.details
        .map((d) => `  - ${d.path.join('.')}: ${d.message}`)
        .join('\n');
      throw new Error(`Invalid configuration in ${filename}:\n${details}`);
    }

    return value;
  }

  /**
   * Replace ${VAR_NAME} placeholders in raw YAML with environment variable values.
   * Throws an explicit error (naming the variable and file) if a referenced
   * variable is not defined. Never includes the resolved value in error messages.
   *
   * @param {string} content - Raw YAML string
   * @param {string} filename - Used in error messages only
   * @returns {string}
   * @private
   */
  _interpolateEnvVars(content, filename) {
    return content.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const trimmed = varName.trim();
      const value = process.env[trimmed];
      if (value === undefined) {
        throw new Error(
          `Environment variable '${trimmed}' referenced in ${filename} is not defined. ` +
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
 * Get the singleton ConfigService instance. Creates it on first call.
 * @returns {ConfigService}
 */
function getConfigService() {
  if (!instance) {
    instance = new ConfigService();
  }
  return instance;
}

module.exports = { ConfigService, getConfigService };
