# Feature Specification: Fastify Backend Scaffold

**Feature Branch**: `003-fastify-backend-scaffold`  
**Created**: 2026-04-09  
**Status**: Draft  
**Input**: User description: "specifications/epic-01-infrastructure-devops/backend-scaffold/SPEC.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Server Startup and Health Verification (Priority: P1)

A backend developer starts the server and confirms it is running and healthy. The health check endpoint provides a single, reliable signal that the server is up and ready to accept requests — without requiring knowledge of any business logic.

**Why this priority**: All downstream development and integration work depends on a running, reachable server. Without this baseline, nothing else can be built or tested.

**Independent Test**: Start the server, send `GET /api/v1/admin/system/health`, confirm a `200 OK` response with `status: "ok"` and a timestamp. Delivers a fully operational development server with observable health state.

**Acceptance Scenarios**:

1. **Given** the server has been started with `node src/index.js`, **When** a `GET /api/v1/admin/system/health` request is made, **Then** a `200 OK` response is returned containing `{ "status": "ok", "timestamp": "<ISO8601>", "uptime": <number> }`
2. **Given** the server is running, **When** an unexpected error occurs in a route handler, **Then** the response body conforms to `{ "error": { "code": "<string>", "message": "<string>" } }` and returns an appropriate HTTP status code
3. **Given** the server is running, **When** a `SIGTERM` or `SIGINT` signal is sent, **Then** the server completes in-flight requests and shuts down cleanly within a reasonable window without dropping connections

---

### User Story 2 - Cross-Origin Request Support for the Frontend (Priority: P2)

A frontend developer running the Vue.js SPA at `http://localhost:3000` makes API calls to the backend at `http://localhost:4000`. Browser CORS policy must not block these requests.

**Why this priority**: Without CORS configured, no frontend-to-backend integration work can proceed in local development. Blocking all other Phase 1 stories.

**Independent Test**: Send a CORS preflight (`OPTIONS`) request from the frontend origin to any API endpoint and confirm the browser receives the correct `Access-Control-Allow-Origin` header.

**Acceptance Scenarios**:

1. **Given** a request originates from `http://localhost:3000`, **When** a preflight `OPTIONS` request is sent to the API, **Then** the response includes `Access-Control-Allow-Origin: http://localhost:3000` and `Access-Control-Allow-Credentials: true`
2. **Given** a request originates from an unknown origin, **When** a request is made, **Then** the CORS headers are absent and the browser blocks the response

---

### User Story 3 - Structured Request Logging (Priority: P3)

An operator or developer inspecting server logs sees every request recorded in a structured, machine-parseable format. Log entries include method, route, status code, and response time — making it straightforward to tail logs or feed them into a log aggregator.

**Why this priority**: Observability is critical for debugging agent pipelines and production incidents. Structured logs are required before any agent or service work begins.

**Independent Test**: Start the server, make several requests, and confirm each request appears as a JSON log line written to stdout.

**Acceptance Scenarios**:

1. **Given** the server is running, **When** any HTTP request is processed, **Then** a structured JSON log entry is emitted to stdout containing the HTTP method, route, status code, and response duration
2. **Given** the `LOG_LEVEL` environment variable is set, **When** the server starts, **Then** only log entries at or above that level are emitted

---

### User Story 4 - Containerized Deployment (Priority: P4)

A DevOps engineer builds the backend Docker image and starts it as part of the Docker Compose stack. The container starts, listens on port 4000, and responds to the health check — with no host-level Node.js installation required.

**Why this priority**: The entire platform runs from `docker-compose up`. A working Dockerfile is a prerequisite for the integrated stack.

**Independent Test**: Run `docker build -t kyc-backend ./backend` and then `docker run -p 4000:4000 kyc-backend`. Confirm the health endpoint responds.

**Acceptance Scenarios**:

1. **Given** Docker is installed, **When** `docker build -t kyc-backend ./backend` is executed, **Then** the image builds successfully with no errors
2. **Given** the image has been built, **When** a container is started and the health endpoint is called, **Then** a `200 OK` response is returned confirming the container is functioning correctly

---

### Edge Cases

- What happens when the `PORT` or `HOST` environment variable is absent? The server must fall back to sensible defaults (`4000` and `0.0.0.0`) without crashing.
- What happens when the server receives a request to a route that does not exist? A `404 NOT_FOUND` response must be returned in the standard error format.
- How does the server handle a synchronous thrown error inside a route handler? The error handler must catch it, log it, and respond with `500 INTERNAL_ERROR` in the standard error format — never leaking a stack trace in production.
- How does the graceful shutdown behave if a worker is processing a long-running request? The server stops accepting new connections and allows in-flight requests up to 10 seconds to complete; after that it force-exits regardless.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The server MUST expose a health check endpoint at `GET /api/v1/admin/system/health` returning HTTP 200 with `{ "status": "ok", "timestamp": "<ISO8601>", "uptime": <number> }`
- **FR-002**: The server MUST respond to all errors with the standard format `{ "error": { "code": "<string>", "message": "<string>" } }` and an appropriate HTTP status code
- **FR-003**: The server MUST allow CORS requests from the configured frontend origin (default: `http://localhost:3000`) with credentials
- **FR-004**: The server MUST emit structured JSON request logs for every HTTP request, including method, route, status, and duration
- **FR-005**: The server MUST start within 3 seconds of process launch (excluding Docker image build time)
- **FR-006**: The server MUST listen on the port and host configured by environment variables, defaulting to `4000` and `0.0.0.0`
- **FR-007**: The server MUST perform a graceful shutdown when it receives `SIGTERM` or `SIGINT`, completing in-flight requests before exiting
- **FR-008**: The project directory structure MUST match the architecture specification, with all directories created and non-implemented files present as stubs
- **FR-009**: A Dockerfile MUST exist that builds and runs the backend without a host-level Node.js installation
- **FR-010**: A minimal Jest test file MUST be included covering: (a) `GET /api/v1/admin/system/health` returns 200 with correct shape, and (b) an unhandled route or thrown error returns the standard error envelope format

### Key Entities

- **Server Configuration**: Runtime settings (port, host, log level, CORS origin) read from environment variables at startup, with documented defaults
- **Error Response**: A standardised envelope `{ error: { code, message, [details] } }` used for all non-2xx responses — the single contract shared by all API consumers
- **Health Report**: A lightweight status payload `{ status, timestamp, uptime }` exposing server liveness to orchestration tooling and human operators

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The health endpoint responds in under 50 ms on a development machine with no load
- **SC-002**: The server process is ready to accept requests within 3 seconds of being launched
- **SC-003**: Every HTTP request generates exactly one structured log entry; no request is silently dropped from the log
- **SC-004**: A CORS preflight from `http://localhost:3000` succeeds with a correct `Access-Control-Allow-Origin` header on 100% of requests
- **SC-005**: All error responses — whether from validation failures, missing routes, or unhandled exceptions — conform to the standard error envelope without exception
- **SC-006**: The Docker image builds successfully from a clean checkout with a single `docker build` command and the container passes the health check immediately after start
- **SC-007**: The server exits within 10 seconds of receiving SIGTERM; if in-flight requests have not completed by then, the process force-exits — no orphaned processes remain
- **SC-008**: The Jest test suite (`npm test`) runs to completion with all included tests passing on a clean install

## Clarifications

### Session 2026-04-09

- Q: Does this scaffold include writing Jest tests, or are tests a separate follow-on task? → A: Include a minimal Jest test file covering the health check endpoint and the error handler response format only.
- Q: After the 10-second graceful shutdown drain window, does the server force-exit or wait indefinitely? → A: Force-exit (process terminates) after the drain window, even if requests are still in flight.

## Assumptions

- The backend JavaScript runtime is Node.js 22 (matching the Docker base image); no transpilation or build step is required
- The `db/connection.js` module referenced by future services will be scaffolded as a stub in this feature — actual database connectivity is provided by a prior dependency (issue #3)
- All configuration (port, CORS origin, log level) is supplied via environment variables; no file-based config is required for the scaffold
- The stub files created for future modules (agents, services, data-sources, etc.) contain only a placeholder comment and export nothing; they exist solely to establish the directory skeleton
- Authentication and route-level authorisation are out of scope for this scaffold; they will be added in a later feature
- The health endpoint does not perform database or dependency connectivity checks in this scaffold — that concern belongs to a future monitoring feature
