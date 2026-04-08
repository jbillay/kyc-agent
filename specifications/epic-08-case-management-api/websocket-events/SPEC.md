# Case Management API — WebSocket Real-Time Events for Case Progress

> GitHub Issue: [#36](https://github.com/jbillay/kyc-agent/issues/36)
> Epic: Case Management API (#33)
> Size: M (1-3 days) | Priority: High

## Context

Agents execute asynchronously in BullMQ workers — separate processes from the API server. The frontend needs real-time updates as agents progress through steps, complete, or produce decision fragments. Socket.io bridges this gap: agent workers publish events to Redis pub/sub, the API server subscribes and pushes them to connected clients. Clients can join case-specific rooms to only receive events for the cases they're viewing.

## Requirements

### Functional

1. Socket.io server integrated with Fastify API server
2. Seven event types emitted: `case:state_changed`, `case:agent_started`, `case:agent_step_completed`, `case:agent_completed`, `case:fragment_added`, `case:review_assigned`, `case:completed`
3. Clients can subscribe to specific case IDs (join case rooms)
4. Events include relevant payload per architecture doc section 7.3
5. Redis pub/sub for cross-process event distribution (workers → API server)
6. Reconnection handling: Socket.io client auto-reconnects, catches up via API

### Non-Functional

- Event delivery latency < 500ms from worker publish to client receive
- Supports 100+ concurrent WebSocket connections
- No event loss during brief disconnections (Redis pub/sub buffering)

## Technical Design

### File: `backend/src/websocket/index.js`

```javascript
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { createClient } = require('redis');
const { authenticateSocket } = require('./auth');

/**
 * Initialize Socket.io server with Redis adapter for multi-process support.
 *
 * @param {import('http').Server} httpServer - The HTTP server (from Fastify)
 * @param {Object} config
 * @param {string} config.redisUrl - Redis connection URL
 * @param {string[]} [config.corsOrigins] - Allowed CORS origins
 * @returns {Promise<import('socket.io').Server>}
 */
async function createWebSocketServer(httpServer, config) {
  const io = new Server(httpServer, {
    cors: {
      origin: config.corsOrigins || ['http://localhost:3000'],
      methods: ['GET', 'POST'],
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  // ─── Redis adapter for multi-process pub/sub ────

  const pubClient = createClient({ url: config.redisUrl });
  const subClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);

  io.adapter(createAdapter(pubClient, subClient));

  // ─── Authentication middleware ──────────────────

  io.use(authenticateSocket);

  // ─── Connection handler ─────────────────────────

  io.on('connection', (socket) => {
    socket.data.subscribedCases = new Set();

    // Client subscribes to a case room
    socket.on('subscribe:case', (caseId) => {
      if (typeof caseId !== 'string') return;
      socket.join(`case:${caseId}`);
      socket.data.subscribedCases.add(caseId);
    });

    // Client unsubscribes from a case room
    socket.on('unsubscribe:case', (caseId) => {
      if (typeof caseId !== 'string') return;
      socket.leave(`case:${caseId}`);
      socket.data.subscribedCases.delete(caseId);
    });

    socket.on('disconnect', () => {
      socket.data.subscribedCases.clear();
    });
  });

  return io;
}

module.exports = { createWebSocketServer };
```

### File: `backend/src/websocket/auth.js`

```javascript
/**
 * Socket.io authentication middleware.
 *
 * Validates JWT token from the handshake auth or query parameter.
 * In Phase 1, this is permissive (logs warning if no token).
 * Full JWT validation is implemented in the Auth/RBAC epic.
 *
 * @param {import('socket.io').Socket} socket
 * @param {Function} next
 */
function authenticateSocket(socket, next) {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;

  if (!token) {
    // Phase 1: allow unauthenticated connections with warning
    socket.data.user = { id: 'anonymous', role: 'analyst' };
    return next();
  }

  try {
    // TODO: Full JWT validation in Auth epic
    // const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // socket.data.user = decoded;
    socket.data.user = { id: 'anonymous', role: 'analyst' };
    next();
  } catch (err) {
    next(new Error('Authentication failed'));
  }
}

module.exports = { authenticateSocket };
```

### File: `backend/src/websocket/events.js`

```javascript
const { createClient } = require('redis');

/**
 * Event types emitted via WebSocket.
 */
const CaseEventType = {
  STATE_CHANGED: 'case:state_changed',
  AGENT_STARTED: 'case:agent_started',
  AGENT_STEP_COMPLETED: 'case:agent_step_completed',
  AGENT_COMPLETED: 'case:agent_completed',
  FRAGMENT_ADDED: 'case:fragment_added',
  REVIEW_ASSIGNED: 'case:review_assigned',
  COMPLETED: 'case:completed',
};

const REDIS_CHANNEL = 'kyc:case-events';

/**
 * CaseEventEmitter — used by agent workers and services to publish events.
 *
 * Events are published to a Redis channel. The WebSocket server subscribes
 * to this channel and emits events to connected clients.
 *
 * @param {Object} config
 * @param {string} config.redisUrl
 */
class CaseEventEmitter {
  constructor(config) {
    this.redisUrl = config.redisUrl;
    this.publisher = null;
  }

  async connect() {
    this.publisher = createClient({ url: this.redisUrl });
    await this.publisher.connect();
  }

  /**
   * Emit a case event to Redis pub/sub.
   *
   * @param {string} eventType - One of CaseEventType values
   * @param {Object} payload - Event payload (must include caseId)
   */
  async emit(eventType, payload) {
    if (!this.publisher) throw new Error('CaseEventEmitter not connected');
    if (!payload.caseId) throw new Error('Event payload must include caseId');

    const message = JSON.stringify({
      eventType,
      payload,
      timestamp: new Date().toISOString(),
    });

    await this.publisher.publish(REDIS_CHANNEL, message);
  }

  async disconnect() {
    if (this.publisher) {
      await this.publisher.disconnect();
      this.publisher = null;
    }
  }
}

/**
 * CaseEventSubscriber — connects Socket.io to Redis pub/sub.
 *
 * Subscribes to the Redis channel and routes events to the correct
 * Socket.io room (case:{caseId}).
 *
 * @param {import('socket.io').Server} io
 * @param {Object} config
 * @param {string} config.redisUrl
 */
class CaseEventSubscriber {
  constructor(io, config) {
    this.io = io;
    this.redisUrl = config.redisUrl;
    this.subscriber = null;
  }

  async start() {
    this.subscriber = createClient({ url: this.redisUrl });
    await this.subscriber.connect();

    await this.subscriber.subscribe(REDIS_CHANNEL, (message) => {
      try {
        const { eventType, payload } = JSON.parse(message);
        this._routeEvent(eventType, payload);
      } catch (err) {
        // Log and continue — don't crash on malformed events
        console.error('Failed to process case event:', err.message);
      }
    });
  }

  /**
   * Route an event to the correct Socket.io room.
   *
   * Events are sent to:
   * 1. The case-specific room (`case:{caseId}`) for subscribed clients
   * 2. A global broadcast for dashboard-level events (state changes, completions)
   */
  _routeEvent(eventType, payload) {
    const { caseId } = payload;

    // Always emit to the case-specific room
    this.io.to(`case:${caseId}`).emit(eventType, payload);

    // Dashboard-level events also broadcast globally
    const globalEvents = [
      CaseEventType.STATE_CHANGED,
      CaseEventType.COMPLETED,
    ];

    if (globalEvents.includes(eventType)) {
      this.io.emit(eventType, payload);
    }
  }

  async stop() {
    if (this.subscriber) {
      await this.subscriber.unsubscribe(REDIS_CHANNEL);
      await this.subscriber.disconnect();
      this.subscriber = null;
    }
  }
}

module.exports = {
  CaseEventType,
  CaseEventEmitter,
  CaseEventSubscriber,
};
```

### Event Flow

```
Agent Worker (BullMQ)
  │
  │  await eventEmitter.emit('case:agent_completed', { caseId, agentType, ... })
  │
  ▼
Redis Pub/Sub (channel: kyc:case-events)
  │
  │  subscriber receives message
  │
  ▼
API Server (CaseEventSubscriber)
  │
  ├──► io.to('case:{caseId}').emit(...)   → Clients viewing this case
  │
  └──► io.emit(...)  (state changes only)  → All clients (dashboard kanban)
```

### Event Contracts

| Event | Payload | When Emitted | Global Broadcast |
|-------|---------|-------------|-----------------|
| `case:state_changed` | `{ caseId, oldState, newState }` | Orchestrator transitions case state | Yes |
| `case:agent_started` | `{ caseId, agentType }` | Agent worker begins execution | No |
| `case:agent_step_completed` | `{ caseId, agentType, stepId, stepName }` | Agent completes a step | No |
| `case:agent_completed` | `{ caseId, agentType, status, confidence }` | Agent finishes (success or error) | No |
| `case:fragment_added` | `{ caseId, fragment }` | New decision fragment created | No |
| `case:review_assigned` | `{ caseId, reviewerId }` | Case assigned to reviewer | No |
| `case:completed` | `{ caseId, riskRating, riskScore }` | Case reaches terminal state | Yes |

### Client-Side Integration

The frontend WebSocket store (from Epic 7 Story #39) connects and subscribes:

```javascript
// On dashboard mount — receive global events for kanban updates
socket.on('case:state_changed', ...)
socket.on('case:completed', ...)

// On case detail mount — subscribe to specific case
socket.emit('subscribe:case', caseId)
socket.on('case:agent_started', ...)
socket.on('case:agent_step_completed', ...)
socket.on('case:agent_completed', ...)
socket.on('case:fragment_added', ...)

// On case detail unmount
socket.emit('unsubscribe:case', caseId)
```

### Integration with Agent Workers

Agent workers import `CaseEventEmitter` and emit events at lifecycle points:

```javascript
// In BaseAgent._emitEvent() (Story #21)
await this.eventEmitter.emit(CaseEventType.AGENT_STEP_COMPLETED, {
  caseId: context.caseId,
  agentType: this.agentType,
  stepId: step.id,
  stepName: step.name,
});
```

```javascript
// In Orchestrator.transitionState() (Story #23)
await this.eventEmitter.emit(CaseEventType.STATE_CHANGED, {
  caseId,
  oldState,
  newState,
});
```

## Acceptance Criteria

- [ ] Socket.io server integrated with Fastify HTTP server
- [ ] Redis adapter configured for multi-process pub/sub
- [ ] `CaseEventEmitter` publishes events to Redis channel from agent workers
- [ ] `CaseEventSubscriber` routes Redis events to Socket.io rooms
- [ ] Seven event types emitted with correct payloads (see contracts table)
- [ ] Clients can `subscribe:case` to join a case-specific room
- [ ] Clients can `unsubscribe:case` to leave a case room
- [ ] Case-specific events only sent to subscribed clients
- [ ] `case:state_changed` and `case:completed` broadcast globally (for dashboard)
- [ ] Authentication middleware present (permissive in Phase 1, full JWT in Auth epic)
- [ ] Socket.io auto-reconnect configured (pingInterval, pingTimeout)
- [ ] Malformed events logged and skipped without crashing
- [ ] Event delivery latency < 500ms from worker publish to client receive

## Dependencies

- **Depends on**: #4 (Fastify backend — HTTP server for Socket.io), #3 (PostgreSQL — Redis is already in Docker Compose), #21 (BaseAgent — `_emitEvent()` integration point), #23 (Orchestrator — state transition events)
- **Blocks**: #39 (Dashboard — WebSocket store), #42 (Agent Progress — consumes agent events)

## Testing Strategy

1. **Server init**: Create WebSocket server, verify Socket.io instance returned
2. **Client connect**: Connect client, verify `connection` event fires
3. **Subscribe to case**: Emit `subscribe:case`, verify client joins room
4. **Unsubscribe from case**: Emit `unsubscribe:case`, verify client leaves room
5. **Event routing — case room**: Publish event for case A, verify only clients in `case:A` room receive it
6. **Event routing — global**: Publish `case:state_changed`, verify all clients receive it
7. **Event routing — non-global**: Publish `case:agent_started`, verify only case room receives it
8. **CaseEventEmitter — publish**: Emit event, verify published to Redis channel
9. **CaseEventEmitter — validation**: Emit without caseId, verify error thrown
10. **CaseEventSubscriber — receive**: Publish to Redis, verify Socket.io room receives event
11. **Malformed event**: Publish invalid JSON to Redis channel, verify logged and not crashed
12. **Disconnect cleanup**: Disconnect client, verify subscribedCases cleared
13. **Redis adapter**: Start two Socket.io servers on same Redis, verify events cross between them
14. **Latency**: Publish event from worker process, measure time to client receive, assert < 500ms
15. **Auth — no token (Phase 1)**: Connect without token, verify connection allowed with anonymous user
