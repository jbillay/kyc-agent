# Data Model: Vue.js Frontend Scaffold

**Phase**: 1 — Design  
**Branch**: `004-vue-frontend-scaffold`  
**Date**: 2026-04-09

> This feature introduces no database tables. The data model covers the client-side state contracts and the routing configuration that all subsequent frontend features depend on.

---

## Entity 1: Route Definition

Each entry in the Vue Router configuration.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | Yes | URL path pattern (e.g. `/dashboard`, `/cases/:id`) |
| `name` | string | Yes | Symbolic name used for programmatic navigation |
| `component` | function | Yes | Lazy-loaded import returning the view component |
| `meta.requiresAuth` | boolean | Yes | Whether a valid session is required |
| `meta.requiresRole` | string | No | Optional role restriction (e.g. `'admin'`) |
| `props` | boolean | No | When `true`, route params are passed as component props |

**Defined routes:**

| Path | Name | requiresAuth | requiresRole |
|------|------|-------------|--------------|
| `/login` | `login` | false | — |
| `/` | — | — | Redirect to `/dashboard` |
| `/dashboard` | `dashboard` | true | — |
| `/cases/:id` | `case-detail` | true | — |
| `/review` | `review` | true | — |
| `/admin/config` | `config` | true | `admin` |
| `/:pathMatch(.*)*` | `not-found` | false | — |

---

## Entity 2: Pinia Store — Cases

Manages case list and individual case state.

| Field | Type | Initial | Description |
|-------|------|---------|-------------|
| `cases` | array | `[]` | List of case summary objects |
| `currentCase` | object\|null | `null` | Currently viewed case detail |
| `loading` | boolean | `false` | Request in-flight indicator |

**Action stubs (no API calls in scaffold):**
- `fetchCases(filters)` — fetch paginated case list
- `fetchCase(id)` — fetch single case by ID
- `createCase(data)` — submit new case

---

## Entity 3: Pinia Store — Review

Manages the human review queue.

| Field | Type | Initial | Description |
|-------|------|---------|-------------|
| `queue` | array | `[]` | List of cases awaiting human review |
| `loading` | boolean | `false` | Request in-flight indicator |

**Action stubs:**
- `fetchQueue()` — fetch pending review items

---

## Entity 4: Pinia Store — Auth

Manages the authenticated user session.

| Field | Type | Initial | Description |
|-------|------|---------|-------------|
| `user` | object\|null | `null` | Authenticated user profile |
| `token` | string\|null | `null` | JWT access token |
| `isAuthenticated` | boolean (computed) | `false` | Derived: `token !== null` |

**Action stubs:**
- `login(email, password)` — authenticate and store token
- `logout()` — clear session state
- `refreshToken()` — obtain a fresh token

---

## Entity 5: Pinia Store — WebSocket

Manages the Socket.io connection lifecycle.

| Field | Type | Initial | Description |
|-------|------|---------|-------------|
| `socket` | Socket\|null | `null` | Active Socket.io instance |
| `connected` | boolean | `false` | Whether the socket is currently connected |

**Methods (fully implemented in scaffold):**
- `connect(token)` — create socket, attach connect/disconnect handlers
- `disconnect()` — close socket, reset state
- `on(event, handler)` — subscribe to a named event (no-op if not connected)
- `off(event, handler)` — unsubscribe from a named event

---

## Entity 6: AppLayout Component Contract

The shell that wraps all authenticated views.

| Slot/Prop | Type | Description |
|-----------|------|-------------|
| `default` (slot) | Vue slot | Renders the active route's view component |

**Child components:**
- `AppSidebar` — navigation links to all five routes
- `AppHeader` — top bar (title + placeholder for user menu)

**Layout structure:**
```
.app-layout (flex row, 100vh)
├── AppSidebar (fixed width)
└── .app-main (flex column, flex:1)
    ├── AppHeader
    └── .app-content (overflow-y: auto, padding: 1.5rem)
        └── <slot /> ← RouterView output
```
