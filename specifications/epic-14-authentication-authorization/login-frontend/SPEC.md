# Login Page and Auth Flow in Frontend

> GitHub Issue: [#69](https://github.com/jbillay/kyc-agent/issues/69)
> Epic: Authentication & Authorization (#67)
> Size: M (3-5 days) | Priority: Critical

## Context

The frontend needs a complete authentication flow: a login page, persistent auth state, automatic token management, and route protection. Unauthenticated users are redirected to `/login`; authenticated users see their name and role in the navigation header and can log out.

The Pinia `auth` store manages tokens and user state. An Axios interceptor attaches the access token to every API request and transparently handles token refresh when a 401 is received. Vue Router navigation guards protect all routes except `/login`.

## Requirements

### Functional

1. Login page at `/login` with email and password form
2. Client-side validation: email format, password minimum 8 characters
3. Server-side error display (invalid credentials, account deactivated)
4. On successful login, redirect to dashboard (`/`)
5. Access token stored in memory (Pinia store), NOT in localStorage
6. Refresh token managed via httpOnly cookie (set by backend, not accessible to JS)
7. Axios request interceptor adds `Authorization: Bearer <accessToken>` header
8. Axios response interceptor catches 401, attempts token refresh, retries original request
9. If refresh fails, clear auth state and redirect to `/login`
10. Vue Router `beforeEach` guard: redirect to `/login` if not authenticated
11. `/login` route accessible without auth; redirect to `/` if already authenticated
12. Logout button in navigation header clears auth state, calls `/api/v1/auth/logout`, redirects to `/login`
13. User name and role displayed in navigation header when authenticated
14. Loading state during login (disable button, show spinner)
15. Remember the intended route: if user navigates to `/cases/123` while unauthenticated, redirect there after login

### Non-Functional

- Login form is accessible (proper labels, focus management, keyboard navigation)
- Token refresh is transparent to the user — no visible interruption
- No flash of protected content before redirect to login

## Technical Design

### File: `frontend/src/stores/auth.js`

```javascript
import { defineStore } from 'pinia';
import axios from 'axios';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,        // { id, email, name, role }
    accessToken: null, // JWT string, in-memory only
    isInitialized: false, // true after initial auth check completes
  }),

  getters: {
    isAuthenticated: (state) => !!state.user && !!state.accessToken,
    userRole: (state) => state.user?.role || null,
    userName: (state) => state.user?.name || '',
  },

  actions: {
    /**
     * Login with email + password.
     * Backend sets refresh token as httpOnly cookie.
     */
    async login(email, password) {
      const { data } = await axios.post('/api/v1/auth/login', { email, password });
      this.accessToken = data.accessToken;
      this.user = data.user;
    },

    /**
     * Refresh access token using httpOnly cookie.
     * Called by Axios interceptor on 401.
     */
    async refresh() {
      const { data } = await axios.post('/api/v1/auth/refresh');
      this.accessToken = data.accessToken;
      this.user = data.user;
    },

    /**
     * Logout — clear state and call backend to invalidate refresh token.
     */
    async logout() {
      try {
        await axios.post('/api/v1/auth/logout');
      } catch {
        // Best-effort; clear state regardless
      }
      this.accessToken = null;
      this.user = null;
    },

    /**
     * Initialize auth state on app startup.
     * Attempts to refresh token — if it succeeds, user is still logged in.
     */
    async initialize() {
      try {
        await this.refresh();
      } catch {
        this.accessToken = null;
        this.user = null;
      } finally {
        this.isInitialized = true;
      }
    },
  },
});
```

### File: `frontend/src/composables/useAuth.js`

```javascript
import { computed } from 'vue';
import { useAuthStore } from '@/stores/auth';

const ROLE_HIERARCHY = ['analyst', 'senior_analyst', 'compliance_officer', 'admin'];

export function useAuth() {
  const authStore = useAuthStore();

  const isAuthenticated = computed(() => authStore.isAuthenticated);
  const user = computed(() => authStore.user);
  const role = computed(() => authStore.userRole);

  /**
   * Check if current user has at least the given role level.
   * @param {string} requiredRole
   * @returns {boolean}
   */
  function hasRole(requiredRole) {
    if (!role.value) return false;
    const userLevel = ROLE_HIERARCHY.indexOf(role.value);
    const requiredLevel = ROLE_HIERARCHY.indexOf(requiredRole);
    return userLevel >= requiredLevel;
  }

  return { isAuthenticated, user, role, hasRole };
}
```

### File: `frontend/src/plugins/axios.js`

```javascript
import axios from 'axios';
import { useAuthStore } from '@/stores/auth';
import router from '@/router';

// Request interceptor — attach access token
axios.interceptors.request.use((config) => {
  const authStore = useAuthStore();
  if (authStore.accessToken) {
    config.headers.Authorization = `Bearer ${authStore.accessToken}`;
  }
  return config;
});

// Response interceptor — handle 401 with token refresh
let isRefreshing = false;
let failedQueue = [];

function processQueue(error, token = null) {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else resolve(token);
  });
  failedQueue = [];
}

axios.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Don't intercept auth endpoints or already-retried requests
    if (originalRequest.url?.includes('/auth/') || originalRequest._retry) {
      return Promise.reject(error);
    }

    if (error.response?.status === 401) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return axios(originalRequest);
        });
      }

      isRefreshing = true;
      originalRequest._retry = true;

      try {
        const authStore = useAuthStore();
        await authStore.refresh();
        processQueue(null, authStore.accessToken);
        originalRequest.headers.Authorization = `Bearer ${authStore.accessToken}`;
        return axios(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError);
        const authStore = useAuthStore();
        await authStore.logout();
        router.push({ name: 'login', query: { redirect: router.currentRoute.value.fullPath } });
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default axios;
```

### File: `frontend/src/router/index.js` (auth guard additions)

```javascript
// Add to existing router setup:

router.beforeEach(async (to, from, next) => {
  const authStore = useAuthStore();

  // Wait for initial auth check to complete
  if (!authStore.isInitialized) {
    await authStore.initialize();
  }

  // Public routes (login page)
  if (to.meta.public) {
    // Redirect to dashboard if already authenticated
    if (authStore.isAuthenticated) {
      return next({ name: 'dashboard' });
    }
    return next();
  }

  // Protected routes — redirect to login if not authenticated
  if (!authStore.isAuthenticated) {
    return next({ name: 'login', query: { redirect: to.fullPath } });
  }

  // Role-based route protection
  if (to.meta.requiredRole) {
    const ROLE_HIERARCHY = ['analyst', 'senior_analyst', 'compliance_officer', 'admin'];
    const userLevel = ROLE_HIERARCHY.indexOf(authStore.userRole);
    const requiredLevel = ROLE_HIERARCHY.indexOf(to.meta.requiredRole);
    if (userLevel < requiredLevel) {
      return next({ name: 'dashboard' }); // Redirect to dashboard if insufficient role
    }
  }

  next();
});
```

### File: `frontend/src/views/LoginView.vue`

```vue
<template>
  <div class="login-container">
    <div class="login-card">
      <h1>KYC Agent</h1>
      <p class="subtitle">Sign in to your account</p>

      <form @submit.prevent="handleLogin" novalidate>
        <div class="form-group">
          <label for="email">Email</label>
          <input
            id="email"
            v-model="email"
            type="email"
            placeholder="you@company.com"
            required
            :disabled="isLoading"
            autocomplete="email"
          />
          <span v-if="errors.email" class="error">{{ errors.email }}</span>
        </div>

        <div class="form-group">
          <label for="password">Password</label>
          <input
            id="password"
            v-model="password"
            type="password"
            placeholder="Enter your password"
            required
            :disabled="isLoading"
            autocomplete="current-password"
          />
          <span v-if="errors.password" class="error">{{ errors.password }}</span>
        </div>

        <span v-if="serverError" class="error server-error">{{ serverError }}</span>

        <button type="submit" :disabled="isLoading" class="login-btn">
          <span v-if="isLoading" class="spinner" />
          {{ isLoading ? 'Signing in...' : 'Sign in' }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const route = useRoute();
const authStore = useAuthStore();

const email = ref('');
const password = ref('');
const errors = ref({});
const serverError = ref('');
const isLoading = ref(false);

function validate() {
  errors.value = {};
  if (!email.value || !/\S+@\S+\.\S+/.test(email.value)) {
    errors.value.email = 'Valid email is required';
  }
  if (!password.value || password.value.length < 8) {
    errors.value.password = 'Password must be at least 8 characters';
  }
  return Object.keys(errors.value).length === 0;
}

async function handleLogin() {
  serverError.value = '';
  if (!validate()) return;

  isLoading.value = true;
  try {
    await authStore.login(email.value, password.value);
    const redirect = route.query.redirect || '/';
    router.push(redirect);
  } catch (err) {
    serverError.value = err.response?.data?.error?.message || 'Login failed. Please try again.';
  } finally {
    isLoading.value = false;
  }
}
</script>
```

### Route Configuration

```javascript
// Add to router routes array:
{
  path: '/login',
  name: 'login',
  component: () => import('@/views/LoginView.vue'),
  meta: { public: true },
},
```

### Navigation Header Changes

The existing `App.vue` or navigation component should conditionally show:
- **Authenticated**: User name, role badge, logout button
- **Unauthenticated**: Nothing (user is on login page)

```vue
<!-- In navigation component -->
<template v-if="isAuthenticated">
  <span class="user-name">{{ user.name }}</span>
  <span class="role-badge">{{ user.role }}</span>
  <button @click="handleLogout" class="logout-btn">Logout</button>
</template>
```

## Acceptance Criteria

- [ ] Login page renders at `/login` with email and password fields
- [ ] Client-side validation: email format, password >= 8 chars
- [ ] Validation errors displayed inline below fields
- [ ] Server error (invalid credentials) displayed above submit button
- [ ] Submit button disabled and shows spinner during login
- [ ] Successful login redirects to dashboard (`/`)
- [ ] Successful login stores user + accessToken in Pinia store (in-memory)
- [ ] Refresh token is NOT accessible via JavaScript (httpOnly cookie)
- [ ] All API requests include `Authorization: Bearer <token>` header
- [ ] 401 response triggers transparent token refresh + request retry
- [ ] If refresh fails, user is redirected to `/login`
- [ ] Unauthenticated users redirected to `/login` on any protected route
- [ ] `/login` redirects to `/` if user is already authenticated
- [ ] Intended route is remembered: `/cases/123` → login → redirect to `/cases/123`
- [ ] Logout clears Pinia state, calls backend logout, redirects to `/login`
- [ ] User name and role displayed in navigation header
- [ ] Login form has proper `autocomplete` attributes
- [ ] Login form is keyboard-navigable with proper labels
- [ ] No flash of protected content before auth check completes

## Dependencies

- **Depends on**: #5 (Frontend scaffold — Vue Router, Pinia, Vite), Auth Service (backend — `/api/v1/auth/*` endpoints)
- **Blocks**: None (all frontend views become auth-gated)

## Testing Strategy

1. **Login form render**: Mount LoginView, verify email + password fields + submit button present
2. **Client validation — empty email**: Submit empty form, verify "Valid email is required" error
3. **Client validation — invalid email**: Enter "notanemail", verify error
4. **Client validation — short password**: Enter 5-char password, verify error
5. **Login — success**: Mock POST /login 200, verify redirect to `/`
6. **Login — redirect**: Navigate to `/cases/123` unauthenticated, login, verify redirect to `/cases/123`
7. **Login — server error**: Mock POST /login 401, verify error message displayed
8. **Login — loading state**: Submit form, verify button disabled + spinner shown
9. **Auth store — login action**: Call `login()`, verify `user` and `accessToken` set
10. **Auth store — refresh action**: Call `refresh()`, verify new `accessToken` set
11. **Auth store — logout action**: Call `logout()`, verify state cleared
12. **Auth store — initialize**: Mock /refresh 200, call `initialize()`, verify user restored
13. **Auth store — initialize failure**: Mock /refresh 401, call `initialize()`, verify state stays null
14. **Axios interceptor — adds token**: Set accessToken in store, make request, verify Authorization header
15. **Axios interceptor — 401 refresh**: Mock 401 then refresh success, verify original request retried
16. **Axios interceptor — refresh failure**: Mock 401 then refresh 401, verify redirect to login
17. **Router guard — unauthenticated**: Navigate to `/`, verify redirect to `/login`
18. **Router guard — authenticated**: Set auth state, navigate to `/login`, verify redirect to `/`
19. **Logout button**: Click logout, verify store cleared + redirected to `/login`
20. **Navigation header**: Verify user name + role displayed when authenticated
