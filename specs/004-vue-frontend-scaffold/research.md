# Research: Vue.js Frontend Scaffold

**Phase**: 0 — Research  
**Branch**: `004-vue-frontend-scaffold`  
**Date**: 2026-04-09

## Existing Codebase State

**Decision**: The `frontend/` directory already exists with a minimal placeholder. The plan updates it rather than creating from scratch.

**Delta — what already exists:**

| Artefact | Status | Notes |
|----------|--------|-------|
| `frontend/index.html` | Keep as-is | Correct shape, `type="module"` script tag present |
| `frontend/package.json` | Needs update | Missing `type: "module"`, PrimeVue, socket.io-client, axios, vitest; Vue 3.4→3.5, Vite 5→6 |
| `frontend/vite.config.js` | Needs update | Missing `@/` path alias, missing proxy config for `/api` and `/socket.io` |
| `frontend/src/App.vue` | Needs rewrite | Placeholder only; also contains a bug (uses `computed` without importing it) |
| `frontend/src/main.js` | Needs update | Missing `vue-router`, `PrimeVue`, `primeicons` |
| `frontend/Dockerfile` | Needs update | node:20 → node:22; redundant `rm` line |
| `frontend/nginx.conf` | Needs update | Has SPA fallback and asset caching but missing `proxy_pass` for `/api` and `/socket.io` |
| All `src/` subdirectories | Missing | router/, stores/, views/, components/, composables/, types/ |
| `frontend/jsconfig.json` | Missing | Must create |
| `frontend/.dockerignore` | Missing | Must create |

---

## Research Finding 1: Vue 3 Composition API + `computed` Import

**Decision**: In `<script setup>`, all Vue reactivity APIs (`ref`, `computed`, `watch`, etc.) must be explicitly imported from `'vue'`. The source SPEC.md's `App.vue` uses `computed` without importing it — this is a bug that would cause a runtime error.

**Fix**: Add `import { computed } from 'vue';` to `App.vue`.

**Rationale**: Vue 3's `<script setup>` does not auto-import reactivity primitives unless the project uses `unplugin-auto-import`. This scaffold does not include that plugin.

---

## Research Finding 2: Vite 6 `@/` Path Alias Pattern

**Decision**: Use `fileURLToPath` + `URL` from `node:url` to resolve the `src/` alias. This is the Vite-recommended pattern for ESM projects.

```js
import { fileURLToPath, URL } from 'node:url';

resolve: {
  alias: {
    '@': fileURLToPath(new URL('./src', import.meta.url)),
  },
},
```

**Rationale**: `path.resolve(__dirname, './src')` is not available in ESM context (`"type": "module"` in package.json). The `fileURLToPath`/`URL` pattern works in both CJS and ESM.

---

## Research Finding 3: Vite Dev Server Proxy for WebSocket

**Decision**: The `/socket.io` proxy entry requires `ws: true` to upgrade the connection from HTTP to WebSocket.

```js
proxy: {
  '/api': { target: 'http://localhost:4000', changeOrigin: true },
  '/socket.io': { target: 'http://localhost:4000', ws: true },
},
```

**Rationale**: Without `ws: true`, Vite forwards the initial HTTP handshake but does not upgrade the connection, causing Socket.io to fall back to HTTP long-polling.

---

## Research Finding 4: PrimeVue 4 + Aura Theme Registration

**Decision**: Register PrimeVue globally in `main.js` using the `theme.preset` option introduced in PrimeVue 4. The `@primevue/themes` package is a separate install.

```js
import PrimeVue from 'primevue/config';
import Aura from '@primevue/themes/aura';

app.use(PrimeVue, {
  theme: { preset: Aura, options: { darkModeSelector: '.dark' } },
});
```

**Rationale**: PrimeVue 4 moved from CSS-based theming to a design token system delivered via theme presets. The `Aura` preset is the recommended default. Without this registration, PrimeVue components render with no styling.

---

## Research Finding 5: nginx `proxy_pass` for WebSocket Upgrade

**Decision**: Add `proxy_pass` blocks for `/api` and `/socket.io` to `nginx.conf`. Both require `Upgrade` and `Connection` headers for WebSocket support.

```nginx
location /api {
    proxy_pass http://api:4000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
}

location /socket.io {
    proxy_pass http://api:4000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
}
```

**Rationale**: The hostname `api` matches the Docker Compose service name for the backend. `proxy_http_version 1.1` is required for `Connection: upgrade` headers (HTTP/1.0 does not support them).

---

## Research Finding 6: Pinia Store Stub Convention

**Decision**: Each store stub exports a `defineStore` call with the store's canonical state shape and empty/no-op action stubs. This gives future developers a clear contract to implement against without wiring any API calls.

**Rationale**: An empty file or a file with just `// TODO` would not communicate the expected state shape, requiring future developers to re-derive it from feature specs.

---

## Research Finding 7: `package.json` `"type": "module"`

**Decision**: Add `"type": "module"` to `frontend/package.json`. This makes all `.js` files in the `frontend/` directory ESM by default.

**Rationale**: Vite 6 projects and Vue 3 Composition API files use ES module syntax (`import`/`export`). Without `"type": "module"`, Node.js would try to parse `vite.config.js` as CommonJS, which would fail on the `import` statements.
