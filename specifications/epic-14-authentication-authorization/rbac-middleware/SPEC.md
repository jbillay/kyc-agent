# Role-Based Access Control Middleware

> GitHub Issue: [#70](https://github.com/jbillay/kyc-agent/issues/70)
> Epic: Authentication & Authorization (#67)
> Size: M (3-5 days) | Priority: Critical

## Context

All API endpoints (except `/api/v1/auth/*`) must be protected by authentication and role-based authorization. This story implements a Fastify preHandler hook that validates the JWT access token and checks the user's role against the required permission level for each endpoint.

The middleware provides two mechanisms:
1. **`app.authenticate`** — a Fastify decorator that verifies the JWT and populates `request.user`
2. **`requireRole(role)`** — a factory function that returns a preHandler checking the user's role against the required minimum role level

The role hierarchy is defined in the architecture (section 6.5):
`admin > compliance_officer > senior_analyst > analyst`

Higher roles inherit all permissions of lower roles.

## Requirements

### Functional

1. Fastify decorator `app.authenticate` — validates JWT from `Authorization: Bearer <token>` header, sets `request.user`
2. Factory function `requireRole(minimumRole)` — returns preHandler that checks `request.user.role` against the role hierarchy
3. Role hierarchy: `admin > compliance_officer > senior_analyst > analyst`
4. Return 401 for missing, malformed, expired, or invalid tokens
5. Return 403 for valid token but insufficient role
6. Apply authentication to all route groups per architecture:
   - Cases API: `analyst+`
   - Review API: `analyst+` (with assignment checks in handlers)
   - Configuration API: `admin`
   - Admin API: `admin`
   - Audit API: `compliance_officer+`
7. WebSocket connections authenticated via token in handshake query/auth
8. `request.user` shape: `{ id, sub, email, name, role }` (where `id` is an alias for `sub`)

### Non-Functional

- Middleware adds < 5ms latency per request (JWT verification is synchronous)
- No database queries in the hot path (JWT is self-contained)
- Clear, consistent error messages for auth failures

## Technical Design

### File: `backend/src/middleware/auth-middleware.js`

```javascript
/**
 * RBAC middleware for Fastify.
 *
 * Provides:
 *   - app.authenticate   — preHandler that verifies JWT and sets request.user
 *   - requireRole(role)  — factory returning preHandler for minimum role check
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {Object} deps
 * @param {import('../services/auth-service').AuthService} deps.authService
 */
async function authMiddleware(app, { authService }) {
  const ROLE_HIERARCHY = ['analyst', 'senior_analyst', 'compliance_officer', 'admin'];

  // ─── Decorator: request.user ───────────────────────

  app.decorateRequest('user', null);

  // ─── authenticate preHandler ───────────────────────

  app.decorate('authenticate', async function authenticate(request, reply) {
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({
        error: { code: 'MISSING_TOKEN', message: 'Authorization header with Bearer token is required' },
      });
    }

    const token = authHeader.slice(7);

    try {
      const payload = authService.verifyAccessToken(token);
      request.user = {
        id: payload.sub,
        sub: payload.sub,
        email: payload.email,
        name: payload.name,
        role: payload.role,
      };
    } catch (err) {
      return reply.status(401).send({
        error: { code: err.code || 'AUTH_FAILED', message: err.message },
      });
    }
  });

  // ─── requireRole factory ───────────────────────────

  app.decorate('requireRole', function requireRole(minimumRole) {
    const requiredLevel = ROLE_HIERARCHY.indexOf(minimumRole);

    if (requiredLevel === -1) {
      throw new Error(`Unknown role: ${minimumRole}`);
    }

    return async function checkRole(request, reply) {
      // authenticate must run first
      if (!request.user) {
        return reply.status(401).send({
          error: { code: 'NOT_AUTHENTICATED', message: 'Authentication required' },
        });
      }

      const userLevel = ROLE_HIERARCHY.indexOf(request.user.role);

      if (userLevel < requiredLevel) {
        return reply.status(403).send({
          error: {
            code: 'INSUFFICIENT_ROLE',
            message: `Role '${minimumRole}' or higher is required. Your role: '${request.user.role}'`,
          },
        });
      }
    };
  });
}

module.exports = { authMiddleware };
```

### Applying Middleware to Route Groups

```javascript
// In the main Fastify app setup (e.g., backend/src/app.js):

// Register auth middleware as a plugin
app.register(authMiddleware, { authService });

// Auth routes — NO authentication (entry point)
app.register(authRoutes, { prefix: '/api/v1', ...deps });

// Cases API — analyst+
app.register(async (scoped) => {
  scoped.addHook('preHandler', app.authenticate);
  scoped.addHook('preHandler', app.requireRole('analyst'));
  scoped.register(caseRoutes, deps);
}, { prefix: '/api/v1' });

// Review API — analyst+
app.register(async (scoped) => {
  scoped.addHook('preHandler', app.authenticate);
  scoped.addHook('preHandler', app.requireRole('analyst'));
  scoped.register(reviewRoutes, deps);
}, { prefix: '/api/v1' });

// Configuration API — admin only
app.register(async (scoped) => {
  scoped.addHook('preHandler', app.authenticate);
  scoped.addHook('preHandler', app.requireRole('admin'));
  scoped.register(configRoutes, deps);
}, { prefix: '/api/v1' });

// Admin API — admin only
app.register(async (scoped) => {
  scoped.addHook('preHandler', app.authenticate);
  scoped.addHook('preHandler', app.requireRole('admin'));
  scoped.register(adminRoutes, deps);
}, { prefix: '/api/v1' });

// Audit API — compliance_officer+
app.register(async (scoped) => {
  scoped.addHook('preHandler', app.authenticate);
  scoped.addHook('preHandler', app.requireRole('compliance_officer'));
  scoped.register(auditRoutes, deps);
}, { prefix: '/api/v1' });
```

### WebSocket Authentication

```javascript
// In WebSocket setup (backend/src/api/websocket.js):

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;

  if (!token) {
    return next(new Error('Authentication required'));
  }

  try {
    const payload = authService.verifyAccessToken(token);
    socket.user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
    };
    next();
  } catch (err) {
    next(new Error('Invalid or expired token'));
  }
});
```

### Permission Matrix

| API Group | Minimum Role | Endpoints |
|-----------|-------------|-----------|
| Auth | None | `/api/v1/auth/*` |
| Cases | `analyst` | `/api/v1/cases/*` |
| Review | `analyst` | `/api/v1/review/*` (assignment checks in handlers) |
| Configuration | `admin` | `/api/v1/config/*` |
| Audit | `compliance_officer` | `/api/v1/audit/*` |
| Admin | `admin` | `/api/v1/admin/*` |

### Error Response Format

| Error Code | HTTP Status | When |
|-----------|-------------|------|
| `MISSING_TOKEN` | 401 | No `Authorization: Bearer` header |
| `TOKEN_EXPIRED` | 401 | JWT has expired (from AuthService) |
| `TOKEN_INVALID` | 401 | Malformed or tampered JWT (from AuthService) |
| `NOT_AUTHENTICATED` | 401 | `requireRole` called without prior `authenticate` |
| `INSUFFICIENT_ROLE` | 403 | User's role is below required level |

## Acceptance Criteria

- [ ] `app.authenticate` extracts JWT from `Authorization: Bearer <token>` header
- [ ] `request.user` is populated with `{ id, sub, email, name, role }` after authentication
- [ ] 401 returned for missing Authorization header
- [ ] 401 returned for malformed token (not Bearer format)
- [ ] 401 returned for expired token with `TOKEN_EXPIRED` code
- [ ] 401 returned for tampered/invalid token with `TOKEN_INVALID` code
- [ ] `requireRole('analyst')` allows analyst, senior_analyst, compliance_officer, admin
- [ ] `requireRole('senior_analyst')` rejects analyst with 403
- [ ] `requireRole('compliance_officer')` rejects analyst and senior_analyst with 403
- [ ] `requireRole('admin')` rejects all except admin with 403
- [ ] 403 response includes user's actual role and required role in error message
- [ ] Cases API endpoints require `analyst+`
- [ ] Review API endpoints require `analyst+`
- [ ] Configuration API endpoints require `admin`
- [ ] Admin API endpoints require `admin`
- [ ] Audit API endpoints require `compliance_officer+`
- [ ] Auth API endpoints (`/auth/*`) are NOT protected
- [ ] WebSocket connections require valid JWT in handshake
- [ ] WebSocket rejects connections with invalid/missing token
- [ ] No database queries in authentication hot path (JWT only)
- [ ] Consistent error format: `{ error: { code, message } }`

## Dependencies

- **Depends on**: #4 (Backend scaffold — Fastify app), Auth Service (backend — `verifyAccessToken` method)
- **Blocks**: All protected API endpoints (Cases, Review, Config, Admin, Audit), WebSocket authentication

## Testing Strategy

1. **Authenticate — valid token**: Create valid JWT, call route, verify `request.user` populated
2. **Authenticate — no header**: Call route without Authorization, verify 401 + MISSING_TOKEN
3. **Authenticate — wrong scheme**: Send `Authorization: Basic xyz`, verify 401 + MISSING_TOKEN
4. **Authenticate — expired token**: Create expired JWT, verify 401 + TOKEN_EXPIRED
5. **Authenticate — invalid token**: Send garbage token, verify 401 + TOKEN_INVALID
6. **Authenticate — tampered token**: Modify JWT payload, verify 401 + TOKEN_INVALID
7. **requireRole — analyst calls analyst route**: Verify 200
8. **requireRole — admin calls analyst route**: Verify 200 (inheritance)
9. **requireRole — analyst calls admin route**: Verify 403 + INSUFFICIENT_ROLE
10. **requireRole — senior_analyst calls compliance route**: Verify 403
11. **requireRole — compliance_officer calls compliance route**: Verify 200
12. **requireRole — all four roles against admin endpoint**: Verify only admin gets 200
13. **Role hierarchy exhaustive**: Test each role against each minimum level, verify correct allow/deny
14. **Cases API — no auth**: Hit `/api/v1/cases` without token, verify 401
15. **Cases API — analyst**: Hit `/api/v1/cases` with analyst token, verify 200
16. **Config API — analyst**: Hit `/api/v1/config/risk-rules` with analyst token, verify 403
17. **Config API — admin**: Same endpoint with admin token, verify 200
18. **Admin API — compliance_officer**: Hit `/api/v1/admin/users` with compliance_officer, verify 403
19. **Admin API — admin**: Same endpoint with admin, verify 200
20. **WebSocket — valid token**: Connect with valid JWT in handshake, verify connection accepted
21. **WebSocket — no token**: Connect without token, verify connection rejected
22. **WebSocket — expired token**: Connect with expired JWT, verify connection rejected
23. **Error format**: Verify all auth errors follow `{ error: { code, message } }` shape
