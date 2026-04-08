# Research: Docker Compose Stack

**Branch**: `001-docker-compose-stack` | **Date**: 2026-04-08

## Decision 1: MinIO Bucket Initialization Approach

**Decision**: The API server creates the `documents` bucket on startup using the MinIO SDK
(`bucketExists` + `makeBucket`), with idempotent retry logic.

**Rationale**: The API already holds a MinIO client connection. An on-boot bucket check adds
~1 line of initialization code and eliminates a separate init container. The operation is
idempotent — safe to run on every restart. The init container alternative (minio/mc) requires
an additional image pull, adds a startup ordering dependency, and exits after running, which
can confuse `docker-compose ps` output.

**Alternatives considered**:
- `minio-init` container using `minio/mc` — functional but adds image, ordering complexity,
  and a one-shot container exit that can appear as a failure in some monitoring setups
- Pre-baked bucket in MinIO volume — not portable; breaks on `docker-compose down -v`

---

## Decision 2: `deploy.replicas` in Non-Swarm Mode

**Decision**: Use `deploy.replicas: ${AGENT_WORKER_REPLICAS:-2}` on the `agent-worker`
service in the base compose file.

**Rationale**: Docker Compose V2 (2.0+) supports `deploy.replicas` in standalone mode
without Docker Swarm. This has been confirmed behavior since Docker Desktop 4.x / Compose
2.x. It is the canonical approach for scaling workers in compose without duplicating service
definitions.

**Alternatives considered**:
- Named duplicate services (`agent-worker-1`, `agent-worker-2`) — verbose, hard to scale,
  breaks `.env`-driven replica count
- Docker Swarm deploy — overkill for a single-node development stack

---

## Decision 3: Restart Policy by Service Category

**Decision**: Apply `restart: on-failure` to application services; `restart: unless-stopped`
to infrastructure services.

| Category | Services | Policy | Reason |
|----------|----------|--------|--------|
| Application | api, agent-worker, screening-sync, frontend | `on-failure` | Restart on crash (non-zero exit) only; `docker-compose stop` exits cleanly |
| Infrastructure | postgres, redis, minio, ollama | `unless-stopped` | Always running; only stop on explicit operator command |

**Rationale**: Infrastructure services should always be available for application services to
connect to. Application services should restart automatically if they crash (e.g., unhandled
exception) but not if intentionally stopped. `on-failure` achieves this; `unless-stopped`
would restart app services even after an intentional `docker-compose stop`.

**Alternatives considered**:
- `restart: always` for everything — would restart app services after intentional stop,
  creating confusion during development
- No restart policy — would require manual intervention after any crash

---

## Decision 4: Development Hot-Reload Pattern

**Decision**: `docker-compose.override.yml` uses bind-mount volume mounts with
`nodemon` (backend) and Vite's built-in `--watch` HMR (frontend). No dependency on
Docker Compose Watch (requires Compose 2.22+).

**Rationale**: Volume mounts + nodemon/Vite HMR work on all Compose V2 versions and are
familiar to Node.js developers. Docker Compose Watch (`develop.watch`) is a newer feature
that may not be available on all target machines. The override file approach keeps the base
compose production-safe and is automatically merged by Docker Compose when both files are
present in the same directory.

**Override file behavior**:
- `docker-compose up` (with override present): applies dev volume mounts + dev commands
- `docker-compose -f docker-compose.yaml up` (explicit): ignores override, production mode
- Production deploy: only `docker-compose.yaml` is present

**Alternatives considered**:
- Docker Compose Watch (`develop.watch`) — cleaner but requires Compose 2.22+
- Separate `docker-compose.dev.yaml` with `-f` flag — requires operators to remember the
  flag; override auto-merge is more ergonomic

---

## Decision 5: Port Binding — Localhost Default Implementation

**Decision**: All port bindings use `"${SERVICE_HOST:-127.0.0.1}:${PORT}:${PORT}"` syntax
in the compose file, defaulting to localhost. Each service has its own `_HOST` variable.

**Example**:
```yaml
ports:
  - "${API_HOST:-127.0.0.1}:${API_PORT:-4000}:4000"
```

**Rationale**: Per clarification Q1, binding defaults to localhost for security but must be
overridable per service. The `:-` default syntax in Docker Compose achieves this without
requiring the operator to set the variable for standard use.

**Alternatives considered**:
- Single `BIND_HOST` variable for all services — less granular; some services (e.g., MinIO
  console) may need different exposure than others
- Hardcoded `127.0.0.1` — not overridable without code changes, violating FR-006

---

## Decision 6: Health Check Strategy

**Decision**: Health checks on PostgreSQL and Redis (blocking dependency gates). The API
service adds a lightweight `/health` endpoint that the frontend can optionally depend on.

**PostgreSQL health check**:
```
pg_isready -U ${PG_USER:-kyc} -d ${PG_DB:-kycagent}
```

**Redis health check**:
```
redis-cli ping
```

**API health check** (for diagnostics, not blocking):
```
wget -q -O- http://localhost:4000/health || exit 1
```

**Rationale**: Blocking health checks on the database and cache prevent the API and workers
from starting before their dependencies are ready (FR-005). The API health endpoint enables
operators to verify application-layer readiness independently from infrastructure readiness.

**MinIO and Ollama**: No health check defined — they use `condition: service_started`
dependencies. Both expose HTTP APIs that can be probed manually if needed.
