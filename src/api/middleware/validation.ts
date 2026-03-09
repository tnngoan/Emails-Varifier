import { FastifyRequest, FastifyReply } from 'fastify';
import { z, ZodError } from 'zod';
import { config } from '../../config/index.js';

// ─── Request Schemas ──────────────────────────────────────────────────────────

export const VerifyBodySchema = z.object({
  emails: z
    .array(z.string().min(1).max(320))
    .min(1, 'At least one email is required')
    .max(config.api.maxEmailsPerRequest, `Max ${config.api.maxEmailsPerRequest} emails per request`),
  webhook_url: z.string().url().optional(),
});

export type VerifyBody = z.infer<typeof VerifyBodySchema>;

// ─── Validation Middleware ────────────────────────────────────────────────────

export function parseVerifyBody(
  req: FastifyRequest,
  _reply: FastifyReply
): VerifyBody {
  try {
    return VerifyBodySchema.parse(req.body);
  } catch (err) {
    if (err instanceof ZodError) {
      throw {
        statusCode: 400,
        error: 'Bad Request',
        message: err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
      };
    }
    throw err;
  }
}
