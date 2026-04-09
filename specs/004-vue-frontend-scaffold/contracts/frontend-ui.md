# Frontend UI Contract: Vue.js Scaffold

**Version**: 0.1.0  
**Branch**: `004-vue-frontend-scaffold`

> This contract documents the interfaces the frontend exposes to users and to the backend, and the contracts that internal components must honour.

---

## Route Contract

All routes defined at application startup. Views are lazy-loaded (each route = separate JS chunk).

| Path | View Component | Layout | Auth Required | Role |
|------|---------------|--------|---------------|------|
| `/login` | `LoginView.vue` | None | No | — |
| `/dashboard` | `DashboardView.vue` | `AppLayout` | Yes | Any |
| `/cases/:id` | `CaseDetailView.vue` | `AppLayout` | Yes | Any |
| `/review` | `ReviewView.vue` | `AppLayout` | Yes | Any |
| `/admin/config` | `ConfigView.vue` | `AppLayout` | Yes | `admin` |
| `/:pathMatch(.*)*` | `NotFoundView.vue` | None | No | — |

**Redirect**: `/` → `/dashboard`

---

## Dev Server Proxy Contract

During local development, the Vite dev server forwards requests as follows:

| Incoming path | Forwarded to | Protocol | Notes |
|--------------|-------------|----------|-------|
| `/api/*` | `http://localhost:4000` | HTTP | `changeOrigin: true` |
| `/socket.io/*` | `http://localhost:4000` | WebSocket | `ws: true` |

---

## nginx Proxy Contract (Docker)

In the Docker container, nginx handles:

| Path | Behaviour |
|------|-----------|
| `/api` | `proxy_pass http://api:4000` |
| `/socket.io` | `proxy_pass http://api:4000` with WebSocket upgrade headers |
| Known static assets (`.js`, `.css`, images, fonts) | Served from `/usr/share/nginx/html`; `Cache-Control: public, immutable` (1 year) |
| `/` and all other paths | `try_files $uri $uri/ /index.html` (SPA fallback) |
| `= /index.html` | `Cache-Control: no-cache, no-store, must-revalidate` |

---

## WebSocket Store Public API

The `useWebSocketStore` (Pinia) exposes:

| Member | Type | Description |
|--------|------|-------------|
| `socket` | `Ref<Socket\|null>` | Active Socket.io instance; `null` when disconnected |
| `connected` | `Ref<boolean>` | Connection status |
| `connect(token)` | function | Opens a Socket.io connection with auth token |
| `disconnect()` | function | Closes socket; resets state |
| `on(event, handler)` | function | Subscribe to backend event; no-op if not connected |
| `off(event, handler)` | function | Unsubscribe from backend event |

---

## Component Library Contract

PrimeVue 4 is globally registered with the Aura theme preset. All PrimeVue components are available in any `.vue` file without per-file imports:

```vue
<!-- No import needed — registered globally in main.js -->
<Button label="Submit" />
<DataTable :value="rows" />
```

`primeicons` CSS is imported globally in `main.js` — PrimeVue icon names are available via the `icon` prop on any component.
