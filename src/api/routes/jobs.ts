import { FastifyInstance } from 'fastify';
import { getJobStatus, getJobResult } from '../../db/queries.js';
import { JobStatusResponse, JobResultResponse } from '../../types/index.js';

// ─── GET /status/:job_id ──────────────────────────────────────────────────────
// Returns lightweight progress info — no result rows, safe to poll frequently.

// ─── GET /result/:job_id ──────────────────────────────────────────────────────
// Returns full result set with all email statuses.
// For very large jobs (100k+ emails) callers should use pagination (future work).

export async function jobRoutes(fastify: FastifyInstance): Promise<void> {
  // ── GET /status/:job_id ───────────────────────────────────────────────────
  fastify.get<{ Params: { job_id: string }; Reply: JobStatusResponse }>(
    '/status/:job_id',
    {
      schema: {
        params: {
          type: 'object',
          properties: { job_id: { type: 'string', format: 'uuid' } },
          required: ['job_id'],
        },
      },
    },
    async (request, reply) => {
      const { job_id } = request.params;
      const status = await getJobStatus(job_id);

      if (!status) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Job ${job_id} not found`,
        } as unknown as JobStatusResponse);
      }

      return reply.send(status);
    }
  );

  // ── GET /result/:job_id ───────────────────────────────────────────────────
  fastify.get<{ Params: { job_id: string }; Reply: JobResultResponse }>(
    '/result/:job_id',
    {
      schema: {
        params: {
          type: 'object',
          properties: { job_id: { type: 'string', format: 'uuid' } },
          required: ['job_id'],
        },
      },
    },
    async (request, reply) => {
      const { job_id } = request.params;
      const result = await getJobResult(job_id);

      if (!result) {
        return reply.status(404).send({
          statusCode: 404,
          error: 'Not Found',
          message: `Job ${job_id} not found`,
        } as unknown as JobResultResponse);
      }

      return reply.send(result);
    }
  );

  // ── GET /health ───────────────────────────────────────────────────────────
  fastify.get(
    '/health',
    {},
    async (_req, reply) => {
      return reply.send({ status: 'ok', timestamp: new Date().toISOString() });
    }
  );
}
