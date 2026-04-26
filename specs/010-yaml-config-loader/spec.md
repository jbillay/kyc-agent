# Feature Specification: YAML Configuration Loader

**Feature Branch**: `010-yaml-config-loader`  
**Created**: 2026-04-22  
**Status**: Draft  
**Input**: User description: "@specifications/epic-02-llm-abstraction/yaml-config-loader/SPEC.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Application Loads All Configuration at Startup (Priority: P1)

When the KYC Agent platform starts, all configuration is loaded from YAML files before the application accepts any requests. This covers LLM provider settings, risk rules, data source connections, and screening sources. If any required file is missing or contains invalid values, startup fails immediately with a clear, specific error message so the operator can fix the problem without trial and error.

**Why this priority**: The entire platform is configuration-driven. Without valid configuration, no agents can run, no LLM calls can be made, and no risk rules can be applied. A failed or silent startup would produce cryptic runtime errors far removed from the root cause.

**Independent Test**: Can be fully tested by starting the application with valid config files and verifying all four configuration domains are populated, then repeating with missing or invalid files to verify informative failure messages.

**Acceptance Scenarios**:

1. **Given** all four config files exist and contain valid content, **When** the application starts, **Then** LLM settings, risk rules, data sources, and screening sources are all available to the rest of the system.
2. **Given** a config file is missing, **When** the application starts, **Then** startup is halted and the error message names the missing file explicitly.
3. **Given** a config file contains a value of the wrong type (e.g., a string where a number is required), **When** the application starts, **Then** startup is halted and the error message lists every invalid field, not just the first one encountered.

---

### User Story 2 - Secrets Are Kept Out of Config Files via Environment Variables (Priority: P2)

Operators place API keys and other sensitive values in environment variables, then reference them in YAML config files using `${VAR_NAME}` syntax. The platform substitutes the real value at load time so config files can be safely committed to source control without embedding secrets.

**Why this priority**: Separating secrets from committed configuration is a security baseline for any production system. It also enables different environments (dev, staging, prod) to use the same config files with different secrets.

**Independent Test**: Can be fully tested by setting an environment variable, referencing it in a YAML file, loading config, and verifying the runtime value contains the actual secret — not the placeholder string.

**Acceptance Scenarios**:

1. **Given** an environment variable `API_KEY=secret123` is set and the YAML file contains `api_key: "${API_KEY}"`, **When** the config is loaded, **Then** the runtime config contains `secret123`.
2. **Given** a YAML file references `${MISSING_VAR}` and that variable is not set in the environment, **When** the config is loaded, **Then** loading fails with an error that names both the variable and the file it was found in.
3. **Given** a YAML value contains no `${...}` references, **When** the config is loaded, **Then** the value is used unchanged.

---

### User Story 3 - Risk Rules Can Be Updated Without Restarting the Application (Priority: P3)

Compliance officers can update the risk rules configuration file while the application is running. The platform detects the change, reloads and re-validates the rules, and begins applying the new rules to subsequent cases — all without downtime. If the updated file is invalid, the previous valid rules remain active and an error is logged.

**Why this priority**: Risk rules change with regulatory guidance. Requiring a full application restart every time rules change introduces operational risk and downtime. Hot-reload makes the system operationally resilient while keeping the audit trail intact.

**Independent Test**: Can be fully tested by registering a change listener, modifying the risk rules file on disk, and verifying the listener fires with the new rules. Separately, write an invalid file and verify the listener does not fire and the previous rules remain active.

**Acceptance Scenarios**:

1. **Given** the application is running with valid risk rules and a listener is registered, **When** the risk rules file is updated with valid new content, **Then** the listener receives the new rules and subsequent risk scoring uses the updated values.
2. **Given** the application is running with valid risk rules, **When** the risk rules file is updated with invalid content (e.g., a missing required field), **Then** an error is logged, the listener does not fire, and the previous valid rules remain in use.
3. **Given** the hot-reload watcher is active, **When** the application shuts down cleanly, **Then** the file watcher is closed and no further reload events are processed.

---

### Edge Cases

- What happens when a YAML file is syntactically malformed (not just wrong types, but unparseable YAML)?
- What if the same environment variable is referenced multiple times in the same file — does each reference resolve independently?
- What if the risk rules file is partially written when the watcher fires — does the reload handle an incomplete file gracefully?
- Rapid successive file-change events (e.g., from editor auto-save) are collapsed via a ≤ 500 ms debounce window — only one reload attempt is made per burst.
- What if `CONFIG_DIR` is set to a path that does not exist?

## Clarifications

### Session 2026-04-22

- Q: Should resolved config values (e.g., API keys) be redacted from error messages and log output? → A: Yes — redact all config values from errors and logs; only print the field name and the fact it failed (Option A).
- Q: What should happen if a caller accesses a config domain property before `load()` is called? → A: Throw an explicit error immediately naming the property accessed and instructing the caller to invoke `load()` first (Option A).
- Q: How should rapid successive file-change events during hot-reload be handled? → A: Debounce — collapse all events within a short window (≤ 500 ms) into a single reload attempt (Option A).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The configuration loader MUST load and parse four YAML files: `llm.yaml`, `risk-rules.yaml`, `data-sources.yaml`, and `screening-sources.yaml`.
- **FR-002**: The configuration loader MUST replace all `${VAR_NAME}` placeholders in YAML values with the corresponding environment variable value before parsing.
- **FR-003**: The configuration loader MUST throw an error naming the variable and the source file when a referenced environment variable is not defined in the environment.
- **FR-004**: Each configuration file MUST be validated against a schema that defines required fields and value types; validation errors MUST list all failing fields in a single error (not just the first).
- **FR-005**: The configuration loader MUST fail immediately at startup if any required config file is missing, unreadable, or invalid.
- **FR-006**: The configuration service MUST be accessible as a singleton — all callers that request the service instance receive the same object.
- **FR-007**: After loading, the service MUST expose the parsed configuration for each domain (`llm`, `riskRules`, `dataSources`, `screeningSources`) as named properties.
- **FR-008**: The configuration service MUST support watching `risk-rules.yaml` for file-system changes and reloading the rules automatically when a change is detected.
- **FR-009**: Callers MUST be able to register callbacks that are invoked with the new risk rules when a successful hot-reload occurs.
- **FR-010**: When a changed `risk-rules.yaml` fails validation, the service MUST log the error and retain the last successfully loaded risk rules without crashing.
- **FR-011**: The configuration service MUST provide a shutdown method that stops the file watcher and releases all registered listeners.
- **FR-012**: Default configuration files MUST be included in the repository so the platform can run without any manual config setup.
- **FR-013**: The configuration directory MUST be overridable via an environment variable so the same code can serve different deployment environments.
- **FR-014**: Error messages and log output produced by the configuration service MUST NOT include resolved config values (e.g., API keys, secrets). Only the field name and the nature of the failure may appear.
- **FR-015**: Accessing any config domain property (`llm`, `riskRules`, `dataSources`, `screeningSources`) before `load()` has been called MUST throw an explicit error that names the property accessed and instructs the caller to invoke `load()` first.
- **FR-016**: The hot-reload watcher MUST debounce file-change events, collapsing all events within a 500 ms window into a single reload attempt to handle burst writes from editors and file-copy tools.

### Key Entities

- **Configuration Service**: The singleton component that owns the loaded configuration state. Exposes domain-specific configuration objects and the hot-reload interface.
- **LLM Config**: Defines available LLM providers, model routing by task type, retry settings, and logging redaction preferences.
- **Risk Rules Config**: Defines country risk scores, industry risk scores, ownership complexity scoring, screening hit scoring, risk thresholds, and review routing rules. Subject to hot-reload.
- **Data Sources Config**: Defines external registry and data source connections including credentials and rate limits.
- **Screening Sources Config**: Defines sanctions list sources, their formats, and sync schedules.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All four configuration domains are populated and available within 100 milliseconds of the load call completing.
- **SC-002**: A misconfigured startup (missing file, invalid value, undefined env var) produces a single, actionable error message that names the specific file and field(s) at fault — no generic "config failed" messages.
- **SC-003**: Hot-reload of risk rules completes and notifies listeners within 2 seconds of a file-change event being detected.
- **SC-004**: A change to an invalid risk rules file leaves the running system unaffected — risk scoring continues using the previous valid rules without requiring operator intervention.
- **SC-005**: Multiple calls to retrieve the configuration service across different modules in the same process return the identical object instance.
- **SC-006**: All default config files in the repository allow the platform to start successfully without any additional configuration beyond what is documented as required.

## Assumptions

- The platform runs as a single process per instance; a singleton pattern is sufficient and no cross-process config sharing is needed.
- Config files are UTF-8 encoded YAML; no other encodings or formats need to be supported.
- Environment variable interpolation supports simple `${VAR_NAME}` syntax only — inline default values within the YAML expression (e.g., `${VAR:-default}`) are not required.
- Hot-reload is only required for `risk-rules.yaml`; the other three config files require a process restart to pick up changes.
- Schema validation only needs to catch structural problems (missing required fields, wrong types) — semantic business-rule validation (e.g., "risk thresholds must not overlap") is out of scope.
- The repository ships with default config files that reference environment variables only for optional external services; the defaults work without those variables being set.
- The `config/` directory at the project root is the default location for all config files unless overridden.
