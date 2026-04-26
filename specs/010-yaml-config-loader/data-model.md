# Data Model: YAML Configuration Loader

**Branch**: `010-yaml-config-loader` | **Date**: 2026-04-22

> This feature introduces no database tables. All state is in-memory within the config service singleton. This document describes the in-memory data shapes loaded from YAML files.

---

## ConfigService (in-memory singleton)

| Field | Type | Description |
|-------|------|-------------|
| `_llm` | `Object \| null` | Parsed and validated LLM config. `null` until `load()` is called. |
| `_riskRules` | `Object \| null` | Parsed and validated risk rules. Updated on hot-reload. |
| `_dataSources` | `Object \| null` | Parsed and validated data sources config. |
| `_screeningSources` | `Object \| null` | Parsed and validated screening sources config. |
| `_loaded` | `boolean` | `false` until `load()` completes successfully. Guards property access. |
| `configDir` | `string` | Resolved path to config directory. Defaults to `{cwd}/config`. |
| `_riskRulesWatcher` | `fs.FSWatcher \| null` | Active watcher, or `null` if not watching. |
| `_riskRulesListeners` | `Set<Function>` | Registered hot-reload callbacks. |
| `_debounceTimer` | `ReturnType<setTimeout> \| null` | Active debounce timer for hot-reload. |

### Property Access Invariant

Any access to `llm`, `riskRules`, `dataSources`, or `screeningSources` while `_loaded === false` MUST throw:

```
ConfigService not loaded — call load() before accessing config.{propertyName}
```

---

## LLM Config Shape (`config/llm.yaml`)

Top-level key: `llm`

```
llm
├── default_provider     string    required   Name of the default provider (must match a key in providers)
├── providers            object    required   Map of provider name → provider config
│   └── {name}
│       ├── base_url     string    optional   HTTP base URL (uri format)
│       ├── api_key      string    optional   API key (empty string allowed)
│       ├── timeout_ms   integer   optional   1000–600000
│       └── retry
│           ├── max_attempts  integer  optional  1–10
│           └── backoff_ms    integer  optional  100–30000
├── routing              object    required   Map of provider name → task routing
│   └── {name}
│       ├── reasoning        string  required
│       ├── extraction       string  required
│       ├── screening        string  required
│       ├── classification   string  required
│       └── summarization    string  required
└── logging              object    optional   Defaults applied if absent
    ├── redact_prompts   boolean   default: false
    └── redact_responses boolean   default: false
```

**Unknown fields**: Permitted and preserved (`allowUnknown: true`). Allows provider-specific extras (e.g., `max_concurrent`, `availability_timeout_ms`) without schema errors.

---

## Risk Rules Config Shape (`config/risk-rules.yaml`)

Top-level key: `risk_rules`

```
risk_rules
├── version              string   required
├── country_risk         object   required
│   ├── high_risk
│   │   ├── countries        string[]   required   ISO 3166-1 alpha-2 codes (2-char)
│   │   └── score_addition   integer    required   0–100
│   └── medium_risk
│       ├── countries        string[]   required
│       └── score_addition   integer    required   0–100
├── industry_risk        object   required   (structure validated as present; contents opaque)
├── ownership_risk       object   required   (structure validated as present)
├── screening_risk       object   required   (structure validated as present)
├── thresholds           object   required
│   ├── low        { min: number, max: number }   required
│   ├── medium     { min: number, max: number }   required
│   ├── high       { min: number, max: number }   required
│   └── very_high  { min: number, max: number }   required
└── review_routing       object   required   (structure validated as present)
```

**Hot-reload**: This is the only config shape subject to live reload. The in-memory shape is atomically replaced on successful reload. Previous shape is retained on validation failure.

---

## Data Sources Config Shape (`config/data-sources.yaml`)

Top-level key: `data_sources`

```
data_sources             object   required   (contents opaque at this level — validated as present)
```

Schema intentionally loose to allow the data integration layer to define its own provider-specific shapes.

---

## Screening Sources Config Shape (`config/screening-sources.yaml`)

Top-level key: `screening_sources`

```
screening_sources        object   required   (contents opaque at this level — validated as present)
```

Schema intentionally loose to allow the screening sync worker to define its own source-specific shapes.

---

## State Transition: ConfigService Lifecycle

```
UNLOADED  ──load()──►  LOADED  ──watchRiskRules()──►  WATCHING
                         │                                  │
                    close() / shutdown              close() / shutdown
                         │                                  │
                         ▼                                  ▼
                      (end)                             (end)

WATCHING  ──file change (valid)──►   WATCHING  (riskRules replaced, listeners notified)
WATCHING  ──file change (invalid)──► WATCHING  (riskRules unchanged, error logged)
```

**Notes**:
- `load()` called on an already-LOADED service: reloads all four config files and replaces in-memory values (idempotent reload — deferred to planning).
- `close()` is safe to call in any state, including UNLOADED.
