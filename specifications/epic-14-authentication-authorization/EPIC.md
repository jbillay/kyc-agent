# EPIC: Authentication & Authorization

> GitHub Issue: [#67](https://github.com/jbillay/kyc-agent/issues/67)
> Milestone: Phase 3 — Review & Polish
> Labels: `epic`, `auth`

## Overview

JWT-based authentication with role-based access control (RBAC) for the KYC Agent platform. This epic secures all API endpoints and frontend routes, ensuring that users authenticate with email/password credentials and that every request is authorized against a four-tier role hierarchy: `analyst`, `senior_analyst`, `compliance_officer`, and `admin`.

The auth system is a prerequisite for the human review workflow (#61), where reviewer identity and role determine case assignment, review permissions, and escalation paths. It also gates the configuration API (compliance officers only) and admin API (admins only).

The implementation follows the architecture document (section 6.5): JWT tokens issued on login, validated via Fastify preHandler hooks, with role-based permission checks on every protected endpoint.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| — | Auth service and JWT implementation | M | Critical | `auth-service/` |
| #69 | Login page and auth flow in frontend | M | Critical | `login-frontend/` |
| #70 | Role-based access control middleware | M | Critical | `rbac-middleware/` |

> **Note**: The Auth Service story does not yet have a dedicated GitHub issue. It provides the backend foundation (JWT issuance, password hashing, user lookup) that the RBAC middleware and frontend login depend on. Consider creating a tracking issue for it.

## Dependency Map

```
Auth Service (backend) ────────────────────────────┐
    (JWT sign/verify, bcrypt password hashing,     │
     user CRUD, token refresh)                      │
    │                                              │
    ├──► #70 RBAC Middleware ──────────────────────┤
    │    (Fastify preHandler hook,                 │
    │     role hierarchy enforcement,               │
    │     permission checks per endpoint)           │
    │                                              │
    └──► #69 Login Frontend ──────────────────────┘
         (login page, Pinia auth store,
          axios interceptor, route guards,
          token refresh, logout)

Recommended implementation order:
  1. Auth service (backend foundation)
  2. #70 RBAC middleware (depends on auth service for JWT verification)
  3. #69 Login frontend (depends on auth API endpoints + RBAC middleware)
```

## External Dependencies

```
Infrastructure (#1):
  └── #3 Database             ← users table (id, email, name, role, password_hash, is_active)

Backend Scaffold (#1):
  └── #4 Backend Scaffold     ← Fastify app instance, plugin registration

Frontend Scaffold (#1):
  └── #5 Frontend Scaffold    ← Vue Router, Pinia, Axios setup

Case Management API (#33):
  └── #34 Cases CRUD          ← endpoints to protect with auth
  └── #36 WebSocket Events    ← authenticated WebSocket connections

Human Review Workflow (#61):
  └── Review API              ← RBAC for reviewer assignment and permissions
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 6.5 — Authentication & Authorization (role hierarchy, permissions per role)
- Section 7.2 — API Endpoint Groups (admin/audit API requires auth)
- Section 9 — Database Schema (`users` table definition)
- Section 11 — File Tree (`auth-service.js`, `auth.js` API, `auth.js` store, `useAuth.js` composable, `LoginView.vue`)

## File Layout

```
backend/src/services/
└── auth-service.js              # AuthService class (login, register, verify, refresh)

backend/src/api/
└── auth.js                      # Auth API routes (/api/v1/auth/login, /refresh, /me, /logout)

backend/src/middleware/
└── auth-middleware.js            # Fastify preHandler: JWT validation + role check

frontend/src/views/
└── LoginView.vue                # /login page

frontend/src/stores/
└── auth.js                      # Pinia auth store (token, user, login/logout actions)

frontend/src/composables/
└── useAuth.js                   # Auth composable (current user, role checks)

frontend/src/router/
└── index.js                     # Navigation guards (updated with auth checks)
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Token type | JWT (access + refresh) | Stateless verification, no session store needed; refresh tokens for long sessions |
| Token storage (frontend) | httpOnly cookie for refresh token, in-memory for access token | Prevents XSS access to tokens; refresh via secure cookie |
| Password hashing | bcrypt (cost factor 12) | Industry standard, resistant to GPU attacks |
| Role model | Hierarchical (admin > compliance_officer > senior_analyst > analyst) | Higher roles inherit all lower-role permissions; simplifies checks |
| Default admin user | Seeded in init.sql | Ensures first login is possible after fresh deployment |
| Token expiry | Access: 15 minutes, Refresh: 7 days | Short-lived access tokens limit exposure; refresh provides UX convenience |
| RBAC enforcement | Fastify preHandler hook | Runs before every route handler; consistent, centralized check |

## Role Hierarchy & Permissions

```
admin (all permissions)
  └── users:manage, system:configure, providers:configure
      └── compliance_officer (inherits admin minus system ops)
          └── rules:read, rules:modify, reports:generate, audit:read
              └── senior_analyst (inherits compliance_officer minus rules/audit)
                  └── cases:review_any, cases:escalate, cases:override_risk
                      └── analyst (base role)
                          └── cases:read, cases:review_assigned, documents:upload, documents:read
```

## Definition of Done

- [ ] Auth service: login, register, verify JWT, refresh token, logout
- [ ] Passwords hashed with bcrypt (cost factor 12)
- [ ] JWT access tokens (15 min expiry) + refresh tokens (7 day expiry)
- [ ] Auth API: POST /login, POST /refresh, GET /me, POST /logout
- [ ] Default admin user seeded in database
- [ ] Fastify preHandler middleware validates JWT on all protected routes
- [ ] Role hierarchy enforced: admin > compliance_officer > senior_analyst > analyst
- [ ] Permission checks on all API endpoint groups per architecture section 6.5
- [ ] 401 returned for missing/invalid/expired tokens
- [ ] 403 returned for insufficient role permissions
- [ ] Login page at `/login` with email/password form
- [ ] Pinia auth store manages user state and tokens
- [ ] Axios interceptor adds JWT to all API requests
- [ ] Automatic token refresh on 401 response
- [ ] Vue Router navigation guards redirect unauthenticated users to `/login`
- [ ] Logout clears tokens and redirects to login
- [ ] User name and role displayed in navigation header
- [ ] WebSocket connections authenticated with JWT
