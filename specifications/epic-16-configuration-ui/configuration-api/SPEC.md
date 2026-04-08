# Configuration API Endpoints

> GitHub Issue: [#76](https://github.com/jbillay/kyc-agent/issues/76)
> Epic: Configuration UI (#75)
> Size: M (1-3 days) | Priority: High

## Context

The Configuration API provides backend endpoints for reading and updating the platform's YAML-based configuration files (risk rules, LLM settings, data sources) and managing users and system health. This is the backend foundation that the admin configuration views (#77) depend on.

Currently, configuration lives in YAML files (`config/risk-rules.yaml`, `config/llm.yaml`, `config/data-sources.yaml`, `config/screening-sources.yaml`) loaded at startup. This API adds the ability to read and update these files at runtime with validation and hot-reload — no service restart required.

All configuration changes are logged as `config_change` events in the immutable event store for audit compliance. API keys are never returned in GET responses to prevent accidental exposure.

## Requirements

### Functional

1. `GET /api/v1/config/risk-rules` — return current risk rules as parsed JSON
2. `PUT /api/v1/config/risk-rules` — validate, write to YAML file, hot-reload rule engine
3. `GET /api/v1/config/llm` — return LLM configuration with API keys redacted
4. `PUT /api/v1/config/llm` — validate, write to YAML file, hot-reload LLM service
5. `GET /api/v1/config/data-sources` — return data source configuration with API keys redacted
6. `PUT /api/v1/config/data-sources` — validate, write to YAML file, hot-reload data source registry
7. `POST /api/v1/config/llm/test` — test LLM provider connection (send a simple prompt, return success/failure and latency)
8. `POST /api/v1/config/screening/sync` — trigger an immediate screening list sync job via BullMQ
9. `GET /api/v1/admin/users` — list all users (exclude password hashes)
10. `POST /api/v1/admin/users` — create a new user (hash password with bcrypt)
11. `PATCH /api/v1/admin/users/:id` — update user role or active status
12. `GET /api/v1/admin/system/health` — check connectivity to PostgreSQL, Redis, MinIO, Ollama
13. `GET /api/v1/admin/system/stats` — return BullMQ queue stats, disk usage, screening list counts
14. All config PUT endpoints log a `config_change` event with before/after diff, user ID, and timestamp
15. All endpoints require `admin` role via RBAC middleware
16. Validation prevents saving invalid configurations (schema validation before write)

### Non-Functional

- Config read endpoints respond within 50ms (read from in-memory cache, not disk)
- Config write endpoints respond within 500ms (validate, write, reload)
- Health check endpoint responds within 2s (allows time for service pings)
- API key redaction is applied at the API layer, never stored redacted

## Technical Design

### File: `backend/src/services/config-service.js`

```javascript
const fs = require('fs/promises');
const path = require('path');
const yaml = require('js-yaml');

const CONFIG_DIR = path.resolve(__dirname, '../../../config');

/**
 * Configuration service — reads, validates, writes, and hot-reloads YAML config files.
 *
 * @param {Object} deps
 * @param {import('./event-store').EventStore} deps.eventStore
 * @param {import('./rule-engine').RuleEngine} deps.ruleEngine
 * @param {import('../llm/llm-service').LLMService} deps.llmService
 */
class ConfigService {
  constructor({ eventStore, ruleEngine, llmService }) {
    this.eventStore = eventStore;
    this.ruleEngine = ruleEngine;
    this.llmService = llmService;
  }

  /**
   * Read a YAML config file and return parsed object.
   *
   * @param {string} filename - e.g., 'risk-rules.yaml'
   * @returns {Promise<Object>}
   */
  async readConfig(filename) {
    const filePath = path.join(CONFIG_DIR, filename);
    const content = await fs.readFile(filePath, 'utf-8');
    return yaml.load(content);
  }

  /**
   * Validate, write config, and trigger hot-reload.
   *
   * @param {string} filename - e.g., 'risk-rules.yaml'
   * @param {Object} config - new configuration object
   * @param {string} userId - ID of the admin making the change
   * @param {Function} validator - schema validation function, throws on invalid
   * @param {Function} reloader - hot-reload callback
   * @returns {Promise<void>}
   */
  async writeConfig(filename, config, userId, validator, reloader) {
    // Read current config for audit diff
    const previous = await this.readConfig(filename);

    // Validate new config
    validator(config);

    // Write to file
    const filePath = path.join(CONFIG_DIR, filename);
    const yamlContent = yaml.dump(config, { lineWidth: 120, noRefs: true });
    await fs.writeFile(filePath, yamlContent, 'utf-8');

    // Hot-reload
    await reloader(config);

    // Log config change event
    await this.eventStore.append({
      caseId: null,
      agentType: 'system',
      stepId: 'config_update',
      eventType: 'config_change',
      data: {
        filename,
        userId,
        previous,
        updated: config,
      },
    });
  }

  /**
   * Redact API keys from a config object (replace with '***').
   * Operates on known key patterns: api_key, apiKey, secret.
   *
   * @param {Object} config
   * @returns {Object} - deep copy with keys redacted
   */
  redactSecrets(config) {
    const redacted = JSON.parse(JSON.stringify(config));
    const sensitiveKeys = ['api_key', 'apiKey', 'secret', 'password'];

    const walk = (obj) => {
      for (const key of Object.keys(obj)) {
        if (sensitiveKeys.includes(key) && typeof obj[key] === 'string' && obj[key]) {
          obj[key] = '***';
        } else if (typeof obj[key] === 'object' && obj[key] !== null) {
          walk(obj[key]);
        }
      }
    };

    walk(redacted);
    return redacted;
  }
}

module.exports = { ConfigService };
```

### File: `backend/src/services/system-health-service.js`

```javascript
/**
 * System health service — checks connectivity to platform dependencies
 * and gathers system statistics.
 *
 * @param {Object} deps
 * @param {import('pg').Pool} deps.db
 * @param {import('ioredis').Redis} deps.redis
 * @param {import('minio').Client} deps.minio
 * @param {import('../llm/llm-service').LLMService} deps.llmService
 * @param {import('bullmq').Queue} deps.agentQueue
 */
class SystemHealthService {
  constructor({ db, redis, minio, llmService, agentQueue }) {
    this.db = db;
    this.redis = redis;
    this.minio = minio;
    this.llmService = llmService;
    this.agentQueue = agentQueue;
  }

  /**
   * Check connectivity to all platform services.
   *
   * @returns {Promise<Object>} - { services: { postgres, redis, minio, ollama } }
   */
  async checkHealth() {
    const checks = await Promise.allSettled([
      this._checkPostgres(),
      this._checkRedis(),
      this._checkMinio(),
      this._checkOllama(),
    ]);

    return {
      services: {
        postgres: this._toStatus(checks[0]),
        redis: this._toStatus(checks[1]),
        minio: this._toStatus(checks[2]),
        ollama: this._toStatus(checks[3]),
      },
    };
  }

  /**
   * Gather system statistics: queue counts, screening list info, user counts.
   *
   * @returns {Promise<Object>}
   */
  async getStats() {
    const [queueCounts, dbStats] = await Promise.all([
      this._getQueueStats(),
      this._getDbStats(),
    ]);

    return { queue: queueCounts, database: dbStats };
  }

  async _checkPostgres() {
    await this.db.query('SELECT 1');
  }

  async _checkRedis() {
    await this.redis.ping();
  }

  async _checkMinio() {
    await this.minio.listBuckets();
  }

  async _checkOllama() {
    const provider = this.llmService.getProvider('ollama');
    if (!provider) throw new Error('Ollama provider not configured');
    const available = await provider.isAvailable();
    if (!available) throw new Error('Ollama not reachable');
  }

  _toStatus(result) {
    return {
      status: result.status === 'fulfilled' ? 'healthy' : 'unhealthy',
      error: result.status === 'rejected' ? result.reason.message : null,
    };
  }

  async _getQueueStats() {
    const counts = await this.agentQueue.getJobCounts(
      'waiting', 'active', 'completed', 'failed', 'delayed'
    );
    return counts;
  }

  async _getDbStats() {
    const results = await Promise.all([
      this.db.query('SELECT COUNT(*) AS count FROM cases'),
      this.db.query('SELECT COUNT(*) AS count FROM users'),
      this.db.query('SELECT COUNT(*) AS count FROM screening_entries'),
      this.db.query(
        `SELECT list_name, entry_count, last_updated FROM screening_lists ORDER BY list_name`
      ),
    ]);

    return {
      totalCases: parseInt(results[0].rows[0].count, 10),
      totalUsers: parseInt(results[1].rows[0].count, 10),
      totalScreeningEntries: parseInt(results[2].rows[0].count, 10),
      screeningLists: results[3].rows,
    };
  }
}

module.exports = { SystemHealthService };
```

### File: `backend/src/api/config.js`

```javascript
/**
 * Configuration API routes — /api/v1/config
 *
 * All routes require admin role.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {Object} deps
 * @param {import('../services/config-service').ConfigService} deps.configService
 */
async function configRoutes(app, { configService }) {
  // ─── Risk Rules ────────────────────────────────────

  app.get(
    '/config/risk-rules',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const config = await configService.readConfig('risk-rules.yaml');
      return reply.send({ config });
    }
  );

  app.put(
    '/config/risk-rules',
    {
      preHandler: [app.authenticate, app.requireRole('admin')],
      schema: {
        body: {
          type: 'object',
          required: ['risk_rules'],
          properties: {
            risk_rules: {
              type: 'object',
              required: ['version', 'country_risk', 'industry_risk', 'ownership_risk', 'screening_risk', 'thresholds', 'review_routing'],
              properties: {
                version: { type: 'string' },
                country_risk: { type: 'object' },
                industry_risk: { type: 'object' },
                ownership_risk: { type: 'object' },
                screening_risk: { type: 'object' },
                thresholds: { type: 'object' },
                review_routing: { type: 'object' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      await configService.writeConfig(
        'risk-rules.yaml',
        request.body,
        request.user.sub,
        configService.ruleEngine.validateConfig.bind(configService.ruleEngine),
        configService.ruleEngine.reload.bind(configService.ruleEngine)
      );
      return reply.send({ success: true });
    }
  );

  // ─── LLM Configuration ────────────────────────────

  app.get(
    '/config/llm',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const config = await configService.readConfig('llm.yaml');
      return reply.send({ config: configService.redactSecrets(config) });
    }
  );

  app.put(
    '/config/llm',
    {
      preHandler: [app.authenticate, app.requireRole('admin')],
      schema: {
        body: {
          type: 'object',
          required: ['llm'],
          properties: {
            llm: {
              type: 'object',
              required: ['default_provider', 'providers', 'routing'],
              properties: {
                default_provider: { type: 'string' },
                providers: { type: 'object' },
                routing: { type: 'object' },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      await configService.writeConfig(
        'llm.yaml',
        request.body,
        request.user.sub,
        configService.llmService.validateConfig.bind(configService.llmService),
        configService.llmService.reload.bind(configService.llmService)
      );
      return reply.send({ success: true });
    }
  );

  // ─── LLM Test Connection ───────────────────────────

  app.post(
    '/config/llm/test',
    {
      preHandler: [app.authenticate, app.requireRole('admin')],
      schema: {
        body: {
          type: 'object',
          required: ['provider'],
          properties: {
            provider: { type: 'string' },
            model: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { provider, model } = request.body;
      try {
        const result = await configService.llmService.testConnection(provider, model);
        return reply.send({ success: true, ...result });
      } catch (err) {
        return reply.status(502).send({
          error: { code: 'LLM_CONNECTION_FAILED', message: err.message },
        });
      }
    }
  );

  // ─── Data Sources ──────────────────────────────────

  app.get(
    '/config/data-sources',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const config = await configService.readConfig('data-sources.yaml');
      return reply.send({ config: configService.redactSecrets(config) });
    }
  );

  app.put(
    '/config/data-sources',
    {
      preHandler: [app.authenticate, app.requireRole('admin')],
      schema: {
        body: {
          type: 'object',
          required: ['data_sources'],
          properties: {
            data_sources: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      await configService.writeConfig(
        'data-sources.yaml',
        request.body,
        request.user.sub,
        (config) => { /* data source schema validation */ },
        async (config) => { /* reload data source registry */ }
      );
      return reply.send({ success: true });
    }
  );
  // ─── Screening Sync ────────────────────────────────

  app.post(
    '/config/screening/sync',
    {
      preHandler: [app.authenticate, app.requireRole('admin')],
    },
    async (request, reply) => {
      try {
        const jobId = await configService.triggerScreeningSync();
        return reply.status(202).send({
          jobId,
          message: 'Screening list sync triggered. Check BullMQ dashboard for progress.',
        });
      } catch (err) {
        return reply.status(500).send({
          error: { code: 'SYNC_TRIGGER_FAILED', message: err.message },
        });
      }
    }
  );
}

module.exports = { configRoutes };
```

### File: `backend/src/api/admin.js`

```javascript
const { AuthService } = require('../services/auth-service');

/**
 * Admin API routes — /api/v1/admin
 *
 * All routes require admin role.
 *
 * @param {import('fastify').FastifyInstance} app
 * @param {Object} deps
 * @param {import('../services/auth-service').AuthService} deps.authService
 * @param {import('../services/system-health-service').SystemHealthService} deps.systemHealthService
 * @param {import('pg').Pool} deps.db
 */
async function adminRoutes(app, { authService, systemHealthService, db }) {
  // ─── User Management ──────────────────────────────

  app.get(
    '/admin/users',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const result = await db.query(
        'SELECT id, email, name, role, is_active, created_at, last_login_at FROM users ORDER BY created_at DESC'
      );
      return reply.send({ users: result.rows });
    }
  );

  app.post(
    '/admin/users',
    {
      preHandler: [app.authenticate, app.requireRole('admin')],
      schema: {
        body: {
          type: 'object',
          required: ['email', 'name', 'role', 'password'],
          properties: {
            email: { type: 'string', format: 'email' },
            name: { type: 'string', minLength: 1, maxLength: 255 },
            role: { type: 'string', enum: ['analyst', 'senior_analyst', 'compliance_officer', 'admin'] },
            password: { type: 'string', minLength: 8 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const { email, name, role, password } = request.body;
      const passwordHash = await authService.hashPassword(password);

      const result = await db.query(
        `INSERT INTO users (email, name, role, password_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, email, name, role, is_active, created_at`,
        [email, name, role, passwordHash]
      );

      return reply.status(201).send({ user: result.rows[0] });
    }
  );

  app.patch(
    '/admin/users/:id',
    {
      preHandler: [app.authenticate, app.requireRole('admin')],
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            role: { type: 'string', enum: ['analyst', 'senior_analyst', 'compliance_officer', 'admin'] },
            is_active: { type: 'boolean' },
          },
          additionalProperties: false,
          minProperties: 1,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const updates = request.body;

      const setClauses = [];
      const values = [];
      let paramIdx = 1;

      if (updates.role !== undefined) {
        setClauses.push(`role = $${paramIdx++}`);
        values.push(updates.role);
      }
      if (updates.is_active !== undefined) {
        setClauses.push(`is_active = $${paramIdx++}`);
        values.push(updates.is_active);
      }

      values.push(id);
      const result = await db.query(
        `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${paramIdx}
         RETURNING id, email, name, role, is_active, created_at, last_login_at`,
        values
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          error: { code: 'USER_NOT_FOUND', message: 'User not found' },
        });
      }

      return reply.send({ user: result.rows[0] });
    }
  );

  // ─── System Health & Stats ─────────────────────────

  app.get(
    '/admin/system/health',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const health = await systemHealthService.checkHealth();
      return reply.send(health);
    }
  );

  app.get(
    '/admin/system/stats',
    { preHandler: [app.authenticate, app.requireRole('admin')] },
    async (request, reply) => {
      const stats = await systemHealthService.getStats();
      return reply.send(stats);
    }
  );
}

module.exports = { adminRoutes };
```

### API Endpoint Summary

| Method | Endpoint | Purpose | Auth |
|--------|----------|---------|------|
| `GET` | `/api/v1/config/risk-rules` | Get current risk rules | admin |
| `PUT` | `/api/v1/config/risk-rules` | Update risk rules (validate + hot-reload) | admin |
| `GET` | `/api/v1/config/llm` | Get LLM config (API keys redacted) | admin |
| `PUT` | `/api/v1/config/llm` | Update LLM config (validate + hot-reload) | admin |
| `POST` | `/api/v1/config/llm/test` | Test LLM provider connection | admin |
| `GET` | `/api/v1/config/data-sources` | Get data source config (API keys redacted) | admin |
| `PUT` | `/api/v1/config/data-sources` | Update data source config (validate + hot-reload) | admin |
| `POST` | `/api/v1/config/screening/sync` | Trigger screening list sync | admin |
| `GET` | `/api/v1/admin/users` | List all users | admin |
| `POST` | `/api/v1/admin/users` | Create new user | admin |
| `PATCH` | `/api/v1/admin/users/:id` | Update user role/status | admin |
| `GET` | `/api/v1/admin/system/health` | Service connectivity check | admin |
| `GET` | `/api/v1/admin/system/stats` | Queue, storage, screening stats | admin |

### Error Response Format

| Error Code | HTTP Status | When |
|-----------|-------------|------|
| `VALIDATION_ERROR` | 400 | Config fails schema validation |
| `INVALID_CONFIG` | 400 | Config is syntactically valid but semantically invalid (e.g., unknown provider) |
| `DUPLICATE_EMAIL` | 409 | User creation with existing email |
| `USER_NOT_FOUND` | 404 | PATCH to non-existent user ID |
| `CONFIG_WRITE_FAILED` | 500 | File system write error |
| `RELOAD_FAILED` | 500 | Hot-reload failed (config written but not active) |

### Hot-Reload Mechanism

```
PUT /api/v1/config/risk-rules
    │
    ├─ 1. Read current config (for audit diff)
    ├─ 2. Validate new config (JSON Schema + business rules)
    ├─ 3. Write YAML to disk
    ├─ 4. Call ruleEngine.reload(newConfig)
    │      └─ replaces in-memory rules
    ├─ 5. Log config_change event to event store
    └─ 6. Return { success: true }

On reload failure:
    └─ Restore previous YAML file
    └─ Return 500 with RELOAD_FAILED
```

## Acceptance Criteria

- [ ] `GET /api/v1/config/risk-rules` returns current risk rules as parsed JSON
- [ ] `PUT /api/v1/config/risk-rules` validates input and rejects invalid schemas with 400
- [ ] `PUT /api/v1/config/risk-rules` writes YAML file and hot-reloads rule engine
- [ ] `GET /api/v1/config/llm` returns LLM config with API keys replaced by `'***'`
- [ ] `PUT /api/v1/config/llm` validates and updates LLM configuration
- [ ] `GET /api/v1/config/data-sources` returns data source config with secrets redacted
- [ ] `PUT /api/v1/config/data-sources` validates and updates data source configuration
- [ ] `GET /api/v1/admin/users` returns user list without password hashes
- [ ] `POST /api/v1/admin/users` creates user with bcrypt-hashed password, returns 201
- [ ] `POST /api/v1/admin/users` returns 409 for duplicate email
- [ ] `PATCH /api/v1/admin/users/:id` updates role and/or active status
- [ ] `PATCH /api/v1/admin/users/:id` returns 404 for non-existent user
- [ ] `GET /api/v1/admin/system/health` returns status for postgres, redis, minio, ollama
- [ ] `GET /api/v1/admin/system/stats` returns queue counts and database statistics
- [ ] All endpoints require `admin` role — non-admin users receive 403
- [ ] All config changes logged as `config_change` events in event store
- [ ] Config write failure restores previous YAML file
- [ ] All request bodies validated with Fastify JSON Schema
- [ ] Consistent error format: `{ error: { code, message } }`

## Dependencies

- **Depends on**: #3 (Database), #4 (Backend scaffold), #12 (YAML config loader), #25 (Event store), #70 (RBAC middleware), Auth Service
- **Blocks**: #77 (Admin configuration views — all frontend tabs depend on these endpoints)

## Testing Strategy

1. **Risk rules — read**: GET /config/risk-rules, verify returns valid risk rules object
2. **Risk rules — update**: PUT valid risk rules, verify YAML file updated, rule engine reloaded
3. **Risk rules — invalid**: PUT with missing required fields, verify 400 + VALIDATION_ERROR
4. **Risk rules — audit**: PUT valid rules, verify `config_change` event logged with before/after
5. **LLM config — read redacted**: GET /config/llm, verify API keys are `'***'` not plaintext
6. **LLM config — update**: PUT valid LLM config, verify YAML updated, LLM service reloaded
7. **Data sources — read redacted**: GET /config/data-sources, verify secrets redacted
8. **Data sources — update**: PUT valid config, verify file updated
9. **User list**: GET /admin/users, verify returns all users without password_hash field
10. **User create — success**: POST valid user, verify 201, verify password hashed in DB
11. **User create — duplicate email**: POST existing email, verify 409
12. **User update — role change**: PATCH role to senior_analyst, verify updated
13. **User update — deactivate**: PATCH is_active to false, verify deactivated user cannot login
14. **User update — not found**: PATCH non-existent UUID, verify 404
15. **System health — all healthy**: Verify all services return `healthy` status
16. **System health — service down**: Stop Redis, verify redis returns `unhealthy` with error
17. **System stats**: Verify queue counts and database stats match actual state
18. **RBAC — admin only**: Call config endpoints as analyst, verify 403 Forbidden
19. **RBAC — unauthenticated**: Call config endpoints without token, verify 401
20. **Hot-reload failure**: Mock reload to throw, verify previous config restored, 500 returned
