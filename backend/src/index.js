'use strict';

require('dotenv').config();

const fastify = require('fastify');
const cors = require('@fastify/cors');

/**
 * Build and configure the Fastify application instance.
 * Exported for use in tests via app.inject() without binding a port.
 *
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
async function buildServer() {
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
  });

  // ---------------------------------------------------------------------------
  // Structured error handler
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // 404 handler — returns standard error envelope for unknown routes
  // ---------------------------------------------------------------------------
  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route ${request.method}:${request.url} not found`,
      },
    });
  });

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------
  await app.register(require('./api/routes/health'));

  // TODO: Register additional route plugins as they are implemented
  // await app.register(require('./api/cases'), { prefix: '/api/v1' });
  // await app.register(require('./api/review'), { prefix: '/api/v1' });
  // await app.register(require('./api/config'), { prefix: '/api/v1' });
  // await app.register(require('./api/admin'), { prefix: '/api/v1' });
  // await app.register(require('./api/auth'), { prefix: '/api/v1' });

  return app;
}

/**
 * Start the server, binding to the configured port and host.
 * Only called when this file is the entry point (not during tests).
 */
async function start() {
  const app = await buildServer();
  const port = parseInt(process.env.PORT || '4000', 10);
  const host = process.env.HOST || '0.0.0.0';

  try {
    await app.listen({ port, host });
  } catch (err) {
    app.log.fatal(err);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown — 10-second drain window then force-exit
  // ---------------------------------------------------------------------------
  const shutdown = async (signal) => {
    app.log.info(`Received ${signal}, shutting down gracefully...`);
    const forceExit = setTimeout(() => {
      app.log.warn('Drain timeout exceeded — forcing exit');
      process.exit(1);
    }, 10_000).unref();
    await app.close();
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start();
}

module.exports = { buildServer };
