# Quickstart: Fastify Backend Scaffold

**Branch**: `003-fastify-backend-scaffold`

## Prerequisites

- Node.js 22+
- Docker (for container test)
- PostgreSQL running (for future features; not required by scaffold itself)

## Run locally

```bash
cd backend
npm install
node src/index.js
# Server listens on http://localhost:4000
```

Verify:

```bash
curl http://localhost:4000/api/v1/admin/system/health
# {"status":"ok","timestamp":"...","uptime":...}
```

## Run tests

```bash
cd backend
npm test
```

## Run in Docker

```bash
docker build -t kyc-backend ./backend
docker run --rm -p 4000:4000 kyc-backend
curl http://localhost:4000/api/v1/admin/system/health
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `LOG_LEVEL` | `info` | Pino log level |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed CORS origin |
| `NODE_ENV` | `development` | Controls stack trace in error responses |

## Run as part of the full stack

```bash
docker-compose up api
```
