# Implementation Plan: Vue.js Frontend Scaffold

**Branch**: `004-vue-frontend-scaffold` | **Date**: 2026-04-09 | **Spec**: [spec.md](spec.md)  
**Input**: Feature specification from `/specs/004-vue-frontend-scaffold/spec.md`

## Summary

Update and complete the existing `frontend/` directory to match the architecture specification: upgrade to Vue 3.5 + Vite 6 + PrimeVue 4 (Aura theme), wire Vue Router with all six routes (5 named + 1 catch-all), scaffold four Pinia stores, implement the AppLayout shell with sidebar and header, create six view stub components, add the WebSocket store with a working connect/disconnect/on/off implementation, configure the dev server proxy and nginx proxy_pass rules, and produce a Dockerfile using node:22-alpine.

> **Context**: The `frontend/` directory already exists from the Docker Compose stack setup (epic-01 feature 001). The plan updates it — it does not start from scratch.

---

## Technical Context

**Language/Version**: Node.js 22, JavaScript (ESM — `import`/`export`, `"type": "module"` in package.json)  
**Primary Dependencies**: Vue 3.5, Vite 6, Vue Router 4.4, Pinia 2.2, PrimeVue 4.2 + @primevue/themes (Aura), primeicons 7, socket.io-client 4.8, axios 1.7, vitest 2  
**Storage**: None (client-side only; stores hold in-memory reactive state)  
**Testing**: Vitest 2 — included in package.json, no test files written in this scaffold  
**Target Platform**: Modern browsers (Chromium, Firefox, Safari); nginx:alpine container for production  
**Project Type**: Single-Page Application (SPA), Layer 6 per architecture  
**Performance Goals**: Dev server ready in < 5 seconds; production build completes without errors  
**Constraints**: Composition API exclusively (no Options API); JavaScript only (no TypeScript); lazy-loaded routes (code splitting)  
**Scale/Scope**: 6 routes, 4 stores, 3 layout components, 6 view stubs, 3 composable stubs

---

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Applicable | Status | Notes |
|-----------|-----------|--------|-------|
| I — Auditability First | No | N/A | Frontend scaffold introduces no agents, decision fragments, or event store interactions |
| II — LLM-Agnostic Interface | No | N/A | No LLM calls in frontend |
| III — Strict Layered Architecture | Yes | **PASS** | Frontend is Layer 6; communicates with Layer 5 (API) via HTTP/WebSocket only; no imports from backend layers |
| IV — Data Sovereignty | Yes | **PASS** | No external API calls from the scaffold itself; nginx proxy forwards to the local backend service only |
| V — Config-Driven Compliance Logic | No | N/A | No compliance or risk logic in frontend scaffold |

**Post-Phase 1 re-check**: No design decisions introduced violations. Constitution Check confirmed PASS.

---

## Project Structure

### Documentation (this feature)

```text
specs/004-vue-frontend-scaffold/
├── plan.md              ← this file
├── research.md          ← Phase 0 output
├── data-model.md        ← Phase 1 output
├── quickstart.md        ← Phase 1 output
├── contracts/
│   └── frontend-ui.md   ← Phase 1 output
├── checklists/
│   └── requirements.md
└── tasks.md             ← Phase 2 output (/speckit.tasks — not created here)
```

### Source Code — changes to `frontend/`

```text
frontend/
├── package.json              UPDATE — add type:module, upgrade Vue/Vite, add PrimeVue/socket.io-client/axios/vitest, add test script
├── jsconfig.json             CREATE — checkJs, ESNext, @/* alias
├── vite.config.js            UPDATE — add @/ alias, add /api and /socket.io proxy
├── nginx.conf                UPDATE — add proxy_pass blocks for /api and /socket.io
├── Dockerfile                UPDATE — node:20 → node:22, remove redundant RUN line
├── .dockerignore             CREATE
├── index.html                KEEP — already correct
├── public/
│   └── favicon.ico           CREATE — minimal placeholder
└── src/
    ├── main.js               UPDATE — add vue-router, PrimeVue, primeicons import
    ├── App.vue               REWRITE — add computed import (bug fix), AppLayout conditional, RouterView
    ├── router/
    │   └── index.js          CREATE — 6 routes with lazy-loaded views, redirect /, auth guard placeholder
    ├── stores/
    │   ├── cases.js          CREATE — Pinia store stub with state shape and action stubs
    │   ├── review.js         CREATE — Pinia store stub
    │   ├── auth.js           CREATE — Pinia store stub with isAuthenticated computed
    │   └── websocket.js      CREATE — full implementation: connect/disconnect/on/off
    ├── views/
    │   ├── DashboardView.vue       CREATE — stub
    │   ├── CaseDetailView.vue      CREATE — stub (receives :id via props)
    │   ├── ReviewView.vue          CREATE — stub
    │   ├── ConfigView.vue          CREATE — stub
    │   ├── LoginView.vue           CREATE — stub
    │   └── NotFoundView.vue        CREATE — "Page not found" + link to /dashboard
    ├── components/
    │   ├── layout/
    │   │   ├── AppLayout.vue       CREATE — flex layout wrapping sidebar + header + slot
    │   │   ├── AppSidebar.vue      CREATE — RouterLink nav to all 5 routes
    │   │   └── AppHeader.vue       CREATE — top bar with title
    │   └── common/
    │       └── .gitkeep            CREATE
    ├── composables/
    │   ├── useCase.js              CREATE — stub
    │   ├── useWebSocket.js         CREATE — stub
    │   └── useAuth.js              CREATE — stub
    └── types/
        └── index.js                CREATE — JSDoc stub
```

---

## Implementation Notes

### `frontend/package.json` — key changes

- Add `"type": "module"`
- `vue`: `^3.4.0` → `^3.5.0`
- `vite` (devDep): `^5.0.0` → `^6.0.0`
- Add: `primevue ^4.2.0`, `@primevue/themes ^4.2.0`, `primeicons ^7.0.0`, `socket.io-client ^4.8.0`, `axios ^1.7.0`
- Add devDep: `vitest ^2.0.0`
- Add script: `"test": "vitest"`
- `engines.node`: `>=20.0.0` → `>=22.0.0`

### `frontend/src/App.vue` — bug fix

Source SPEC.md uses `computed` without importing it. Must add `import { computed } from 'vue'`.

### nginx proxy_pass placement

The two new `location /api` and `location /socket.io` blocks must appear **before** the catch-all `location /` block, otherwise nginx matches `/api/...` as a static file request first.

### `frontend/Dockerfile` — change

`FROM node:20-alpine AS builder` → `FROM node:22-alpine AS builder`. Remove the `RUN rm -f /etc/nginx/conf.d/default.conf.bak` line — it references a file that doesn't exist and adds noise.

---

## Complexity Tracking

> No Constitution violations to justify.
