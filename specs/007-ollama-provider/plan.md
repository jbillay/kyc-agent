# Implementation Plan: Ollama LLM Provider

**Branch**: `007-ollama-provider` | **Date**: 2026-04-10 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/007-ollama-provider/spec.md`

## Summary

Upgrade the `OllamaProvider` stub (created in feature 006) to its full spec-compliant implementation: add `initialize()` with auto-pull and console logging, per-request `AbortController` timeout via a `_fetch()` helper, `_pullModel()` with a fixed 10-minute timeout, and fail-fast behavior on the first pull error. Also create the first backend test suite (unit + integration) for the provider.

## Technical Context

**Language/Version**: Node.js ≥22 (JavaScript, CommonJS modules, `'use strict'`)  
**Primary Dependencies**: Native `fetch`, native `AbortController` (no polyfills), Jest 29  
**Storage**: N/A — no database involvement  
**Testing**: Jest 29 — unit tests in `tests/backend/llm/providers/ollama.test.js`, integration tests in `tests/backend/llm/providers/ollama.integration.test.js`  
**Target Platform**: Docker container (Linux), accessible via `http://ollama:11434` in compose network  
**Performance Goals**: Completion response ≤3 min on CPU-only; availability check ≤5s; model pull ≤10 min  
**Constraints**: Layer 1 — zero imports from other project layers; `fetch` + `AbortController` are native globals  
**Scale/Scope**: Single provider file; two test files; ~150–200 lines of source, ~250 lines of tests

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|---|---|---|
| I. Auditability First | ✓ Pass | LLMService logs all `complete()` calls to event store — provider is transparent to this |
| II. LLM-Agnostic Provider Interface | ✓ Pass | OllamaProvider implements `LLMProvider` interface; all calls routed through LLMService |
| III. Strict Layered Architecture | ✓ Pass | Layer 1 — no imports from L2-L6; only native Node.js globals used |
| IV. Data Sovereignty | ✓ Pass | Ollama runs locally in Docker; no external data egress |
| V. Configuration-Driven | ✓ Pass | `requiredModels`, `baseUrl`, `timeoutMs` come from config at construction time |

**Post-design re-check**: All principles still satisfied. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/007-ollama-provider/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── llm-provider-interface.md   # Phase 1 output
└── tasks.md             # Phase 2 output (/speckit.tasks — NOT created here)
```

### Source Code (repository root)

```text
backend/
└── src/
    └── llm/
        └── providers/
            └── ollama.js          ← MODIFIED: full implementation

tests/
└── backend/
    └── llm/
        └── providers/
            ├── ollama.test.js            ← NEW: unit tests
            └── ollama.integration.test.js  ← NEW: integration tests
```

**Structure Decision**: Single project layout (Option 1). The provider lives in the existing `backend/src/llm/providers/` directory. Tests follow the established Jest root at `tests/backend/`.

## Complexity Tracking

> No Constitution violations — table not required.
