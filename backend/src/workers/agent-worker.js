'use strict';

// Agent worker — BullMQ consumer
// Full implementation in epic-04-agent-framework.

const { Worker } = require('bullmq');

const connection = {
  host: (process.env.REDIS_URL || 'redis://redis:6379').replace('redis://', '').split(':')[0],
  port: parseInt((process.env.REDIS_URL || 'redis://redis:6379').split(':')[2]) || 6379,
};

const worker = new Worker('agent-jobs', async (job) => {
  console.log(`[agent-worker] Processing job ${job.id} (type: ${job.name})`);
  // Agent pipeline implemented in epic-04-agent-framework
}, { connection });

worker.on('completed', (job) => {
  console.log(`[agent-worker] Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.error(`[agent-worker] Job ${job?.id} failed:`, err.message);
});

console.log('[agent-worker] Worker started, waiting for jobs…');
