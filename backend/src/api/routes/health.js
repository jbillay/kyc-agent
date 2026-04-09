'use strict';

/**
 * Health check route.
 * GET /api/v1/admin/system/health → 200 { status, timestamp, uptime }
 *
 * Used by:
 *   - Docker healthcheck
 *   - Container orchestrators / load balancers
 *   - Operator diagnostics
 */
async function healthRoutes(fastify) {
  fastify.get('/api/v1/admin/system/health', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status:    { type: 'string' },
            timestamp: { type: 'string' },
            uptime:    { type: 'number' },
          },
          required: ['status', 'timestamp', 'uptime'],
        },
      },
    },
  }, async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });
}

module.exports = healthRoutes;
