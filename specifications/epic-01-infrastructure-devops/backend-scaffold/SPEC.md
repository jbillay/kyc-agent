# Backend Project Scaffold (Fastify)

> GitHub Issue: [#4](https://github.com/jbillay/kyc-agent/issues/4)
> Epic: Infrastructure & DevOps Setup (#1)
> Size: M (1-3 days) | Priority: Critical

## Context

The backend is a Node.js application built on Fastify, chosen for its performance (2x Express) and built-in JSON Schema validation. It serves as both the REST API and the host for WebSocket connections. The backend uses plain JavaScript with JSDoc type annotations for editor support, and Joi/Zod for runtime validation — no TypeScript compile step required.

## Requirements

### Functional

1. Fastify server starts and responds to a health check endpoint
2. Project directory structure matches the architecture document
3. All core dependencies are declared in `package.json`
4. CORS is configured for the frontend origin
5. Request logging is enabled
6. Structured error handling returns consistent error responses
7. Dockerfile enables containerized deployment

### Non-Functional

- CommonJS module system (`require`/`module.exports`) for maximum ecosystem compatibility
- Startup time under 3 seconds (excluding Docker build)
- Graceful shutdown on SIGTERM/SIGINT

## Technical Design

### Directory Structure

```
backend/
├── package.json
├── jsconfig.json
├── Dockerfile
├── .dockerignore
├── db/
│   ├── init.sql
│   ├── connection.js
│   ├── seed.js
│   └── migrations/
└── src/
    ├── index.js                    # Entry point — Fastify server setup
    ├── llm/
    │   ├── types.js
    │   ├── llm-service.js
    │   ├── providers/
    │   │   ├── ollama.js
    │   │   ├── vllm.js
    │   │   ├── openai-compatible.js
    │   │   ├── anthropic.js
    │   │   └── openai.js
    │   └── prompt-adapters/
    │       ├── mistral.js
    │       ├── llama.js
    │       └── default.js
    ├── data-sources/
    │   ├── types.js
    │   ├── cache.js
    │   ├── registry/
    │   │   ├── types.js
    │   │   ├── companies-house.js
    │   │   └── sec-edgar.js
    │   ├── screening/
    │   │   ├── types.js
    │   │   ├── ofac.js
    │   │   ├── uk-hmt.js
    │   │   ├── un-consolidated.js
    │   │   └── fuzzy-matcher.js
    │   └── media/
    │       ├── types.js
    │       └── news-search.js
    ├── agents/
    │   ├── types.js
    │   ├── base-agent.js
    │   ├── orchestrator.js
    │   ├── decision-fragment.js
    │   ├── entity-resolution/
    │   │   ├── agent.js
    │   │   └── prompts.js
    │   ├── ownership-ubo/
    │   │   ├── agent.js
    │   │   └── prompts.js
    │   ├── screening/
    │   │   ├── agent.js
    │   │   └── prompts.js
    │   ├── document-analysis/
    │   │   ├── agent.js
    │   │   └── prompts.js
    │   ├── risk-assessment/
    │   │   ├── agent.js
    │   │   └── prompts.js
    │   └── qa/
    │       ├── agent.js
    │       └── prompts.js
    ├── services/
    │   ├── case-management.js
    │   ├── document-service.js
    │   ├── rule-engine.js
    │   ├── event-store.js
    │   └── auth-service.js
    ├── api/
    │   ├── cases.js
    │   ├── review.js
    │   ├── config.js
    │   ├── admin.js
    │   ├── auth.js
    │   └── websocket.js
    └── workers/
        ├── agent-worker.js
        └── screening-sync.js
```

For the scaffold, only `src/index.js`, `src/api/admin.js`, `db/connection.js`, and the directory skeleton need real content. All other files should be created as stubs with a placeholder comment.

### File: `backend/package.json`

```json
{
  "name": "kyc-agent-backend",
  "version": "0.1.0",
  "private": true,
  "description": "KYC Agent platform — backend API and agent workers",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "dev": "node --watch src/index.js",
    "test": "jest",
    "test:watch": "jest --watch",
    "migrate:up": "node-pg-migrate up",
    "migrate:down": "node-pg-migrate down",
    "migrate:create": "node-pg-migrate create",
    "db:seed": "node db/seed.js"
  },
  "dependencies": {
    "fastify": "^5.0.0",
    "@fastify/cors": "^10.0.0",
    "@fastify/multipart": "^9.0.0",
    "@fastify/websocket": "^11.0.0",
    "pg": "^8.13.0",
    "bullmq": "^5.0.0",
    "ioredis": "^5.4.0",
    "minio": "^8.0.0",
    "socket.io": "^4.8.0",
    "jsonwebtoken": "^9.0.0",
    "bcrypt": "^5.1.0",
    "joi": "^17.13.0",
    "js-yaml": "^4.1.0",
    "dotenv": "^16.4.0",
    "node-pg-migrate": "^7.0.0",
    "pino": "^9.0.0"
  },
  "devDependencies": {
    "jest": "^29.7.0"
  }
}
```

### File: `backend/jsconfig.json`

```json
{
  "compilerOptions": {
    "checkJs": true,
    "module": "commonjs",
    "target": "ES2022",
    "baseUrl": ".",
    "paths": {
      "@db/*": ["db/*"],
      "@src/*": ["src/*"]
    }
  },
  "include": ["src/**/*.js", "db/**/*.js"],
  "exclude": ["node_modules"]
}
```

### File: `backend/src/index.js`

```javascript
require('dotenv').config();
const fastify = require('fastify');
const cors = require('@fastify/cors');

async function buildServer() {
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // CORS
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  });

  // Structured error handler
  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || 500;
    const response = {
      error: {
        code: error.code || 'INTERNAL_ERROR',
        message: error.message,
        ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
      },
    };
    request.log.error(error);
    reply.status(statusCode).send(response);
  });

  // Health check
  app.get('/api/v1/admin/system/health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });

  // TODO: Register route plugins
  // await app.register(require('./api/cases'), { prefix: '/api/v1' });
  // await app.register(require('./api/review'), { prefix: '/api/v1' });
  // await app.register(require('./api/config'), { prefix: '/api/v1' });
  // await app.register(require('./api/admin'), { prefix: '/api/v1' });
  // await app.register(require('./api/auth'), { prefix: '/api/v1' });

  return app;
}

async function start() {
  const app = await buildServer();
  const port = parseInt(process.env.PORT || '4000');
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();

module.exports = { buildServer };
```

### File: `backend/Dockerfile`

```dockerfile
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --production

COPY . .

EXPOSE 4000

CMD ["node", "src/index.js"]
```

### File: `backend/.dockerignore`

```
node_modules
npm-debug.log
.env
.env.local
tests/
*.test.js
```

## Interfaces

### Health Check Endpoint

```
GET /api/v1/admin/system/health

Response 200:
{
  "status": "ok",
  "timestamp": "2026-04-03T12:00:00.000Z",
  "uptime": 123.456
}
```

### Error Response Format

All error responses follow this structure:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "clientName is required",
    "details": {}
  }
}
```

| Status | Code | When |
|--------|------|------|
| 400 | `VALIDATION_ERROR` | Request body/params fail schema validation |
| 401 | `UNAUTHORIZED` | Missing or invalid JWT |
| 403 | `FORBIDDEN` | Insufficient role permissions |
| 404 | `NOT_FOUND` | Resource doesn't exist |
| 500 | `INTERNAL_ERROR` | Unhandled server error |

## Acceptance Criteria

- [ ] `backend/package.json` contains all core dependencies listed above
- [ ] `backend/jsconfig.json` enables editor IntelliSense and type checking
- [ ] Directory structure matches architecture doc section 11 (all directories created, stub files where needed)
- [ ] `node src/index.js` starts Fastify and listens on port 4000
- [ ] `GET /api/v1/admin/system/health` returns `{ status: "ok" }` with 200
- [ ] CORS allows requests from `http://localhost:3000`
- [ ] Request logging outputs structured JSON via Pino
- [ ] Errors return `{ error: { code, message } }` format
- [ ] `backend/Dockerfile` builds and runs successfully

## Dependencies

- **Depends on**: #2 (Docker Compose), #3 (Database — `connection.js` used by all services)
- **Blocks**: #6 (MinIO storage), all API and agent stories

## Testing Strategy

1. **Server start test**: Start server, verify it listens on configured port
2. **Health check test**: `GET /api/v1/admin/system/health` returns 200 with expected shape
3. **CORS test**: Verify preflight request from frontend origin succeeds
4. **Error handler test**: Trigger a 400 and 500 error, verify response format
5. **Graceful shutdown test**: Send SIGTERM, verify server closes connections cleanly
6. **Docker build test**: `docker build -t kyc-backend ./backend` succeeds
