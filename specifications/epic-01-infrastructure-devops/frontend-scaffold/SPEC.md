# Frontend Project Scaffold (Vue.js 3 + Vite)

> GitHub Issue: [#5](https://github.com/jbillay/kyc-agent/issues/5)
> Epic: Infrastructure & DevOps Setup (#1)
> Size: M (1-3 days) | Priority: Critical

## Context

The frontend is a Vue.js 3 SPA using the Composition API, Pinia for state management, Vue Router for navigation, and a component library (PrimeVue or Naive UI) for data-heavy interfaces like tables, forms, and dialogs. It connects to the backend via REST API calls and receives real-time updates via Socket.io WebSocket.

## Requirements

### Functional

1. Vue 3 project scaffolded with Vite
2. Vue Router configured with all application routes
3. Pinia stores scaffolded for each domain module
4. Component library installed and globally configured
5. Socket.io client configured for real-time backend events
6. Basic layout with navigation sidebar
7. Dockerfile for containerized deployment
8. API proxy configured for local development

### Non-Functional

- Composition API exclusively (no Options API)
- JavaScript with `jsconfig.json` for editor support (no TypeScript)
- Hot Module Replacement (HMR) during development
- Production build outputs static assets servable by nginx

## Technical Design

### Directory Structure

```
frontend/
├── package.json
├── jsconfig.json
├── vite.config.js
├── Dockerfile
├── .dockerignore
├── index.html
├── public/
│   └── favicon.ico
└── src/
    ├── main.js                     # App entry point
    ├── App.vue                     # Root component
    ├── router/
    │   └── index.js                # Route definitions
    ├── stores/
    │   ├── cases.js                # Case management store
    │   ├── review.js               # Review workflow store
    │   ├── auth.js                 # Authentication store
    │   └── websocket.js            # WebSocket connection store
    ├── views/
    │   ├── DashboardView.vue       # Kanban case board
    │   ├── CaseDetailView.vue      # Tabbed case detail
    │   ├── ReviewView.vue          # Reviewer queue
    │   ├── ConfigView.vue          # Admin configuration
    │   └── LoginView.vue           # Authentication
    ├── components/
    │   ├── layout/
    │   │   ├── AppLayout.vue       # Main layout with sidebar
    │   │   ├── AppSidebar.vue      # Navigation sidebar
    │   │   └── AppHeader.vue       # Top header bar
    │   └── common/
    │       └── .gitkeep
    ├── composables/
    │   ├── useCase.js
    │   ├── useWebSocket.js
    │   └── useAuth.js
    └── types/
        └── index.js                # JSDoc type definitions
```

### File: `frontend/package.json`

```json
{
  "name": "kyc-agent-frontend",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "test": "vitest"
  },
  "dependencies": {
    "vue": "^3.5.0",
    "vue-router": "^4.4.0",
    "pinia": "^2.2.0",
    "primevue": "^4.2.0",
    "@primevue/themes": "^4.2.0",
    "primeicons": "^7.0.0",
    "socket.io-client": "^4.8.0",
    "axios": "^1.7.0"
  },
  "devDependencies": {
    "@vitejs/plugin-vue": "^5.0.0",
    "vite": "^6.0.0",
    "vitest": "^2.0.0"
  }
}
```

### File: `frontend/vite.config.js`

```javascript
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:4000',
        ws: true,
      },
    },
  },
});
```

### File: `frontend/jsconfig.json`

```json
{
  "compilerOptions": {
    "checkJs": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ESNext",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*.js", "src/**/*.vue"],
  "exclude": ["node_modules"]
}
```

### File: `frontend/src/main.js`

```javascript
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import PrimeVue from 'primevue/config';
import Aura from '@primevue/themes/aura';
import router from './router';
import App from './App.vue';

import 'primeicons/primeicons.css';

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(PrimeVue, {
  theme: {
    preset: Aura,
    options: {
      darkModeSelector: '.dark',
    },
  },
});

app.mount('#app');
```

### File: `frontend/src/router/index.js`

```javascript
import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/LoginView.vue'),
    meta: { requiresAuth: false },
  },
  {
    path: '/',
    redirect: '/dashboard',
  },
  {
    path: '/dashboard',
    name: 'dashboard',
    component: () => import('@/views/DashboardView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/cases/:id',
    name: 'case-detail',
    component: () => import('@/views/CaseDetailView.vue'),
    meta: { requiresAuth: true },
    props: true,
  },
  {
    path: '/review',
    name: 'review',
    component: () => import('@/views/ReviewView.vue'),
    meta: { requiresAuth: true },
  },
  {
    path: '/admin/config',
    name: 'config',
    component: () => import('@/views/ConfigView.vue'),
    meta: { requiresAuth: true, requiresRole: 'admin' },
  },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// Auth guard placeholder — will be wired up in Phase 3
// router.beforeEach((to, from, next) => { ... });

export default router;
```

### File: `frontend/src/App.vue`

```vue
<script setup>
import { useRoute } from 'vue-router';
import AppLayout from '@/components/layout/AppLayout.vue';

const route = useRoute();
const isLoginPage = computed(() => route.name === 'login');
</script>

<template>
  <AppLayout v-if="!isLoginPage">
    <RouterView />
  </AppLayout>
  <RouterView v-else />
</template>
```

### File: `frontend/src/components/layout/AppLayout.vue`

```vue
<script setup>
import AppSidebar from './AppSidebar.vue';
import AppHeader from './AppHeader.vue';
</script>

<template>
  <div class="app-layout">
    <AppSidebar />
    <div class="app-main">
      <AppHeader />
      <main class="app-content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
}
.app-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.app-content {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
}
</style>
```

### File: `frontend/src/stores/websocket.js`

```javascript
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { io } from 'socket.io-client';

export const useWebSocketStore = defineStore('websocket', () => {
  const socket = ref(null);
  const connected = ref(false);

  function connect(token) {
    const wsUrl = import.meta.env.VITE_WS_URL || '';
    socket.value = io(wsUrl, {
      auth: { token },
      transports: ['websocket'],
    });

    socket.value.on('connect', () => { connected.value = true; });
    socket.value.on('disconnect', () => { connected.value = false; });
  }

  function disconnect() {
    if (socket.value) {
      socket.value.disconnect();
      socket.value = null;
      connected.value = false;
    }
  }

  function on(event, handler) {
    if (socket.value) socket.value.on(event, handler);
  }

  function off(event, handler) {
    if (socket.value) socket.value.off(event, handler);
  }

  return { socket, connected, connect, disconnect, on, off };
});
```

### File: `frontend/Dockerfile`

```dockerfile
# Build stage
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# Serve stage
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
CMD ["nginx", "-g", "daemon off;"]
```

### File: `frontend/nginx.conf`

```nginx
server {
    listen 3000;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /api {
        proxy_pass http://api:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
    }

    location /socket.io {
        proxy_pass http://api:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
```

## Interfaces

### Pinia Store Modules (stubs)

| Store | State | Actions (Phase 1 stubs) |
|-------|-------|------------------------|
| `cases` | `cases[]`, `currentCase`, `loading` | `fetchCases(filters)`, `fetchCase(id)`, `createCase(data)` |
| `review` | `queue[]`, `loading` | `fetchQueue()` |
| `auth` | `user`, `token`, `isAuthenticated` | `login(email, password)`, `logout()`, `refreshToken()` |
| `websocket` | `socket`, `connected` | `connect(token)`, `disconnect()`, `on(event, handler)` |

### Route Map

| Path | View | Auth | Role |
|------|------|------|------|
| `/login` | LoginView | No | — |
| `/dashboard` | DashboardView | Yes | Any |
| `/cases/:id` | CaseDetailView | Yes | Any |
| `/review` | ReviewView | Yes | Any |
| `/admin/config` | ConfigView | Yes | Admin |

## Acceptance Criteria

- [ ] Vue 3 project created with Vite, builds without errors
- [ ] Vue Router configured with all 5 routes (`/dashboard`, `/cases/:id`, `/review`, `/admin/config`, `/login`)
- [ ] Pinia stores scaffolded: `cases`, `review`, `auth`, `websocket`
- [ ] PrimeVue installed and configured with Aura theme
- [ ] Socket.io client wired in `websocket` store with connect/disconnect
- [ ] `AppLayout` renders a sidebar navigation and header
- [ ] Sidebar links navigate between views
- [ ] `npm run dev` starts Vite dev server on port 3000 with API proxy to port 4000
- [ ] `npm run build` produces static assets in `dist/`
- [ ] `frontend/Dockerfile` builds a production nginx image
- [ ] Views are lazy-loaded (code splitting)

## Dependencies

- **Depends on**: #2 (Docker Compose), #4 (Backend scaffold — API must be running for proxy)
- **Blocks**: All frontend stories in Phase 1 (#38-#42)

## Testing Strategy

1. **Build test**: `npm run build` completes without errors or warnings
2. **Route test**: Navigate to each route, verify correct view renders
3. **Layout test**: Sidebar and header render on all authenticated routes, hidden on login
4. **Proxy test**: API call from frontend reaches backend through Vite proxy
5. **WebSocket test**: Socket.io store connects to backend, receives events
6. **Docker test**: `docker build -t kyc-frontend ./frontend` succeeds, nginx serves the SPA
