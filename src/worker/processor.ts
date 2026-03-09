import { Job, UnrecoverableError } from 'bullmq';
import { verifyEmail } from '../verification/pipeline.js';
import { updateEmailResult, markJobProcessing } from '../db/queries.js';
import { acquireDomainSlot, releaseDomainSlot } from '../queue/rateLimiter.js';
import { getRedis } from '../queue/client.js';
import {
  EmailJobData,
  VerificationStatus,
  GREYLIST_RETRY_DELAYS_MS,
} from '../types/index.js';

// ─── Job Processor ────────────────────────────────────────────────────────────
//
// This function is called by BullMQ's Worker for every dequeued job.
// It is responsible for:
//
//   1. Acquiring a per-domain concurrency slot (rate limiting)
//   2. Running the full verification pipeline
//   3. Persisting the result to PostgreSQL
//   4. Releasing the domain slot
//   5. Handling greylist retries with exponential backoff
//
// If the result is GREYLISTED and we haven't exhausted our custom retry
// budget, we throw a retryable error so BullMQ re-queues the job with
// exponential backoff delays defined in GREYLIST_RETRY_DELAYS_MS.

const MAX_GREYLIST_RETRIES = GREYLIST_RETRY_DELAYS_MS.length;

export async function processEmailJob(job: Job<EmailJobData>): Promise<void> {
  const { job_id, email } = job.data;
  const attempt = job.attemptsMade; // 0-based; BullMQ increments before calling processor

  // Mark parent job as processing on first attempt
  if (attempt === 0) {
    await markJobProcessing(job_id).catch(() => undefined);
  }

  console.log(`[Worker] Processing: ${email} (attempt ${attempt + 1}, job ${job_id})`);

  // ── Extract domain for rate limiting ──────────────────────────────────────
  const atIndex = email.lastIndexOf('@');
  const domain  = atIndex >= 0 ? email.slice(atIndex + 1).toLowerCase() : '';

  const redis = getRedis();
  const slotAcquired = domain
    ? await acquireDomainSlot(redis, domain)
    : true;

  if (!slotAcquired) {
    // Could not acquire domain slot within timeout — re-queue
    // Throwing here means BullMQ will retry according to backoff config
    throw new Error(`[RateLimit] Could not acquire slot for domain: ${domain}`);
  }

  let verificationResult;
  try {
    verificationResult = await verifyEmail(email);
  } finally {
    if (domain) {
      await releaseDomainSlot(redis, domain).catch((e) => {
        console.error(`[Worker] Failed to release slot for ${domain}:`, e);
      });
    }
  }

  // ── Greylisting retry logic ───────────────────────────────────────────────
  if (verificationResult.status === VerificationStatus.GREYLISTED) {
    if (attempt < MAX_GREYLIST_RETRIES) {
      const delayMs = GREYLIST_RETRY_DELAYS_MS[attempt] ?? GREYLIST_RETRY_DELAYS_MS.at(-1)!;
      console.log(
        `[Worker] ${email} greylisted — scheduling retry in ${delayMs / 1000}s ` +
        `(attempt ${attempt + 1}/${MAX_GREYLIST_RETRIES})`
      );
      // Throw with a delay hint; BullMQ's backoff config handles the actual wait
      throw new Error(
        `GREYLISTED:${delayMs} — ${verificationResult.smtp_response_message ?? ''}`
      );
    }

    // Max greylist retries exhausted — persist as GREYLISTED and move on
    console.log(`[Worker] ${email} max greylist retries exhausted — marking GREYLISTED`);
  }

  // ── Persist result ────────────────────────────────────────────────────────
  await updateEmailResult(job_id, verificationResult);

  console.log(
    `[Worker] Done: ${email} → ${verificationResult.status} ` +
    `(${verificationResult.verification_time_ms}ms)`
  );
}

/**
 * Called by BullMQ when all retry attempts are exhausted.
 * We persist UNKNOWN so the result row isn't stuck as 'pending'.
 */
export async function handleFailedJob(
  job: Job<EmailJobData>,
  err: Error
): Promise<void> {
  const { job_id, email } = job.data;
  console.error(`[Worker] Job permanently failed for ${email}:`, err.message);

  // Avoid infinite failure loops with UnrecoverableError
  if (err instanceof UnrecoverableError) return;

  await updateEmailResult(job_id, {
    email,
    status: VerificationStatus.UNKNOWN,
    error:  err.message,
  }).catch((dbErr) => {
    console.error('[Worker] Failed to persist failure result:', dbErr);
  });
}
