# Feature Specification: Vue.js Frontend Scaffold

**Feature Branch**: `004-vue-frontend-scaffold`  
**Created**: 2026-04-09  
**Status**: Draft  
**Input**: User description: "specifications/epic-01-infrastructure-devops/frontend-scaffold/SPEC.md"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Developer Starts the Frontend and Navigates the App (Priority: P1)

A frontend developer clones the repository, installs dependencies, starts the development server, and navigates between all application routes in the browser. Every route loads the correct view. The layout renders a navigation sidebar and a top header on all authenticated pages. The login page renders without the layout chrome.

**Why this priority**: This is the baseline deliverable — a running, navigable SPA is the prerequisite for all subsequent frontend work. No other team can build UI features until the scaffold is in place.

**Independent Test**: Run `npm run dev` in `frontend/`, open the browser, visit `/dashboard`, `/cases/test-id`, `/review`, `/admin/config`, and `/login`. Each renders the correct view. Layout appears on all routes except `/login`.

**Acceptance Scenarios**:

1. **Given** dependencies are installed, **When** the dev server is started, **Then** it is accessible at `http://localhost:3000` within 5 seconds
2. **Given** the dev server is running, **When** a user navigates to `/dashboard`, **Then** the Dashboard view renders inside the AppLayout (with sidebar and header)
3. **Given** the dev server is running, **When** a user navigates to `/login`, **Then** the Login view renders without the sidebar or header
4. **Given** the dev server is running, **When** a user navigates to `/cases/abc-123`, **Then** the Case Detail view renders with the case ID accessible to the view
5. **Given** the dev server is running, **When** a user navigates to `/review`, **Then** the Review Queue view renders
6. **Given** the dev server is running, **When** a user navigates to `/admin/config`, **Then** the Configuration view renders
7. **Given** the root path `/` is visited, **When** the page loads, **Then** the user is redirected to `/dashboard`

---

### User Story 2 - Frontend Sends API Requests Through the Development Proxy (Priority: P2)

A frontend developer makes an HTTP request to the backend REST API from within the browser (e.g., a fetch or axios call to `/api/v1/...`). The request is forwarded to the backend server without CORS issues. WebSocket connections to `/socket.io` are also proxied.

**Why this priority**: The proxy eliminates the cross-origin constraint during local development. Without it, every API call would fail or require manual configuration on the developer's machine.

**Independent Test**: With both the frontend dev server and backend running, open browser DevTools Network tab and confirm that a request to `/api/v1/admin/system/health` returns a `200 OK` response proxied from the backend.

**Acceptance Scenarios**:

1. **Given** both the dev server and backend are running, **When** an HTTP request is made to `/api/v1/...`, **Then** the request is forwarded to `http://localhost:4000` and the response is returned to the browser without CORS errors
2. **Given** both the dev server and backend are running, **When** a WebSocket connection is opened to `/socket.io`, **Then** the connection is proxied to the backend WebSocket server

---

### User Story 3 - Frontend Produces a Production Build (Priority: P3)

A CI engineer or developer runs the build command. The output is a directory of static HTML, CSS, and JavaScript files that can be served by any static web server.

**Why this priority**: The production build is required for Docker image creation and deployment. It validates that no compile-time errors exist in the scaffold.

**Independent Test**: Run `npm run build`. Confirm the command exits with code 0 and a `dist/` directory is produced containing `index.html` and hashed asset files.

**Acceptance Scenarios**:

1. **Given** dependencies are installed, **When** the build command is run, **Then** it completes without errors and produces a `dist/` directory
2. **Given** the build has completed, **When** `index.html` is inspected, **Then** it references hashed JavaScript and CSS bundles (confirming code splitting is active)
3. **Given** the build has completed, **When** the dashboard route is accessed, **Then** the correct lazy-loaded chunk is loaded rather than a single monolithic bundle

---

### User Story 4 - Frontend Runs in a Docker Container (Priority: P4)

A DevOps engineer builds the frontend Docker image and starts a container. Navigating to `http://localhost:3000` in the browser serves the SPA. The nginx server handles client-side routing (deep links work without returning 404).

**Why this priority**: The entire platform is deployed via Docker Compose. A working frontend container is required for the integrated stack.

**Independent Test**: Run `docker build -t kyc-frontend ./frontend` and then `docker run --rm -p 3000:3000 kyc-frontend`. Open `http://localhost:3000/dashboard` in a browser — the SPA loads and navigating to a deep link does not produce a 404.

**Acceptance Scenarios**:

1. **Given** Docker is installed, **When** `docker build -t kyc-frontend ./frontend` is executed, **Then** the image builds successfully
2. **Given** the container is running, **When** `http://localhost:3000` is accessed, **Then** the SPA is served
3. **Given** the container is running, **When** a deep link such as `http://localhost:3000/dashboard` is accessed directly, **Then** `index.html` is returned (not a 404) and the SPA handles routing client-side

---

### User Story 5 - Real-Time Connection Store is Ready for Use (Priority: P5)

A frontend developer connects the WebSocket store to the backend and subscribes to real-time events. The store provides `connect(token)`, `disconnect()`, `on(event, handler)`, and `off(event, handler)` methods that future features can call without reimplementing connection logic.

**Why this priority**: The WebSocket store is a shared dependency for all real-time update features (agent progress, case state changes). Scaffolding it now avoids multiple teams implementing conflicting approaches.

**Independent Test**: Import the WebSocket store in a component, call `connect()`, and confirm the `connected` reactive property updates to `true` when the backend WebSocket server is running.

**Acceptance Scenarios**:

1. **Given** the backend is running, **When** `connect(token)` is called on the WebSocket store, **Then** the `connected` state becomes `true`
2. **Given** a WebSocket connection is established, **When** `disconnect()` is called, **Then** the socket closes and `connected` becomes `false`
3. **Given** a WebSocket connection is established, **When** `on('case:updated', handler)` is called, **Then** the handler is invoked when the backend emits a `case:updated` event

---

### Edge Cases

- What happens when a user navigates to a route that does not exist? A catch-all route (`/:pathMatch(.*)*`) renders `NotFoundView.vue`, which displays a "page not found" message and a link back to `/dashboard`.
- What happens when the backend is unavailable and a proxied API request fails? The request fails with a network error — error handling is a concern for individual feature implementations, not the scaffold.
- What happens when the WebSocket store's `on()` method is called before `connect()`? The call must be silently ignored without throwing an error.
- What happens when the Docker container receives a request for a JavaScript asset that was renamed in a new build? nginx returns 404 for the stale asset — the user must hard-refresh.

## Clarifications

### Session 2026-04-09

- Q: Does the nginx.conf in the Docker image include proxy_pass rules for /api and /socket.io, or only static asset serving and SPA fallback? → A: nginx.conf includes proxy_pass rules forwarding /api and /socket.io to http://api:4000 (the backend Docker service name), making the container self-contained for docker-compose deployments.
- Q: When a user navigates to an unknown route, does the router redirect to /dashboard or render a dedicated 404 view? → A: A catch-all route renders a dedicated NotFoundView.vue stub.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The SPA MUST be navigable via five defined routes: `/login`, `/dashboard`, `/cases/:id`, `/review`, `/admin/config`; a sixth catch-all route MUST render `NotFoundView.vue` for any unmatched path
- **FR-002**: Navigating to `/` MUST redirect the user to `/dashboard`
- **FR-003**: The application layout (sidebar navigation + top header) MUST be shown on all routes except `/login`
- **FR-004**: Each route's view component MUST be lazy-loaded (code-split from the main bundle)
- **FR-005**: The development server MUST proxy all requests to `/api/*` to the backend server at `http://localhost:4000`
- **FR-006**: The development server MUST proxy WebSocket connections to `/socket.io` to the backend WebSocket server
- **FR-007**: A production build MUST produce static assets in a `dist/` directory servable by any standard web server
- **FR-008**: The WebSocket store MUST provide `connect(token)`, `disconnect()`, `on(event, handler)`, and `off(event, handler)` methods and expose `socket` and `connected` as reactive state
- **FR-009**: State management stores MUST be scaffolded for four domains: case management, review workflow, authentication, and WebSocket connection
- **FR-010**: The component library MUST be globally configured with the Aura theme so components are usable in any view without per-file imports
- **FR-011**: A Dockerfile MUST exist that builds a production nginx image serving the SPA on port 3000; nginx MUST return `index.html` for all unknown paths (SPA fallback), AND MUST proxy `/api` and `/socket.io` requests to `http://api:4000` (the backend Docker service) for docker-compose deployments
- **FR-012**: The development server MUST start on port 3000 and support live code reloading so changes reflect in the browser without a full page reload

### Key Entities

- **Route**: A URL path mapped to a lazy-loaded view component, with metadata indicating authentication requirement and optional role restriction
- **Pinia Store**: A reactive state module scoped to a domain (cases, review, auth, websocket); each store is independently importable
- **AppLayout**: The shell component that wraps all authenticated views, rendering the sidebar navigation and top header
- **WebSocket Connection**: A persistent client-server channel managed by the WebSocket store, used to receive real-time event notifications from the backend

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The development server is accessible in the browser within 5 seconds of the start command
- **SC-002**: All 5 routes render the correct view on first navigation with no console errors
- **SC-003**: Each route's view is delivered as a separate code-split chunk — no single bundle contains all views
- **SC-004**: The production build completes without errors or warnings and produces a `dist/` directory with `index.html` and at least one hashed JS bundle
- **SC-005**: An HTTP request from the frontend to `/api/v1/admin/system/health` during development returns the backend's response without CORS errors
- **SC-006**: The Docker image builds successfully from a clean checkout with a single `docker build` command
- **SC-007**: Navigating directly to `/dashboard` in the Docker container returns the SPA (not a 404)
- **SC-008**: The WebSocket store's `connected` state is `false` on initialisation and transitions to `true` after `connect()` completes against a running backend
- **SC-009**: Navigating to an unknown path renders the Not Found view (not a blank page or uncaught error) and provides a navigable link back to the dashboard

## Assumptions

- The backend scaffold (feature 003) is complete and available at `http://localhost:4000` for proxy and WebSocket integration tests
- The component library choice is PrimeVue with the Aura theme preset; no alternative library is being evaluated in this feature
- Authentication guard logic (protecting routes that require a valid session) is out of scope for this scaffold — only the route metadata (`requiresAuth`) is defined; the actual navigation guard is a Phase 3 concern
- The sidebar navigation links between all five routes but does not implement active-state highlighting or role-based visibility in this scaffold
- The cases, review, and auth Pinia stores are scaffolded with state shape and action stubs only — no API calls are wired in this feature
- No test files are written in this scaffold; the test runner is included in `package.json` but test authoring is deferred to individual feature stories
- The nginx configuration in the Docker image handles static asset serving, SPA fallback, and API/WebSocket proxying to `http://api:4000` — this service name matches the backend service defined in docker-compose.yml
