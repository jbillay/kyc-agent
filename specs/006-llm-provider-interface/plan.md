# Implementation Plan: LLM Provider Interface and Routing Service

**Branch**: `006-llm-provider-interface` | **Date**: 2026-04-10 | **Spec**: [spec.md](spec.md)  
**Input**: Feature specification from `/specs/006-llm-provider-interface/spec.md`

## Summary

Implement Layer 1 of the KYC Agent platform: a singleton `LLMService` that routes all agent LLM calls to the correct provider and model based on task type, with retry/fallback resilience (including rate-limit aware backoff), configurable per-provider concurrency limiting, structured output parsing, and append-only audit logging. All routing rules live in `config/llm.yaml`. No agent or service may call an LLM provider directly. The entire LLM layer currently consists of stubs (`// TODO: implement`) — this plan covers full implementation.

## Technical Context

**Language/Version**: Node.js 22+ / JavaScript (CommonJS, `'use strict'`)  
**Primary Dependencies**: `js-yaml` (YAML config loading), `joi` (runtime validation), `jest` (testing) — all already present in `backend/package.json`; no new dependencies required  
**Storage**: PostgreSQL via existing `backend/src/services/event-store.js` (append-only `decision_events` table, injected as dependency)  
**Testing**: Jest — tests live in `tests/backend/llm/` following existing project convention (`tests/backend/<layer>/`)  
**Target Platform**: Linux (Docker Compose), self-hosted, standalone deployment  
**Project Type**: Backend service layer — Layer 1 (LLM Abstraction)  
**Performance Goals**: Routing decision + availability check under 1s (availability check timeout configurable); structured output parse under 50ms  
**Constraints**: No upward or cross-layer dependencies; all routing and retry config in `config/llm.yaml`; no external cloud services required for core functionality  
**Scale/Scope**: 3+ registered providers simultaneously; per-provider concurrency limit (configurable); multiple concurrent agent requests

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| I. Auditability First | ✅ Pass | FR-010: every LLM call logged to event store with full request/response. FR-011: logging failure must not break the call. SC-005–SC-006 are measurable targets. Full content stored unredacted (clarification Q2). |
| II. LLM-Agnostic Provider Interface | ✅ Pass | This feature defines the `LLMProvider` interface and `LLMService` singleton. FR-001 prohibits direct provider calls from agents. Default provider is Ollama (self-hosted). Commercial providers opt-in via config only. |
| III. Strict Layered Architecture | ✅ Pass | Layer 1 — no dependencies on Layers 2–6. Event store injected (not imported directly). Provider SDKs are external libraries, not platform layers. |
| IV. Data Sovereignty | ✅ Pass | Default provider is Ollama (local inference). OpenAI/Anthropic are opt-in via `config/llm.yaml`. Full content logged within deployment boundary; no data egress by default. |
| V. Configuration-Driven | ✅ Pass | All routing, retry, timeout, and concurrency limits declared in `config/llm.yaml`. No routing or compliance logic hardcoded. |

**Gate result: PASS.** No violations. No entries required in Complexity Tracking.

**Post-design re-check**: ✅ Pass — Phase 1 design introduces no new dependencies that would violate any principle. The `Semaphore` utility is a pure in-process construct with no external dependencies.

## Project Structure

### Documentation (this feature)

```text
specs/006-llm-provider-interface/
├── plan.md                      # This file
├── research.md                  # Phase 0: key decisions and rationale
├── data-model.md                # Phase 1: types, entities, YAML schema
├── quickstart.md                # Phase 1: wiring and usage guide
├── contracts/
│   ├── llm-provider-interface.md   # LLMProvider contract
│   ├── llm-service-api.md          # LLMService public API
│   ├── llm-yaml-schema.md          # config/llm.yaml structure
│   └── event-log-shape.md          # llm_call event store entry shape
└── tasks.md                     # Phase 2 output (/speckit.tasks — not created here)
```

### Source Code (repository root)

```text
backend/src/llm/
├── types.js                         # JSDoc type definitions + TASK_TYPES constant
├── llm-service.js                   # Singleton routing service (complete implementation)
├── prompt-adapter-factory.js        # Maps model name → adapter instance (new file)
├── prompt-adapters/
│   ├── default.js                   # Passthrough adapter for unknown models
│   ├── mistral.js                   # Mistral-specific system/user formatting
│   └── llama.js                     # Llama-specific chat template formatting
└── providers/
    ├── ollama.js                    # LLMProvider: local Ollama inference
    ├── openai.js                    # LLMProvider: OpenAI API
    ├── openai-compatible.js         # LLMProvider: any OpenAI-compatible endpoint
    ├── anthropic.js                 # LLMProvider: Anthropic API
    └── vllm.js                      # LLMProvider: vLLM self-hosted

config/
└── llm.yaml                         # Provider routing, model mapping, retry, timeouts,
                                     #   concurrency limits (new file, created by this feature)

tests/backend/llm/
├── llm-service.test.js              # Routing, retry/backoff, fallback, structured output,
│                                    #   concurrency, logging, availability timeout
└── prompt-adapters/
    └── adapters.test.js             # Adapter message formatting tests
```

**Structure Decision**: Backend-only feature. All LLM abstraction code lives strictly within `backend/src/llm/`. Test files follow the existing `tests/backend/<layer>/` convention. No frontend changes. No new npm dependencies required.

## Complexity Tracking

> No constitution violations detected. Section not required.
