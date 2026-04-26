# Implementation Plan: Data Source Provider Interface and Registry Abstraction

**Branch**: `011-provider-interface-registry` | **Date**: 2026-04-23 | **Spec**: [spec.md](spec.md)  
**Input**: Feature specification from `/specs/011-provider-interface-registry/spec.md`

## Summary

Define the JSDoc type contracts for all registry and screening data providers, and implement the `RegistryFactory` routing component that maps ISO 3166-1 alpha-2 jurisdiction codes to registered `RegistryProvider` instances. This is a pure contract-definition and factory feature — no real external API calls are included. All stub files already exist in `backend/src/data-sources/`; the task is to fill them with correct definitions and add the factory.

## Technical Context

**Language/Version**: Node.js 18+ / JavaScript (ES2020) — JSDoc for types, no TypeScript  
**Primary Dependencies**: Jest (testing), Node.js built-ins only (no new npm packages needed)  
**Storage**: N/A — this feature defines contracts and routing only; no persistence  
**Testing**: Jest — `cd backend && npm test` / `npx jest path/to/test.js`  
**Target Platform**: Node.js server (backend layer only)  
**Project Type**: Library/module (Layer 2: Data Integration)  
**Performance Goals**: N/A — synchronous factory lookups; no hot path  
**Constraints**: Stateless providers; JSDoc only (no TypeScript); no external dependencies  
**Scale/Scope**: ~3 source files, ~1 test file; all stubs already exist

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Auditability First | PASS | `rawData` required on every response type feeds `data_source_cache`; all agent decisions traceable to source |
| II. LLM-Agnostic | N/A | No LLM calls in this feature |
| III. Strict Layered Architecture | PASS | This is Layer 2. Types and factory have no dependencies above Layer 1; Layer 3 agents will consume these |
| IV. Data Sovereignty | PASS | `updateList` on ScreeningProvider supports local list caching; no data leaves the boundary via this interface |
| V. Configuration-Driven | PASS | Factory is populated at startup from `config/data-sources.yaml` registrations; no hardcoded provider-to-jurisdiction mapping |

**Result**: All applicable gates PASS. No violations. No Complexity Tracking entry required.

### Post-Phase 1 Re-check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Auditability First | PASS | `rawData` required on all 7 registry response types and on `ScreeningHit`; documented in data-model.md and both contracts |
| II. LLM-Agnostic | N/A | No LLM calls introduced |
| III. Strict Layered Architecture | PASS | `registry-factory.js` and `types.js` files have zero imports from Layers 3–6; confirmed in data-model and contracts |
| IV. Data Sovereignty | PASS | No new external calls; `updateList` contract supports local caching |
| V. Configuration-Driven | PASS | Factory registration model is stateless and startup-driven via `config/data-sources.yaml` |

## Project Structure

### Documentation (this feature)

```text
specs/011-provider-interface-registry/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── contracts/
│   ├── registry-provider.md
│   └── screening-provider.md
└── tasks.md             # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
backend/src/data-sources/
├── registry/
│   └── types.js         # Fill: RegistryProvider + all entity JSDoc typedefs
├── screening/
│   └── types.js         # Fill: ScreeningProvider + all screening JSDoc typedefs
└── registry-factory.js  # Create: RegistryFactory class

tests/backend/data-sources/
└── registry-factory.test.js   # Create: factory unit tests
```

**Structure Decision**: Web-application layout (Option 2 from template). All source changes are within `backend/`. No frontend changes. Test file follows the existing `tests/backend/` convention seen in `tests/backend/llm/llm-service.test.js`.
