# EPIC: LLM Abstraction Layer

> GitHub Issue: [#7](https://github.com/jbillay/kyc-agent/issues/7)
> Milestone: Phase 1 — Foundation
> Labels: `epic`, `llm`

## Overview

Build the model-agnostic LLM integration layer that all agents use. This is the single gateway for every LLM interaction in the platform. No agent or service calls an LLM directly — all requests pass through the `LLMService`, which handles provider selection, model routing, prompt formatting, retries, and audit logging.

This layer is the architectural foundation for the agent system. It enforces the core design principle of LLM-agnosticism: the platform runs on open-source models by default (Ollama), but any provider can be plugged in via configuration.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #8 | LLM provider interface and routing service | L | Critical | `provider-interface/` |
| #9 | Ollama provider implementation | M | Critical | `ollama-provider/` |
| #10 | Prompt adaptation system | M | High | `prompt-adaptation/` |
| #11 | LLM call logging for audit trail | S | Critical | `call-logging/` |
| #12 | YAML configuration loader | S | High | `yaml-config-loader/` |

## Dependency Map

```
#12 YAML Config Loader ─────────┐
   (loads config/llm.yaml)      │
                                │
#10 Prompt Adaptation ──────┐   │
   (model-specific formats) │   │
                            ▼   ▼
#8 Provider Interface ◄─── LLMService ───► #11 Call Logging
   (routes to providers)    │                (writes to event store)
                            │
                            ▼
#9 Ollama Provider
   (default implementation)

Recommended implementation order:
  1. #12 YAML Config Loader     (no LLM dependencies, used by everything)
  2. #8  Provider Interface      (defines the contract + LLMService shell)
  3. #10 Prompt Adaptation       (parallel with #9)
  4. #9  Ollama Provider         (parallel with #10)
  5. #11 Call Logging            (wraps around LLMService after it works)
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 3.1 — Purpose (every LLM call goes through this layer)
- Section 3.2 — Provider Interface (types and contract)
- Section 3.3 — Supported Providers (Ollama, vLLM, OpenAI-compatible, Anthropic, OpenAI)
- Section 3.4 — Model Routing Configuration (`config/llm.yaml`)
- Section 3.5 — Prompt Adaptation (per-model formatting)
- Section 3.6 — LLM Call Logging (`LLMCallLog` structure)

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Single gateway pattern | All LLM calls through `LLMService` | Centralized logging, routing, retry, and prompt adaptation |
| Task-based routing | Different models per task type | Use cheaper/faster models for extraction, stronger models for reasoning |
| Default temperature | 0.1 | KYC decisions must be deterministic and reproducible |
| Structured output | JSON Schema-based | Agents need typed, parseable outputs — not free-form text |
| Retry with backoff | Exponential, max 3 attempts | LLM APIs are unreliable; retries are essential |
| Provider fallback | Graceful degradation to alternate provider | Resilience against single-provider outages |

## File Layout

```
backend/src/llm/
├── types.js                    # JSDoc type definitions (LLMMessage, LLMRequest, etc.)
├── llm-service.js              # Main service: routing, retries, fallback, logging
├── providers/
│   ├── ollama.js               # Ollama provider (MVP default)
│   ├── vllm.js                 # vLLM provider (stub for Phase 1)
│   ├── openai-compatible.js    # OpenAI-compatible provider (stub for Phase 1)
│   ├── anthropic.js            # Anthropic provider (stub for Phase 1)
│   └── openai.js               # OpenAI provider (stub for Phase 1)
└── prompt-adapters/
    ├── mistral.js              # [INST] tag formatting
    ├── llama.js                # <|start_header_id|> formatting
    └── default.js              # Pass-through (OpenAI-compatible)
```

## Definition of Done

- [ ] `LLMService.complete(request, context)` routes to the correct provider/model based on `taskType`
- [ ] Ollama provider connects, pulls models if needed, and returns completions
- [ ] Prompts are automatically formatted for the target model family
- [ ] Every LLM call is logged to `decision_events` with full request/response data
- [ ] All configuration is loaded from `config/llm.yaml` with environment variable interpolation
- [ ] Unit tests cover routing logic, retry behavior, and prompt formatting
- [ ] Integration test demonstrates end-to-end call: agent → LLMService → Ollama → response
