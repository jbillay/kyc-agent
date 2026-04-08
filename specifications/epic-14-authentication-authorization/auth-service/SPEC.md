# Auth Service and JWT Implementation

> GitHub Issue: TBD (see EPIC [#67](https://github.com/jbillay/kyc-agent/issues/67))
> Epic: Authentication & Authorization (#67)
> Size: M (3-5 days) | Priority: Critical

## Context

The Auth Service provides the backend foundation for all authentication in the KYC Agent platform. It handles user credential verification (bcrypt), JWT token issuance (access + refresh), token verification, and user management. All other auth components — the RBAC middleware (#70) and the frontend login flow (#69) — depend on this service.

The service exposes four API endpoints under `/api/v1/auth` and an `AuthService` class consumed by the RBAC middleware for JWT verification.

## Requirements

### Functional

1. `POST /api/v1/auth/login` — authenticate with email + password, return access token + set refresh token cookie
2. `POST /api/v1/auth/refresh` — exchange valid refresh token (from httpOnly cookie) for new access token
3. `GET /api/v1/auth/me` — return current user profile (requires valid access token)
4. `POST /api/v1/auth/logout` — invalidate refresh token, clear cookie
5. Passwords hashed with bcrypt (cost factor 12)
6. Access tokens: JWT, 15-minute expiry, contain `{ sub: userId, email, name, role }`
7. Refresh tokens: opaque random string, 7-day expiry, stored in database
8. Default admin user seeded during database initialization
9. `last_login_at` updated on successful login
10. Failed login attempts do not reveal whether email exists (constant-time comparison)

### Non-Functional

- Login endpoint responds within 500ms (bcrypt is intentionally slow)
- Token verification completes within 5ms (symmetric JWT)
- Refresh tokens stored hashed in database (not plaintext)

## Technical Design

### File: `backend/src/services/auth-service.js`

```javascript
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

/**
 * Authentication service — handles credentials, JWT issuance, and token lifecycle.
 *
 * @param {Object} deps
 * @param {import('pg').Pool} deps.db
 * @param {string} deps.jwtSecret
 */
class AuthService {
  constructor({ db, jwtSecret }) {
    this.db = db;
    this.jwtSecret = jwtSecret;
  }

  /**
   * Authenticate user by email + password.
   *
   * @param {string} email
   * @param {string} password
   * @returns {Promise<{ accessToken: string, refreshToken: string, user: Object }>}
   * @throws {Error} INVALID_CREDENTIALS
   */
  async login(email, password) {
    const result = await this.db.query(
      'SELECT id, email, name, role, password_hash, is_active FROM users WHERE email = $1',
      [email]
    );

    const user = result.rows[0];

    // Constant-time: always compare even if user not found
    const hash = user ? user.password_hash : '$2b$12$invalidhashfortimingggggggggggggggggggggggggggg';
    const valid = await bcrypt.compare(password, hash);

    if (!user || !valid || !user.is_active) {
      throw Object.assign(new Error('Invalid email or password'), {
        code: 'INVALID_CREDENTIALS',
        statusCode: 401,
      });
    }

    const accessToken = this._signAccessToken(user);
    const refreshToken = await this._createRefreshToken(user.id);

    // Update last login
    await this.db.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    return {
      accessToken,
      refreshToken,
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    };
  }

  /**
   * Verify and decode a JWT access token.
   *
   * @param {string} token
   * @returns {{ sub: string, email: string, name: string, role: string }}
   * @throws {Error} TOKEN_EXPIRED, TOKEN_INVALID
   */
  verifyAccessToken(token) {
    try {
      return jwt.verify(token, this.jwtSecret);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        throw Object.assign(new Error('Access token expired'), {
          code: 'TOKEN_EXPIRED',
          statusCode: 401,
        });
      }
      throw Object.assign(new Error('Invalid access token'), {
        code: 'TOKEN_INVALID',
        statusCode: 401,
      });
    }
  }

  /**
   * Refresh an access token using a valid refresh token.
   *
   * @param {string} refreshToken
   * @returns {Promise<{ accessToken: string, user: Object }>}
   * @throws {Error} INVALID_REFRESH_TOKEN
   */
  async refresh(refreshToken) {
    const tokenHash = this._hashToken(refreshToken);

    const result = await this.db.query(
      `SELECT rt.user_id, u.email, u.name, u.role, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.expires_at > NOW()`,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      throw Object.assign(new Error('Invalid or expired refresh token'), {
        code: 'INVALID_REFRESH_TOKEN',
        statusCode: 401,
      });
    }

    const user = result.rows[0];
    if (!user.is_active) {
      throw Object.assign(new Error('Account is deactivated'), {
        code: 'ACCOUNT_DEACTIVATED',
        statusCode: 401,
      });
    }

    const accessToken = this._signAccessToken({
      id: user.user_id,
      email: user.email,
      name: user.name,
      role: user.role,
    });

    return {
      accessToken,
      user: { id: user.user_id, email: user.email, name: user.name, role: user.role },
    };
  }

  /**
   * Invalidate a refresh token (logout).
   *
   * @param {string} refreshToken
   */
  async logout(refreshToken) {
    const tokenHash = this._hashToken(refreshToken);
    await this.db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
  }

  /**
   * Hash a plaintext password.
   *
   * @param {string} password
   * @returns {Promise<string>}
   */
  async hashPassword(password) {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  /**
   * Get user by ID.
   *
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async getUserById(userId) {
    const result = await this.db.query(
      'SELECT id, email, name, role, is_active, created_at, last_login_at FROM users WHERE id = $1',
      [userId]
    );
    return result.rows[0] || null;
  }

  // ─── Internal helpers ─────────────────────────────

  _signAccessToken(user) {
    return jwt.sign(
      { sub: user.id, email: user.email, name: user.name, role: user.role },
      this.jwtSecret,
      { expiresIn: ACCESS_TOKEN_EXPIRY }
    );
  }

  async _createRefreshToken(userId) {
    const token = crypto.randomBytes(64).toString('hex');
    const tokenHash = this._hashToken(token);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    await this.db.query(
      'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [userId, tokenHash, expiresAt]
    );

    return token;
  }

  _hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}

module.exports = { AuthService };
```

### File: `backend/src/api/auth.js`

```javascript
/**
 * Auth API routes — /api/v1/auth
 *
 * These routes are NOT protected by the auth middleware (they are the entry point).
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {Object} deps
 * @param {import('../services/auth-service').AuthService} deps.authService
 */
async function authRoutes(app, { authService }) {
  // ─── POST /api/v1/auth/login ──────────────────────
  app.post(
    '/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            password: { type: 'string', minLength: 8 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { email, password } = request.body;

      const { accessToken, refreshToken, user } = await authService.login(email, password);

      // Set refresh token as httpOnly cookie
      reply.setCookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/api/v1/auth/refresh',
        maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
      });

      return reply.send({ accessToken, user });
    }
  );

  // ─── POST /api/v1/auth/refresh ────────────────────
  app.post('/auth/refresh', async (request, reply) => {
    const refreshToken = request.cookies?.refreshToken;

    if (!refreshToken) {
      return reply.status(401).send({
        error: { code: 'NO_REFRESH_TOKEN', message: 'No refresh token provided' },
      });
    }

    const { accessToken, user } = await authService.refresh(refreshToken);
    return reply.send({ accessToken, user });
  });

  // ─── GET /api/v1/auth/me ──────────────────────────
  // This route IS protected — requires valid access token
  app.get(
    '/auth/me',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const user = await authService.getUserById(request.user.sub);
      if (!user) {
        return reply.status(404).send({
          error: { code: 'USER_NOT_FOUND', message: 'User not found' },
        });
      }
      return reply.send({ user });
    }
  );

  // ─── POST /api/v1/auth/logout ─────────────────────
  app.post('/auth/logout', async (request, reply) => {
    const refreshToken = request.cookies?.refreshToken;

    if (refreshToken) {
      await authService.logout(refreshToken);
    }

    reply.clearCookie('refreshToken', { path: '/api/v1/auth/refresh' });
    return reply.send({ success: true });
  });
}

module.exports = { authRoutes };
```

### Database Changes

The `users` table already exists in `init.sql`. Add a `refresh_tokens` table and seed the default admin:

```sql
-- Refresh tokens table
CREATE TABLE refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

-- Cleanup expired tokens periodically
-- (can be triggered by a cron or on login)

-- Default admin user (password: "admin123!" — MUST be changed on first login)
INSERT INTO users (email, name, role, password_hash, is_active) VALUES (
    'admin@kyc-agent.local',
    'System Administrator',
    'admin',
    -- bcrypt hash of 'admin123!' with cost 12
    '$2b$12$LJ3m4ys3Gkl6Ro9L5rN0dOQDhVt1rl3V3q.2qZOe8jF5GQo3sBK3.',
    true
);
```

### API Endpoint Summary

| Method | Endpoint | Purpose | Auth Required |
|--------|----------|---------|---------------|
| `POST` | `/api/v1/auth/login` | Authenticate, get tokens | No |
| `POST` | `/api/v1/auth/refresh` | Refresh access token | No (uses cookie) |
| `GET` | `/api/v1/auth/me` | Get current user profile | Yes |
| `POST` | `/api/v1/auth/logout` | Invalidate refresh token | No (uses cookie) |

### Error Response Format

| Error Code | HTTP Status | When |
|-----------|-------------|------|
| `INVALID_CREDENTIALS` | 401 | Wrong email or password, or inactive account |
| `TOKEN_EXPIRED` | 401 | Access token has expired |
| `TOKEN_INVALID` | 401 | Malformed or tampered access token |
| `INVALID_REFRESH_TOKEN` | 401 | Refresh token not found or expired |
| `ACCOUNT_DEACTIVATED` | 401 | User account is deactivated |
| `NO_REFRESH_TOKEN` | 401 | Refresh cookie not present |
| `USER_NOT_FOUND` | 404 | User ID in token no longer exists |
| `VALIDATION_ERROR` | 400 | JSON Schema validation fails |

## Acceptance Criteria

- [ ] `POST /login` returns `{ accessToken, user }` on valid credentials
- [ ] `POST /login` sets httpOnly refresh token cookie
- [ ] `POST /login` returns 401 with `INVALID_CREDENTIALS` for wrong email or password
- [ ] `POST /login` returns 401 for deactivated accounts (`is_active = false`)
- [ ] Failed login does not reveal whether email exists (constant-time comparison)
- [ ] `POST /login` updates `last_login_at` on success
- [ ] Access tokens expire after 15 minutes
- [ ] Refresh tokens expire after 7 days
- [ ] `POST /refresh` returns new access token for valid refresh cookie
- [ ] `POST /refresh` returns 401 for expired or invalid refresh token
- [ ] `GET /me` returns user profile for valid access token
- [ ] `GET /me` returns 401 for expired/invalid token
- [ ] `POST /logout` invalidates refresh token and clears cookie
- [ ] Passwords are hashed with bcrypt cost factor 12
- [ ] Refresh tokens are stored hashed (SHA-256) in database, not plaintext
- [ ] Default admin user is seeded on database initialization
- [ ] All endpoints validated with Fastify JSON Schema
- [ ] Consistent error format: `{ error: { code, message } }`

## Dependencies

- **Depends on**: #3 (Database — users table), #4 (Backend scaffold — Fastify app)
- **Blocks**: #70 (RBAC middleware — needs `verifyAccessToken`), #69 (Login frontend — needs auth API endpoints)

## Testing Strategy

1. **Login — success**: POST valid email/password, verify accessToken + refreshToken cookie + user object
2. **Login — wrong password**: POST valid email + wrong password, verify 401 + INVALID_CREDENTIALS
3. **Login — wrong email**: POST non-existent email, verify 401 + INVALID_CREDENTIALS (same error)
4. **Login — inactive user**: Deactivate user, attempt login, verify 401
5. **Login — timing**: Compare response times for valid-email-wrong-password vs invalid-email, verify similar
6. **Login — last_login_at**: Login, verify `last_login_at` updated in database
7. **Token verification**: Sign token, verify `verifyAccessToken` returns correct payload
8. **Token expired**: Create token with -1s expiry, verify TOKEN_EXPIRED error
9. **Token tampered**: Modify JWT payload, verify TOKEN_INVALID error
10. **Refresh — success**: Login, use refresh token cookie, verify new access token returned
11. **Refresh — expired**: Create expired refresh token, verify 401
12. **Refresh — missing cookie**: POST /refresh without cookie, verify 401 + NO_REFRESH_TOKEN
13. **Refresh — deactivated user**: Login, deactivate user, attempt refresh, verify 401
14. **Logout**: Login, logout, attempt refresh with same token, verify 401
15. **Me — success**: Login, GET /me with access token, verify user profile
16. **Me — no token**: GET /me without Authorization header, verify 401
17. **Password hashing**: Hash password, verify bcrypt.compare works correctly
18. **Refresh token storage**: After login, verify token_hash in DB is SHA-256, not plaintext
