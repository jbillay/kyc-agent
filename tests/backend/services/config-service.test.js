'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ============================================================
// Helpers
// ============================================================

const VALID_LLM_YAML = `
llm:
  default_provider: ollama
  providers:
    ollama:
      timeout_ms: 120000
      retry:
        max_attempts: 3
        backoff_ms: 1000
  routing:
    ollama:
      reasoning: llama3.1:70b
      extraction: llama3.1:8b
      screening: llama3.1:8b
      classification: llama3.1:8b
      summarization: llama3.1:8b
  logging:
    redact_prompts: false
    redact_responses: false
`;

const VALID_RISK_RULES_YAML = `
risk_rules:
  version: "1.0"
  country_risk:
    high_risk:
      countries: ["AF", "IR"]
      score_addition: 30
    medium_risk:
      countries: ["RU", "BY"]
      score_addition: 15
  industry_risk:
    high_risk:
      keywords: ["cryptocurrency"]
      score_addition: 25
  ownership_risk:
    layers_threshold: 3
  screening_risk:
    confirmed_sanctions_hit: 100
  thresholds:
    low: { min: 0, max: 25 }
    medium: { min: 26, max: 50 }
    high: { min: 51, max: 75 }
    very_high: { min: 76, max: 100 }
  review_routing:
    standard:
      route: "human_reviewer"
`;

const VALID_DATA_SOURCES_YAML = `
data_sources:
  registries: {}
`;

const VALID_SCREENING_SOURCES_YAML = `
screening_sources:
  ofac_sdn:
    type: "sanctions"
    source_url: "https://example.com/sdn.xml"
    format: "xml"
    sync_schedule: "0 2 * * *"
`;

/**
 * Create a temp directory, write config files, and return the dir path.
 * @param {Object} files - map of filename → content (omit to skip creating that file)
 * @returns {string} absolute temp dir path
 */
function makeTempConfigDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-service-test-'));
  const defaults = {
    'llm.yaml': VALID_LLM_YAML,
    'risk-rules.yaml': VALID_RISK_RULES_YAML,
    'data-sources.yaml': VALID_DATA_SOURCES_YAML,
    'screening-sources.yaml': VALID_SCREENING_SOURCES_YAML,
  };
  const merged = Object.assign({}, defaults, files);
  for (const [name, content] of Object.entries(merged)) {
    if (content !== null) {
      fs.writeFileSync(path.join(dir, name), content, 'utf8');
    }
  }
  return dir;
}

/**
 * Create a fresh isolated ConfigService instance pointed at the given dir.
 * Does NOT use the singleton — gives each test an independent instance.
 */
function makeService(configDir) {
  // Isolate from any previous singleton state
  jest.resetModules();
  const { ConfigService } = require('../../../backend/src/services/config-service');
  const svc = new ConfigService();
  svc.configDir = configDir;
  return svc;
}

// ============================================================
// User Story 1 — Application Loads All Configuration at Startup
// ============================================================

describe('User Story 1 — Application Loads All Configuration at Startup', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = null;
    jest.resetModules();
  });

  test('scenario 1 — load() populates all four config domains', () => {
    tmpDir = makeTempConfigDir();
    const svc = makeService(tmpDir);

    svc.load();

    expect(svc.llm).toBeDefined();
    expect(svc.llm.llm).toBeDefined();
    expect(svc.llm.llm.default_provider).toBe('ollama');

    expect(svc.riskRules).toBeDefined();
    expect(svc.riskRules.risk_rules).toBeDefined();
    expect(svc.riskRules.risk_rules.version).toBe('1.0');

    expect(svc.dataSources).toBeDefined();
    expect(svc.dataSources.data_sources).toBeDefined();

    expect(svc.screeningSources).toBeDefined();
    expect(svc.screeningSources.screening_sources).toBeDefined();
  });

  test('scenario 2 — missing config file throws error naming the file', () => {
    tmpDir = makeTempConfigDir({ 'risk-rules.yaml': null });
    const svc = makeService(tmpDir);

    expect(() => svc.load()).toThrow(/risk-rules\.yaml/);
  });

  test('scenario 5 — Joi validation failure lists all invalid fields, no raw values', () => {
    const badLlm = `
llm:
  default_provider: ollama
  providers:
    ollama:
      timeout_ms: "not-a-number"
  routing:
    ollama:
      reasoning: llama3.1:70b
      extraction: llama3.1:8b
      screening: llama3.1:8b
      classification: llama3.1:8b
      summarization: llama3.1:8b
`;
    tmpDir = makeTempConfigDir({ 'llm.yaml': badLlm });
    const svc = makeService(tmpDir);

    let err;
    try {
      svc.load();
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    expect(err.message).toMatch(/Invalid configuration in llm\.yaml/);
    // Field path must appear in the error
    expect(err.message).toMatch(/timeout_ms/);
    // The raw invalid value must NOT appear in the error
    expect(err.message).not.toContain('not-a-number');
  });

  test('scenario 6 — accessing property before load() throws informative error', () => {
    tmpDir = makeTempConfigDir();
    const svc = makeService(tmpDir);

    expect(() => svc.llm).toThrow(
      'ConfigService not loaded — call load() before accessing config.llm'
    );
    expect(() => svc.riskRules).toThrow(
      'ConfigService not loaded — call load() before accessing config.riskRules'
    );
    expect(() => svc.dataSources).toThrow(
      'ConfigService not loaded — call load() before accessing config.dataSources'
    );
    expect(() => svc.screeningSources).toThrow(
      'ConfigService not loaded — call load() before accessing config.screeningSources'
    );
  });

  test('scenario 7 — getConfigService() returns the same singleton instance', () => {
    jest.resetModules();
    const { getConfigService } = require('../../../backend/src/services/config-service');

    const a = getConfigService();
    const b = getConfigService();

    expect(a).toBe(b);
  });
});

// ============================================================
// User Story 2 — Secrets Kept Out of Config Files via Env Vars
// ============================================================

describe('User Story 2 — Secrets Kept Out of Config Files via Environment Variables', () => {
  let tmpDir;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = null;
    delete process.env.TEST_API_KEY_CS;
    delete process.env.UNDEFINED_VAR_XYZ;
    jest.resetModules();
  });

  test('scenario 3 — ${VAR_NAME} in YAML is replaced with environment variable value', () => {
    process.env.TEST_API_KEY_CS = 'test-secret-value';

    const llmWithEnvVar = `
llm:
  default_provider: ollama
  providers:
    ollama:
      api_key: "\${TEST_API_KEY_CS}"
      timeout_ms: 120000
      retry:
        max_attempts: 3
        backoff_ms: 1000
  routing:
    ollama:
      reasoning: llama3.1:70b
      extraction: llama3.1:8b
      screening: llama3.1:8b
      classification: llama3.1:8b
      summarization: llama3.1:8b
`;
    tmpDir = makeTempConfigDir({ 'llm.yaml': llmWithEnvVar });
    const svc = makeService(tmpDir);

    svc.load();

    expect(svc.llm.llm.providers.ollama.api_key).toBe('test-secret-value');
  });

  test('scenario 4 — undefined env var throws error naming the variable and file, not the value', () => {
    // Ensure the variable is not set
    delete process.env.UNDEFINED_VAR_XYZ;

    const llmWithMissingVar = `
llm:
  default_provider: "\${UNDEFINED_VAR_XYZ}"
  providers:
    ollama:
      timeout_ms: 120000
  routing:
    ollama:
      reasoning: llama3.1:70b
      extraction: llama3.1:8b
      screening: llama3.1:8b
      classification: llama3.1:8b
      summarization: llama3.1:8b
`;
    tmpDir = makeTempConfigDir({ 'llm.yaml': llmWithMissingVar });
    const svc = makeService(tmpDir);

    let err;
    try {
      svc.load();
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    expect(err.message).toContain('UNDEFINED_VAR_XYZ');
    expect(err.message).toContain('llm.yaml');
    expect(err.message).toContain('is not defined');
    // The error must contain only the variable name and the file — not a resolved secret value.
    // Since the variable has no value (not set), we verify the JS string 'undefined' (the
    // typeof result) does not appear as a standalone word — it would indicate the code
    // accidentally stringified process.env[varName] instead of throwing.
    expect(err.message).not.toMatch(/:\s*undefined\b/);
  });
});

// ============================================================
// User Story 3 — Risk Rules Updated Without Restart (Hot-Reload)
// ============================================================

describe('User Story 3 — Risk Rules Can Be Updated Without Restarting', () => {
  jest.setTimeout(5000);

  let tmpDir;
  let svc;

  afterEach(() => {
    if (svc) {
      svc.close();
      svc = null;
    }
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = null;
    jest.resetModules();
  });

  test('scenario 8 — valid file change triggers listener with new risk rules', (done) => {
    tmpDir = makeTempConfigDir();
    svc = makeService(tmpDir);
    svc.load();

    const updatedRules = VALID_RISK_RULES_YAML.replace('version: "1.0"', 'version: "2.0"');

    svc.onRiskRulesChange((rules) => {
      try {
        expect(rules.risk_rules.version).toBe('2.0');
        expect(svc.riskRules.risk_rules.version).toBe('2.0');
        done();
      } catch (e) {
        done(e);
      }
    });

    svc.watchRiskRules();

    // Write after watcher is registered — small delay to ensure watcher is active
    setTimeout(() => {
      fs.writeFileSync(path.join(tmpDir, 'risk-rules.yaml'), updatedRules, 'utf8');
    }, 100);
  });

  test('scenario 9 — invalid file change is rejected; previous rules are retained', (done) => {
    tmpDir = makeTempConfigDir();
    svc = makeService(tmpDir);
    svc.load();

    const originalVersion = svc.riskRules.risk_rules.version;
    expect(originalVersion).toBe('1.0');

    let listenerFired = false;
    svc.onRiskRulesChange(() => {
      listenerFired = true;
    });

    svc.watchRiskRules();

    setTimeout(() => {
      // Write invalid YAML (risk_rules is a string, not an object)
      fs.writeFileSync(
        path.join(tmpDir, 'risk-rules.yaml'),
        'risk_rules: "not-an-object"',
        'utf8'
      );
    }, 100);

    // Wait longer than the debounce window (500 ms) + reload time
    setTimeout(() => {
      try {
        expect(listenerFired).toBe(false);
        expect(svc.riskRules.risk_rules.version).toBe('1.0');
        done();
      } catch (e) {
        done(e);
      }
    }, 1500);
  });
});
