# Feature Specification: Docker Compose Stack

**Feature Branch**: `001-docker-compose-stack`
**Created**: 2026-04-08
**Status**: Draft
**Input**: specifications/epic-01-infrastructure-devops/docker-compose/SPEC.md

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Stand Up the Full Platform (Priority: P1)

A developer or operator with Docker installed runs a single command to bring the entire
KYC Agent platform online on a new machine, with no external accounts, API keys, or cloud
services required.

**Why this priority**: This is the foundational story — nothing else in the platform can
be developed, tested, or demonstrated without a running stack. It is the primary delivery
mechanism for on-premises client deployments.

**Independent Test**: Run `docker-compose up -d` on a clean machine; confirm all service
categories reach a running/healthy state and the frontend is reachable in a browser.

**Acceptance Scenarios**:

1. **Given** Docker is installed and no existing containers or volumes exist, **When** the
   operator runs `docker-compose up`, **Then** all services start without manual
   intervention and remain running.
2. **Given** the database is not yet ready, **When** the API server and agent workers
   start, **Then** they wait for the database to pass its health check before accepting
   connections.
3. **Given** the stack is running, **When** the operator runs `docker-compose down -v`,
   **Then** all containers and persistent volumes are removed cleanly with no orphaned
   resources.

---

### User Story 2 — Configure the Stack Without Code Changes (Priority: P2)

An operator tailors the platform for their environment — changing ports, credentials, or
worker replica counts — without modifying any application code or Docker image definitions.

**Why this priority**: Clients deploy in environments where default ports may conflict,
security policies require non-default credentials, and resource capacity varies.
Configuration must be externalized to avoid code forks per deployment.

**Independent Test**: Override one default (e.g., the API port) via a `.env` file, restart
the stack, and confirm the API is reachable on the overridden port only.

**Acceptance Scenarios**:

1. **Given** a `.env` file exists at the project root, **When** the operator runs
   `docker-compose up`, **Then** all environment variable overrides are applied to the
   relevant services.
2. **Given** a variable is not set in `.env`, **When** the stack starts, **Then** the
   service uses the documented default value.
3. **Given** `AGENT_WORKER_REPLICAS=3` is set in `.env`, **When** the stack starts,
   **Then** 3 agent-worker containers are running.

---

### User Story 3 — Survive a Restart With Persistent Data (Priority: P3)

An operator restarts the Docker stack and finds that previously stored data — database
records, uploaded documents, and downloaded LLM model weights — is preserved across
restarts.

**Why this priority**: Without persistence, every restart loses case data and forces a
full model re-download, making the platform unusable for any real deployment.

**Independent Test**: Write data to the database and document store, restart the stack
without `down -v`, and confirm all previously written data is accessible.

**Acceptance Scenarios**:

1. **Given** records were written to the database before a restart, **When** the stack
   restarts without volume removal, **Then** all previously written records are accessible.
2. **Given** a file was stored in the document store before a restart, **When** the stack
   restarts, **Then** the file is still retrievable.
3. **Given** an LLM model was downloaded before a restart, **When** the stack restarts,
   **Then** the model is served without being re-downloaded.

---

### Edge Cases

- What happens when a required port (e.g., 5432) is already in use on the host? The
  operator must override it via `.env`; all ports and binding addresses are documented
  in `.env.example`.
- What happens when an operator sets a binding address to `0.0.0.0` on a shared network?
  Services become reachable to other machines; the README MUST warn that default dev
  credentials should never be used with non-localhost bindings.
- What happens if document bucket initialization fails? The API server retries on startup;
  alternatively the operator can trigger bucket creation manually.
- What happens if a service crashes after the stack is running? The service restarts
  automatically (on-failure policy); the operator can inspect logs between retries via
  `docker logs <service>`.
- What happens if `docker-compose down -v` is run accidentally? All persistent data is
  destroyed by design; the README MUST warn operators about this behavior.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A single `docker-compose up` MUST start all required services: frontend,
  api, agent-worker (configurable replicas, default 2), screening-sync, postgres, redis,
  minio, and ollama.
- **FR-002**: All services MUST communicate with each other by Docker service name over a
  shared Docker network; no hardcoded IP addresses are permitted.
- **FR-003**: The database MUST be initialized with the full application schema
  automatically on first start using a mounted initialization script.
- **FR-004**: A `documents` bucket MUST exist in the object store after stack startup
  (created by the API server on boot or a one-time init container).
- **FR-005**: Services that depend on the database or cache MUST wait for those services
  to pass their health checks before starting.
- **FR-006**: All configurable values — ports, credentials, replica counts, secrets, and
  port binding addresses — MUST be overridable via a `.env` file at the project root with
  no code changes required.
- **FR-006a**: All exposed service ports MUST bind to `127.0.0.1` (localhost) by default.
  Each port binding address MUST be overridable via `.env` for operators who require
  remote access (e.g., `API_HOST=0.0.0.0`).
- **FR-007**: A `.env.example` file MUST document every configurable environment variable
  with its default value, including per-service host binding addresses.
- **FR-008**: `docker-compose down -v` MUST cleanly remove all containers and all named
  volumes with no orphaned resources.
- **FR-009**: Persistent storage for the database, cache, object store, and LLM model
  weights MUST survive container restarts via named volumes.
- **FR-010**: The LLM inference service MUST support optional GPU passthrough, disabled by
  default, with the required configuration present but commented out in the compose file.
- **FR-011**: All services MUST be configured with a `restart: on-failure` policy so that
  services which exit with a non-zero code are automatically restarted. Services that are
  stopped intentionally (exit code 0) MUST NOT be restarted automatically.
- **FR-012**: A `docker-compose.override.yml` file MUST be provided for local development.
  It MUST mount source directories as volumes and configure frontend and backend services
  to run in watch/hot-reload mode. The base `docker-compose.yaml` MUST remain
  production-safe with no development volume mounts.

### Key Entities

- **Service**: A named, containerized process with build context, environment configuration,
  port bindings, health check (where applicable), and declared dependencies.
- **Named Volume**: Persistent storage attached to a service that survives container
  restarts; removed only on explicit teardown with the volume flag.
- **Health Check**: A probe on the database and cache services that downstream services
  wait for before starting, preventing startup race conditions.
- **Environment Override**: A key-value entry in `.env` that replaces a service's default
  environment variable; documented exhaustively in `.env.example`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer on a clean machine can go from zero to a fully running platform
  in under 5 minutes following only the README (excluding LLM model downloads).
- **SC-002**: Subsequent warm starts (no rebuild required) complete within 30 seconds.
- **SC-003**: All service categories reach running or healthy state on first start with no
  manual operator steps beyond the start command.
- **SC-004**: 100% of data written before a restart is recoverable after restart (without
  volume removal).
- **SC-005**: Any default port, credential, or replica count can be changed via `.env`
  alone — no edits to the compose file required for standard deployments.

## Clarifications

### Session 2026-04-08

- Q: Should service ports be bound to localhost only or accessible across the network? → A: Configurable — localhost (127.0.0.1) by default, overridable via `.env` for remote access scenarios.
- Q: Should services automatically restart if they crash while the stack is running? → A: On failure only — services restart automatically only when they exit with a non-zero code.
- Q: Should the compose setup support hot-reload / live file-watching during development? → A: Separate override file — `docker-compose.override.yml` adds volume mounts and dev modes; base file stays production-safe.

## Assumptions

- Operators have Docker with Compose V2 installed (`docker compose` command available).
- `docker-compose.override.yml` is automatically merged by Docker Compose when both files
  are present in the same directory; no extra flags needed for developers.
- The override file is not intended for production use; `.gitignore` guidance in the README
  MUST clarify it can be safely customized locally without affecting the base compose file.
- The 5-minute first-start budget excludes LLM model downloads, which are network-dependent
  and operator-triggered separately from the initial stack startup.
- GPU passthrough is out of scope for the baseline stack; the compose file includes
  commented GPU configuration for operators who need it.
- Development-safe defaults (weak credentials) are acceptable for local development;
  operators are responsible for replacing secrets via `.env` before production deployment.
- Docker Compose V2 `deploy.replicas` is supported in local non-Swarm mode (true as of
  Docker Desktop 4.x / Compose V2.x).
- The `documents` bucket is created on API server startup as the primary path; an init
  container is an acceptable fallback if the API startup approach proves fragile.
