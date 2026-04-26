# Implementation Plan: LLM Call Logging for Audit Trail

**Branch**: `009-llm-call-logging` | **Date**: 2026-04-22 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/009-llm-call-logging/spec.md`

## Summary

Extend `LLMService` with complete audit logging: add `status`, `originalProvider`, and `error` fields to all `llm_call` event payloads; log every failed provider attempt individually (primary failure, each fallback failure, and all-retries-exhausted terminal failure — each as a discrete event); and implement optional sensitive-data redaction driven by `config/llm.yaml`. Read access to raw `llm_call` events is restricted to `compliance_officer` and `admin` roles — enforcement is the responsibility of the API layer (Layer 5), not `LLMService`. All changes are confined to Layer 1 (LLM Abstraction) and require no new source files — modifications are to `llm-service.js`, `config/llm.yaml`, and the existing test suite.

## Technical Context

**Language/Version**: Node.js 20 (JavaScript, `'use strict'`)  
**Primary Dependencies**: Jest (testing), existing `LLMService` / `PromptAdapterFactory` infrastructure  
**Storage**: Event store injected as dependency; `decision_events` table (PostgreSQL, append-only) managed by Layer 4  
**Testing**: Jest — `cd backend && npm test` / `cd backend && npx jest path/to/test.js`  
**Target Platform**: Docker Compose (Linux container)  
**Project Type**: Backend service module (Layer 1 — LLM Abstraction)  
**Performance Goals**: Logging overhead < 10 ms per call (async fire-and-forget write)  
**Constraints**: Logging failures MUST NOT propagate; log writes are NOT awaited before returning LLM response  
**Scale/Scope**: ~5,000 `llm_call` events/day at peak

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Auditability First | ✅ PASS | Per-attempt failure logging provides complete audit coverage — every provider interaction is recorded, not just the terminal outcome |
| II. LLM-Agnostic Provider Interface | ✅ PASS | No change to provider interface; logging is internal to `LLMService` |
| III. Strict Layered Architecture | ✅ PASS | Feature stays in Layer 1; event store remains injected dependency (no import of Layer 4 modules). RBAC enforcement for `llm_call` read access is explicitly assigned to Layer 5 (API) — no upward dependency introduced |
| IV. Data Sovereignty | ✅ PASS | All logging is internal; redaction config prevents unintended data capture |
| V. Configuration-Driven Compliance | ✅ PASS | Redaction settings are declared in `config/llm.yaml`, not hardcoded |

**Post-design re-check**: No design decisions introduced during Phase 1 affect any principle. No violations.

## Project Structure

### Documentation (this feature)

```text
specs/009-llm-call-logging/
├── plan.md              ← this file
├── research.md          ← Phase 0 output
├── data-model.md        ← Phase 1 output
├── contracts/
│   └── llm-call-event.md  ← Phase 1 output
└── tasks.md             ← Phase 2 output (/speckit.tasks — not created here)
```

### Source Code (repository root)

```text
backend/
├── src/
│   └── llm/
│       └── llm-service.js        ← MODIFY: _logCall(), _logFailedCall(), _redactIfNeeded(), constructor
└── tests/
    └── backend/
        └── llm/
            └── llm-service.test.js  ← MODIFY: extend US4 suite, add redaction + failed-call tests

config/
└── llm.yaml                         ← MODIFY: add logging: section
```

**Structure Decision**: Single backend project. This feature is a pure modification to existing Layer 1 files — no new modules, no new directories in `src/`.

## Out of Scope (This Feature)

- **RBAC read enforcement for `llm_call` events**: FR-009 defines the policy (`compliance_officer` and `admin` only). Enforcement is implemented in the audit trail API endpoint (Layer 5). This feature only ensures the events are written correctly; gating who can read them is a Layer 5 concern.
- End-to-end tests against a live PostgreSQL database.
- Performance benchmarking or timing tests for the < 10 ms overhead target (satisfied by design via async fire-and-forget).
