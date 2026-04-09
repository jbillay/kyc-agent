# Tasks: Vue.js Frontend Scaffold

**Input**: Design documents from `/specs/004-vue-frontend-scaffold/`
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅, quickstart.md ✅

**Organization**: Tasks grouped by user story — each story is independently implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no incomplete dependencies)
- **[Story]**: User story this task belongs to (US1–US5)

---

## Phase 1: Setup

**Purpose**: Update container configuration and create the public asset stub. No user story work depends on these being complete first, but they are quick and self-contained.

- [x] T001 Update `frontend/Dockerfile` — change `FROM node:20-alpine AS builder` → `FROM node:22-alpine AS builder`; remove the `RUN rm -f /etc/nginx/conf.d/default.conf.bak` line
- [x] T002 Create `frontend/.dockerignore` — include `node_modules/`, `dist/`, `.git/`, `*.log`, `.env*`, `coverage/`
- [x] T003 Create `frontend/public/favicon.ico` — write a minimal 1×1 pixel ICO binary placeholder (16 bytes)

---

## Phase 2: User Story 1 — Project Dependencies Configured (Priority: P1) 🎯 MVP

**Goal**: Update `package.json`, `jsconfig.json`, `vite.config.js`, and `nginx.conf` so that
`npm install` resolves all required packages, the `@/` path alias resolves in both Vite and the
editor, and the dev server and nginx container correctly proxy `/api` and `/socket.io`.

**Independent Test**: Run `npm install` from `frontend/` with no errors. Run `npm run build` and
confirm `dist/index.html` is produced without errors. Verify `vite.config.js` contains the `@/`
alias and both proxy entries. Verify `nginx.conf` has `proxy_pass` blocks for `/api` and
`/socket.io` appearing before the catch-all `location /` block.

⚠️ **CRITICAL**: T004 must complete before T006 and T007 — Vite and nginx read package.json's
`"type": "module"` setting. T005–T007 can run in parallel after T004.

- [x] T004 [US1] Update `frontend/package.json` — add `"type": "module"`; bump `"vue"` to `"^3.5.0"` and `"vite"` to `"^6.0.0"`; add runtime deps `"primevue": "^4.2.0"`, `"@primevue/themes": "^4.2.0"`, `"primeicons": "^7.0.0"`, `"socket.io-client": "^4.8.0"`, `"axios": "^1.7.0"`; add devDep `"vitest": "^2.0.0"`; add script `"test": "vitest"`; set `"engines": { "node": ">=22.0.0" }`
- [x] T005 [P] [US1] Create `frontend/jsconfig.json` — set `"compilerOptions": { "checkJs": true, "module": "ESNext", "moduleResolution": "bundler", "target": "ESNext", "paths": { "@/*": ["./src/*"] } }`, `"include": ["src/**/*.js", "src/**/*.vue"]`
- [x] T006 [P] [US1] Update `frontend/vite.config.js` — import `{ fileURLToPath, URL }` from `'node:url'`; add `resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } }`; add `server: { proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true }, '/socket.io': { target: 'http://localhost:4000', ws: true } } }`
- [x] T007 [P] [US1] Update `frontend/nginx.conf` — insert `location /api { proxy_pass http://api:4000; proxy_http_version 1.1; proxy_set_header Host $host; }` and `location /socket.io { proxy_pass http://api:4000; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection 'upgrade'; }` **before** the existing catch-all `location /` block; leave the existing SPA fallback, asset caching, and index.html no-cache blocks unchanged

**Checkpoint**: User Story 1 complete — `npm install` and `npm run build` pass; `@/` alias is declared; proxy blocks are present in both Vite config and nginx.conf.

---

## Phase 3: User Story 2 — Vue Router Configured (Priority: P1)

**Goal**: Create `src/router/index.js` with all six routes (lazy-loaded), the `/` redirect, and a
navigation guard placeholder. Create the six view stub components the router references.

**Independent Test**: `npm run build` completes with six separate JS chunks (one per view). Opening
`/login`, `/dashboard`, `/cases/test-id`, `/review`, `/admin/config`, and a non-existent path in
the browser each renders the correct stub component name.

⚠️ **CRITICAL**: T008 (router) and T009–T014 (view stubs) are independent — create all six view
stubs in parallel, then create the router. The router imports all six views.

- [x] T009 [P] [US2] Create `frontend/src/views/DashboardView.vue` — `<script setup>` stub with component name comment; `<template>` showing `<h1>Dashboard</h1>`
- [x] T010 [P] [US2] Create `frontend/src/views/CaseDetailView.vue` — `<script setup>` stub; accept `id` as a prop (`defineProps({ id: String })`); `<template>` showing `<h1>Case: {{ id }}</h1>`
- [x] T011 [P] [US2] Create `frontend/src/views/ReviewView.vue` — `<script setup>` stub; `<template>` showing `<h1>Review Queue</h1>`
- [x] T012 [P] [US2] Create `frontend/src/views/ConfigView.vue` — `<script setup>` stub; `<template>` showing `<h1>Config</h1>`
- [x] T013 [P] [US2] Create `frontend/src/views/LoginView.vue` — `<script setup>` stub; `<template>` showing `<h1>Login</h1>`
- [x] T014 [P] [US2] Create `frontend/src/views/NotFoundView.vue` — `<script setup>` stub; `<template>` showing `<h1>Page not found</h1>` and a `<RouterLink to="/dashboard">Back to Dashboard</RouterLink>`
- [x] T008 [US2] Create `frontend/src/router/index.js` — `createRouter` with `createWebHistory()`; define these routes in order: `{ path: '/login', name: 'login', component: () => import('@/views/LoginView.vue') }`, `{ path: '/', redirect: '/dashboard' }`, `{ path: '/dashboard', name: 'dashboard', component: () => import('@/views/DashboardView.vue'), meta: { requiresAuth: true } }`, `{ path: '/cases/:id', name: 'case-detail', component: () => import('@/views/CaseDetailView.vue'), props: true, meta: { requiresAuth: true } }`, `{ path: '/review', name: 'review', component: () => import('@/views/ReviewView.vue'), meta: { requiresAuth: true } }`, `{ path: '/admin/config', name: 'config', component: () => import('@/views/ConfigView.vue'), meta: { requiresAuth: true, requiresRole: 'admin' } }`, `{ path: '/:pathMatch(.*)*', name: 'not-found', component: () => import('@/views/NotFoundView.vue') }`; add `router.beforeEach` guard that checks `to.meta.requiresAuth` and logs a TODO comment; export default router

**Checkpoint**: User Story 2 complete — router module exports a router instance; all six view files exist; build produces six lazy-loaded chunks.

---

## Phase 4: User Story 3 — AppLayout Shell (Priority: P1)

**Goal**: Create the three layout components (`AppLayout`, `AppSidebar`, `AppHeader`), rewrite
`App.vue` with the layout conditional and `RouterView`, and update `main.js` to register
`vue-router`, `pinia`, `PrimeVue` (Aura theme), and `primeicons`.

**Independent Test**: Navigate to `/dashboard` — the page renders inside AppLayout (sidebar +
header visible). Navigate to `/login` — no sidebar/header. Navigate to `/does-not-exist` — no
sidebar/header, "Page not found" shown.

⚠️ T015–T017 (layout components) can run in parallel. T019 (App.vue) depends on T015–T017.
T020 (main.js) depends on T019, T008 (router), and T021–T023 (stores — from Phase 5). Run
T015–T017 and T021–T023 in parallel, then T019 and T024 (WebSocket store), then T020 last.

- [x] T016 [P] [US3] Create `frontend/src/components/layout/AppSidebar.vue` — `<script setup>` importing `RouterLink`; `<template>` with `<nav>` containing `<RouterLink>` entries for `/dashboard` (Dashboard), `/review` (Review Queue), `/admin/config` (Config), `/login` (Login); styled as a fixed-width sidebar column
- [x] T017 [P] [US3] Create `frontend/src/components/layout/AppHeader.vue` — `<script setup>` stub; `<template>` with `<header>` element containing `<span>KYC Agent</span>` as the title
- [x] T015 [US3] Create `frontend/src/components/layout/AppLayout.vue` — `<script setup>` importing `AppSidebar` and `AppHeader`; `<template>` with root `.app-layout` (display:flex, flex-direction:row, min-height:100vh); inside: `<AppSidebar />` then `.app-main` (display:flex, flex-direction:column, flex:1) containing `<AppHeader />` then `.app-content` (overflow-y:auto, padding:1.5rem) with `<slot />`; inline `<style scoped>` for the three layout classes
- [x] T018 [US3] Create `frontend/src/components/common/.gitkeep` — empty file
- [x] T019 [US3] Rewrite `frontend/src/App.vue` — `<script setup>`: `import { computed } from 'vue'`; `import { useRoute } from 'vue-router'`; `import AppLayout from '@/components/layout/AppLayout.vue'`; `const route = useRoute()`; `const useLayout = computed(() => route.meta.requiresAuth === true)`; `<template>`: `<AppLayout v-if="useLayout"><RouterView /></AppLayout><RouterView v-else />` 
- [x] T020 [US3] Update `frontend/src/main.js` — import order: `createApp` from vue; `createPinia` from pinia; router from `@/router`; `PrimeVue` from `primevue/config`; `Aura` from `@primevue/themes/aura`; `'primeicons/resources/primeicons.css'`; `App` from `./App.vue`; then: `const app = createApp(App)`; `app.use(createPinia())`; `app.use(router)`; `app.use(PrimeVue, { theme: { preset: Aura, options: { darkModeSelector: '.dark' } } })`; `app.mount('#app')`

**Checkpoint**: User Story 3 complete — AppLayout shell renders for auth routes; layout is absent for /login and /not-found; build completes without errors.

---

## Phase 5: User Story 4 — Pinia Store Stubs (Priority: P1)

**Goal**: Create the three domain store stubs (`cases`, `review`, `auth`) with the correct
reactive state shape and no-op action stubs. These run in parallel — they have no dependencies
on each other.

**Independent Test**: Import each store in the browser console after `npm run dev`. Call
`useCasesStore()` — verify `cases`, `currentCase`, `loading` fields exist. Call
`useReviewStore()` — verify `queue` and `loading` fields. Call `useAuthStore()` — verify `user`,
`token` fields and that `isAuthenticated` returns `false` (initial state).

- [x] T021 [P] [US4] Create `frontend/src/stores/cases.js` — `defineStore('cases', () => { const cases = ref([]); const currentCase = ref(null); const loading = ref(false); async function fetchCases(filters) { /* TODO */ } async function fetchCase(id) { /* TODO */ } async function createCase(data) { /* TODO */ } return { cases, currentCase, loading, fetchCases, fetchCase, createCase }; })`
- [x] T022 [P] [US4] Create `frontend/src/stores/review.js` — `defineStore('review', () => { const queue = ref([]); const loading = ref(false); async function fetchQueue() { /* TODO */ } return { queue, loading, fetchQueue }; })`
- [x] T023 [P] [US4] Create `frontend/src/stores/auth.js` — `defineStore('auth', () => { const user = ref(null); const token = ref(null); const isAuthenticated = computed(() => token.value !== null); async function login(email, password) { /* TODO */ } async function logout() { /* TODO */ } async function refreshToken() { /* TODO */ } return { user, token, isAuthenticated, login, logout, refreshToken }; })`

**Checkpoint**: User Story 4 complete — three store files exist with correct state shape; `isAuthenticated` is a computed property derived from `token`.

---

## Phase 6: User Story 5 — WebSocket Store (Priority: P2)

**Goal**: Create `src/stores/websocket.js` with a fully working Socket.io connection lifecycle —
`connect(token)`, `disconnect()`, `on(event, handler)`, `off(event, handler)`.

**Independent Test**: In the browser console after `npm run dev`, import `useWebSocketStore`.
Call `connect('test-token')` with the backend running — `connected` becomes `true`. Call
`on('test-event', console.log)` — socket listener registered. Call `disconnect()` — `connected`
returns to `false`, `socket` is `null`.

- [x] T024 [US5] Create `frontend/src/stores/websocket.js` — `import { io } from 'socket.io-client'`; `defineStore('websocket', () => { const socket = ref(null); const connected = ref(false); function connect(token) { if (socket.value) return; const url = import.meta.env.VITE_WS_URL || ''; socket.value = io(url, { auth: { token } }); socket.value.on('connect', () => { connected.value = true; }); socket.value.on('disconnect', () => { connected.value = false; }); } function disconnect() { if (socket.value) { socket.value.disconnect(); socket.value = null; connected.value = false; } } function on(event, handler) { if (!socket.value) return; socket.value.on(event, handler); } function off(event, handler) { if (!socket.value) return; socket.value.off(event, handler); } return { socket, connected, connect, disconnect, on, off }; })`

**Checkpoint**: User Story 5 complete — websocket.js implements all four public methods; `connect` uses `VITE_WS_URL` env var with same-origin fallback; `on`/`off` are no-ops when disconnected.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Create stub files for composables and types that define the API contracts for future
feature work. All tasks in this phase are independent and can run in parallel.

- [x] T025 [P] Create `frontend/src/composables/useCase.js` — export stub function `export function useCase(id) { /* TODO: wrap useCasesStore fetchCase + reactive state */ return {}; }`
- [x] T026 [P] Create `frontend/src/composables/useWebSocket.js` — export stub function `export function useWebSocket() { /* TODO: wrap useWebSocketStore */ return {}; }`
- [x] T027 [P] Create `frontend/src/composables/useAuth.js` — export stub function `export function useAuth() { /* TODO: wrap useAuthStore */ return {}; }`
- [x] T028 Create `frontend/src/types/index.js` — JSDoc type definitions stub: `/** @typedef {{ id: string, status: string, entityName: string }} KycCase */`; `/** @typedef {{ id: string, email: string, role: string }} User */`; `/** @typedef {{ type: string, confidence: number, evidence: object[] }} DecisionFragment */`

---

## Dependencies

```
Phase 1 (T001–T003) → no dependencies
Phase 2 (T004–T007) → Phase 1 complete (T004 must run before T005/T006/T007)
Phase 3 (T008–T014) → T004 complete (need package.json with vue-router)
  T009–T014 run in parallel → T008 runs after all view stubs exist
Phase 4 (T015–T020) → T008 complete (App.vue needs router)
  T016–T017 run in parallel → T015 runs after T016+T017
  T019 runs after T015 → T020 runs after T019 + T021–T023 + T024
Phase 5 (T021–T023) → T004 complete (need pinia); run in parallel; can run alongside Phase 4
Phase 6 (T024) → T004 complete (need socket.io-client); can run alongside Phases 4+5
Phase 7 (T025–T028) → T020 complete (main.js wires everything together)
```

## Parallel Execution Opportunities

**Maximum parallelism window (after T008 complete):**
```
T009 | T010 | T011 | T012 | T013 | T014  ← 6 view stubs
T021 | T022 | T023                        ← 3 store stubs
T024                                       ← websocket store
```

**Second parallel window (after T015–T017, T021–T024 complete):**
```
T019 → then T020 (sequential)
```

**Final parallel window (after T020):**
```
T025 | T026 | T027 | T028                 ← composable + type stubs
```

## Implementation Strategy

**MVP scope (US1–US3)**: T001–T020 — gets a running dev server with correct routing and layout.  
**Full P1 scope (US1–US4)**: Add T021–T023 — all four stores stubbed.  
**Complete (all stories)**: Add T024–T028 — WebSocket store fully implemented + composable stubs.

Total: 28 tasks | 5 user stories | ~15 parallel opportunities
