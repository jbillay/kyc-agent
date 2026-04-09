# Quickstart: Vue.js Frontend Scaffold

**Branch**: `004-vue-frontend-scaffold`

## Prerequisites

- Node.js 22+
- Docker (for container test)
- Backend running at `http://localhost:4000` (for proxy test)

## Run locally

```bash
cd frontend
npm install
npm run dev
# Dev server at http://localhost:3000
```

Navigate to:
- `http://localhost:3000/dashboard` — Dashboard view in AppLayout
- `http://localhost:3000/login` — Login view (no layout)
- `http://localhost:3000/cases/test-id` — Case detail view
- `http://localhost:3000/review` — Review queue
- `http://localhost:3000/admin/config` — Config (admin role)
- `http://localhost:3000/does-not-exist` — Not Found view

## Production build

```bash
cd frontend
npm run build
# Output: frontend/dist/
ls dist/   # index.html + hashed JS/CSS chunks
```

## Run in Docker

```bash
docker build -t kyc-frontend ./frontend
docker run --rm -p 3000:3000 kyc-frontend
# Open http://localhost:3000/dashboard
```

## Verify API proxy (dev)

With backend running:

```bash
# In browser DevTools console:
fetch('/api/v1/admin/system/health').then(r => r.json()).then(console.log)
# Should print: { status: 'ok', timestamp: '...', uptime: ... }
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_WS_URL` | `''` (empty = same origin) | WebSocket server URL for Socket.io |

## Full stack

```bash
docker-compose up frontend api
```
