import { Worker, WorkerOptions } from 'bullmq';
import { getRedis } from '../queue/client.js';
import { closePool } from '../db/client.js';
import { processEmailJob, handleFailedJob } from './processor.js';
import { config } from '../config/index.js';
import { EmailJobData } from '../types/index.js';

// ─── BullMQ Worker Entry Point ────────────────────────────────────────────────
//
// Each Worker instance polls Redis for jobs and processes them concurrently
// up to the configured concurrency limit.
//
// Scale horizontally by running multiple copies of this process:
//   docker-compose up --scale worker=4
//
// Each worker process is stateless — Redis coordinates job distribution.

console.log('[Worker] Starting email verification worker...');
console.log(`[Worker] Concurrency: ${config.worker.concurrency}`);
console.log(`[Worker] Queue: ${config.redis.queueName}`);

const workerOptions: WorkerOptions = {
  // Cast needed: project ioredis v5.10 vs BullMQ-bundled ioredis v5.9 type mismatch
  connection: getRedis() as any,
  concurrency: config.worker.concurrency,

  // Stagger job start by a small random amount to avoid thundering-herd
  // on shared MX servers when many workers start simultaneously.
  lockDuration: 30_000, // ms — how long a job can be held before re-queuing

  // BullMQ stalledInterval: periodically check for stalled jobs
  stalledInterval: 30_000,
  maxStalledCount: 2,
};

const worker = new Worker<EmailJobData>(
  config.redis.queueName,
  processEmailJob,
  workerOptions
);

// ─── Event Listeners ──────────────────────────────────────────────────────────

worker.on('completed', (job) => {
  console.log(`[Worker] ✓ Completed job ${job.id} for email: ${job.data.email}`);
});

worker.on('failed', async (job, err) => {
  if (!job) return;

  const isMaxRetry = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (isMaxRetry) {
    await handleFailedJob(job, err);
  } else {
    console.warn(
      `[Worker] ✗ Job ${job.id} failed (attempt ${job.attemptsMade}): ${err.message}`
    );
  }
});

worker.on('error', (err) => {
  console.error('[Worker] Worker-level error:', err);
});

worker.on('stalled', (jobId) => {
  console.warn(`[Worker] Job ${jobId} stalled — will be re-queued`);
});

// ─── Metrics logging (every 60s) ─────────────────────────────────────────────
setInterval(async () => {
  try {
    const counts = await worker.client.then
      ? undefined
      : undefined; // placeholder — real metrics can use Bull Board
    void counts;
  } catch {
    // non-critical
  }
}, 60_000);

// ─── Graceful shutdown ────────────────────────────────────────────────────────
// Allow in-flight jobs to complete before exiting.

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[Worker] Received ${signal} — shutting down gracefully...`);
  await worker.close();
  await closePool();
  console.log('[Worker] Shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('[Worker] Uncaught exception:', err);
  void shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('[Worker] Unhandled rejection:', reason);
});

console.log('[Worker] Ready and listening for jobs.');
