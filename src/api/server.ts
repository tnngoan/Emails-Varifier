import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';
import { getRedis, closeQueue } from '../queue/client.js';
import { closePool } from '../db/client.js';
import { verifyRoute } from './routes/verify.js';
import { jobRoutes } from './routes/jobs.js';
import { config } from '../config/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Fastify API Server ───────────────────────────────────────────────────────

const fastify = Fastify({
  logger: {
    level:     process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
  },
});

// ─── Plugins ──────────────────────────────────────────────────────────────────

// API-level rate limiting (per IP, NOT per domain — that's in the worker)
await fastify.register(rateLimit, {
  redis:       getRedis(),
  max:         100,         // 100 requests per minute per IP
  timeWindow:  '1 minute',
  errorResponseBuilder: (_req, context) => ({
    statusCode: 429,
    error:      'Too Many Requests',
    message:    `Rate limit exceeded. Try again in ${Math.ceil(context.ttl / 1000)} seconds.`,
  }),
});

// ─── Static UI ───────────────────────────────────────────────────────────────

await fastify.register(fastifyStatic, {
  root:   join(__dirname, '../../public'),
  prefix: '/',
});

// ─── Routes ───────────────────────────────────────────────────────────────────

await fastify.register(verifyRoute, { prefix: '/' });
await fastify.register(jobRoutes,   { prefix: '/' });

// ─── Error Handler ────────────────────────────────────────────────────────────

fastify.setErrorHandler((error, _request, reply) => {
  const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
  fastify.log.error(error);
  reply.status(statusCode).send({
    statusCode,
    error:   error.name ?? 'Internal Server Error',
    message: error.message,
  });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  fastify.log.info(`Received ${signal} — shutting down...`);
  await fastify.close();
  await closeQueue();
  await closePool();
  fastify.log.info('Server shutdown complete.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Start ────────────────────────────────────────────────────────────────────

try {
  await fastify.listen({ host: config.api.host, port: config.api.port });
  fastify.log.info(`API server listening on ${config.api.host}:${config.api.port}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
