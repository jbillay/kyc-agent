'use strict';

/**
 * Health check route.
 * GET /health → 200 { status: 'ok' }
 *
 * Used by:
 *   - docker-compose healthcheck (wget http://localhost:4000/health)
 *   - Load balancers / orchestrators
 *   - Manual operator diagnostics
 */
async function healthRoutes(fastify) {
  fastify.get('/health', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
          },
        },
      },
    },
  }, async () => {
    return { status: 'ok' };
  });
}

module.exports = healthRoutes;
