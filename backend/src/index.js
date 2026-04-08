'use strict';

const Fastify = require('fastify');
const Minio = require('minio');

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty' }
      : undefined,
  },
});

// ---------------------------------------------------------------------------
// MinIO client
// ---------------------------------------------------------------------------
const minioClient = new Minio.Client({
  endPoint:  process.env.MINIO_ENDPOINT  || 'localhost',
  port:      parseInt(process.env.MINIO_PORT) || 9000,
  useSSL:    false,
  accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
  secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
});

/**
 * Ensure the MinIO `documents` bucket exists.
 * Idempotent — safe to call on every startup.
 */
async function initMinIO() {
  const bucket = 'documents';
  try {
    const exists = await minioClient.bucketExists(bucket);
    if (!exists) {
      await minioClient.makeBucket(bucket);
      fastify.log.info({ bucket }, 'MinIO bucket created');
    } else {
      fastify.log.info({ bucket }, 'MinIO bucket already exists');
    }
  } catch (err) {
    // Log and continue — bucket init failure should not prevent API startup.
    // The API will retry on next restart (on-failure restart policy in compose).
    fastify.log.error({ err, bucket }, 'MinIO bucket initialization failed');
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
fastify.register(require('./api/routes/health'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const start = async () => {
  await initMinIO();

  try {
    await fastify.listen({ port: 4000, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
