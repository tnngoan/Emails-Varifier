import { FastifyInstance } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getQueue } from '../../queue/client.js';
import { createJob, insertEmailPlaceholders } from '../../db/queries.js';
import { bulkSyntaxFilter } from '../../verification/syntax.js';
import { suggestTypoFix } from '../../verification/typo.js';
import { parseVerifyBody } from '../middleware/validation.js';
import { VerifyResponse } from '../../types/index.js';

// ─── POST /verify ─────────────────────────────────────────────────────────────
//
// Accepts a batch of email addresses, filters out obvious syntax failures,
// creates a job record in PostgreSQL, inserts email placeholders, then
// enqueues individual verification jobs into Redis/BullMQ.
//
// Returns immediately with a job_id — clients poll GET /status/:id.

export async function verifyRoute(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: unknown; Reply: VerifyResponse }>(
    '/verify',
    {
      schema: {
        body: {
          type: 'object',
          required: ['emails'],
          properties: {
            emails: {
              type: 'array',
              items: { type: 'string' },
              description: 'List of email addresses to verify',
            },
            webhook_url: {
              type: 'string',
              description: 'Optional URL to POST results when the job completes',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = parseVerifyBody(request, reply);
      const { emails, webhook_url } = body;

      // ── Step 1: Syntax pre-filter ───────────────────────────────────────────
      // Reject obviously malformed addresses immediately — avoids wasting queue
      // slots on addresses that will never pass verification.
      const { valid: validEmails, invalid: invalidEmails } = bulkSyntaxFilter(emails);

      if (validEmails.length === 0) {
        return reply.status(422).send({
          job_id: '',
          queued: 0,
          invalid_syntax: invalidEmails,
          message: 'All provided emails failed syntax validation',
        } as unknown as VerifyResponse);
      }

      // ── Step 2: Typo detection (point-of-capture) ──────────────────────────
      // Returned synchronously so callers can prompt users to fix typos before
      // the async job even starts.
      const typoSuggestions: Array<{ original: string; suggestion: string }> = [];
      for (const email of validEmails) {
        const suggestion = suggestTypoFix(email);
        if (suggestion) typoSuggestions.push({ original: email, suggestion });
      }

      // ── Step 3: Deduplicate ──────────────────────────────────────────────────
      const unique = [...new Set(validEmails)];

      // ── Step 3: Create job record ────────────────────────────────────────────
      const jobId = uuidv4();
      await createJob(jobId, unique.length, webhook_url);

      // ── Step 5: Persist email placeholders (batch insert) ────────────────────────
      await insertEmailPlaceholders(jobId, unique);

      // ── Step 6: Enqueue individual email jobs ────────────────────────────────────────────
      const queue  = getQueue();
      const CHUNK  = 1_000; // BullMQ addBulk is more efficient in chunks

      for (let i = 0; i < unique.length; i += CHUNK) {
        const chunk = unique.slice(i, i + CHUNK);
        await queue.addBulk(
          chunk.map((email) => ({
            name:  'verify-email',
            data:  { job_id: jobId, email },
            opts: {
              jobId: `${jobId}|${email}`, // idempotency key — prevents duplicates on re-submit
            },
          }))
        );
      }

      fastify.log.info(
        { jobId, queued: unique.length, syntaxRejected: invalidEmails.length },
        'Verification job created'
      );

      return reply.status(202).send({
        job_id:           jobId,
        queued:           unique.length,
        invalid_syntax:   invalidEmails,
        typo_suggestions: typoSuggestions,
        message:          `Job created. ${unique.length} emails queued for verification.`,
      });
    }
  );
}
