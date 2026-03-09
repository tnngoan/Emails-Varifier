import { PoolClient } from 'pg';
import { query, withTransaction } from './client.js';
import {
  EmailVerificationResult,
  JobState,
  JobResultResponse,
  JobStatusResponse,
  VerificationStatus,
} from '../types/index.js';

// ─── Job Queries ──────────────────────────────────────────────────────────────

export async function createJob(
  jobId: string,
  emailCount: number,
  webhookUrl?: string
): Promise<void> {
  await query(
    `INSERT INTO verification_jobs (id, state, total, webhook_url)
     VALUES ($1, 'pending', $2, $3)`,
    [jobId, emailCount, webhookUrl ?? null]
  );
}

export async function getJobStatus(jobId: string): Promise<JobStatusResponse | null> {
  const rows = await query<{
    job_id: string;
    state: JobState;
    total: number;
    completed: number;
    failed_count: number;
    progress_pct: string;
    created_at: Date;
    completed_at: Date | null;
  }>(
    `SELECT job_id, state, total, completed, failed_count, progress_pct, created_at, completed_at
     FROM job_progress
     WHERE job_id = $1`,
    [jobId]
  );

  if (!rows.length) return null;
  const r = rows[0];
  return {
    job_id:        r.job_id,
    state:         r.state,
    total:         r.total,
    completed:     r.completed,
    failed:        r.failed_count,
    progress_pct:  parseFloat(r.progress_pct ?? '0'),
    created_at:    r.created_at.toISOString(),
    completed_at:  r.completed_at?.toISOString(),
  };
}

export async function getJobResult(jobId: string): Promise<JobResultResponse | null> {
  // Verify job exists
  const jobs = await query<{ state: JobState }>(
    `SELECT state FROM verification_jobs WHERE id = $1`,
    [jobId]
  );
  if (!jobs.length) return null;

  const results = await query<{
    email: string;
    status: VerificationStatus;
    mx_host: string | null;
    smtp_response_code: number | null;
    smtp_response_message: string | null;
    is_catch_all: boolean;
    verification_time_ms: number | null;
    is_disposable: boolean;
    is_role_based: boolean;
    has_spf: boolean | null;
    has_dmarc: boolean | null;
    has_dkim: boolean | null;
    typo_suggestion: string | null;
    gravatar_exists: boolean | null;
    risk_score: number | null;
  }>(
    `SELECT email, status, mx_host, smtp_response_code, smtp_response_message,
            is_catch_all, verification_time_ms,
            is_disposable, is_role_based,
            has_spf, has_dmarc, has_dkim,
            typo_suggestion, gravatar_exists, risk_score
     FROM email_results
     WHERE job_id = $1
     ORDER BY created_at ASC`,
    [jobId]
  );

  const mapped: EmailVerificationResult[] = results.map((r) => ({
    email:                  r.email,
    status:                 r.status,
    mx_host:                r.mx_host              ?? undefined,
    smtp_response_code:     r.smtp_response_code    ?? undefined,
    smtp_response_message:  r.smtp_response_message ?? undefined,
    is_catch_all:           r.is_catch_all,
    verification_time_ms:   r.verification_time_ms  ?? undefined,
    is_disposable:          r.is_disposable,
    is_role_based:          r.is_role_based,
    has_spf:                r.has_spf               ?? undefined,
    has_dmarc:              r.has_dmarc             ?? undefined,
    has_dkim:               r.has_dkim              ?? undefined,
    typo_suggestion:        r.typo_suggestion        ?? undefined,
    gravatar_exists:        r.gravatar_exists        ?? undefined,
    risk_score:             r.risk_score             ?? undefined,
  }));

  const summary = {
    total:          mapped.length,
    valid:          mapped.filter((r) => r.status === VerificationStatus.VALID).length,
    invalid:        mapped.filter((r) => r.status === VerificationStatus.INVALID).length,
    catch_all:      mapped.filter((r) => r.status === VerificationStatus.CATCH_ALL).length,
    no_mx:          mapped.filter((r) => r.status === VerificationStatus.NO_MX).length,
    domain_invalid: mapped.filter((r) => r.status === VerificationStatus.DOMAIN_INVALID).length,
    greylisted:     mapped.filter((r) => r.status === VerificationStatus.GREYLISTED).length,
    unknown:        mapped.filter((r) => r.status === VerificationStatus.UNKNOWN).length,
  };

  return { job_id: jobId, state: jobs[0].state, results: mapped, summary };
}

// ─── Email Result Queries ─────────────────────────────────────────────────────

/**
 * Bulk-insert email placeholders so we can track them before processing.
 * Uses chunked inserts to avoid exceeding PostgreSQL's parameter limit (~65k).
 */
export async function insertEmailPlaceholders(
  jobId: string,
  emails: string[]
): Promise<void> {
  const CHUNK = 500;
  await withTransaction(async (client: PoolClient) => {
    for (let i = 0; i < emails.length; i += CHUNK) {
      const chunk = emails.slice(i, i + CHUNK);
      const values = chunk
        .map((_, j) => `($1, $${j + 2}, 'pending')`)
        .join(', ');
      await client.query(
        `INSERT INTO email_results (job_id, email, status) VALUES ${values}
         ON CONFLICT (job_id, email) DO NOTHING`,
        [jobId, ...chunk]
      );
    }
  });
}

/** Update a single email result after verification completes. */
export async function updateEmailResult(
  jobId: string,
  result: EmailVerificationResult
): Promise<void> {
  await query(
    `UPDATE email_results SET
       status                 = $3,
       mx_host                = $4,
       smtp_response_code     = $5,
       smtp_response_message  = $6,
       is_catch_all           = $7,
       verification_time_ms   = $8,
       is_disposable          = $9,
       is_role_based          = $10,
       has_spf                = $11,
       has_dmarc              = $12,
       has_dkim               = $13,
       typo_suggestion        = $14,
       gravatar_exists        = $15,
       risk_score             = $16,
       completed_at           = NOW()
     WHERE job_id = $1 AND email = $2`,
    [
      jobId,
      result.email,
      result.status,
      result.mx_host                ?? null,
      result.smtp_response_code     ?? null,
      result.smtp_response_message  ?? null,
      result.is_catch_all           ?? false,
      result.verification_time_ms   ?? null,
      result.is_disposable          ?? false,
      result.is_role_based          ?? false,
      result.has_spf                ?? null,
      result.has_dmarc              ?? null,
      result.has_dkim               ?? null,
      result.typo_suggestion        ?? null,
      result.gravatar_exists        ?? null,
      result.risk_score             ?? null,
    ]
  );

  // Atomically increment the completed counter on the parent job
  await query(
    `UPDATE verification_jobs
     SET completed = completed + 1,
         state     = CASE WHEN (completed + 1) >= total THEN 'completed' ELSE state END,
         completed_at = CASE WHEN (completed + 1) >= total THEN NOW() ELSE completed_at END
     WHERE id = $1`,
    [jobId]
  );
}

// ─── Domain Cache Queries ─────────────────────────────────────────────────────

export interface CachedDomain {
  mx_host:       string | null;
  has_mx:        boolean;
  is_catch_all:  boolean | null;
  has_spf:       boolean | null;
  has_dmarc:     boolean | null;
  has_dkim:      boolean | null;
  dkim_selector: string | null;
}

export async function getCachedDomain(domain: string): Promise<CachedDomain | null> {
  const rows = await query<CachedDomain>(
    `SELECT mx_host, has_mx, is_catch_all, has_spf, has_dmarc, has_dkim, dkim_selector
     FROM domain_cache
     WHERE domain = $1 AND expires_at > NOW()`,
    [domain]
  );
  return rows[0] ?? null;
}

export async function upsertDomainCache(
  domain: string,
  data: CachedDomain
): Promise<void> {
  await query(
    `INSERT INTO domain_cache
       (domain, mx_host, has_mx, is_catch_all, has_spf, has_dmarc, has_dkim, dkim_selector, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + INTERVAL '24 hours')
     ON CONFLICT (domain) DO UPDATE SET
       mx_host       = EXCLUDED.mx_host,
       has_mx        = EXCLUDED.has_mx,
       is_catch_all  = EXCLUDED.is_catch_all,
       has_spf       = EXCLUDED.has_spf,
       has_dmarc     = EXCLUDED.has_dmarc,
       has_dkim      = EXCLUDED.has_dkim,
       dkim_selector = EXCLUDED.dkim_selector,
       cached_at     = NOW(),
       expires_at    = NOW() + INTERVAL '24 hours'`,
    [domain, data.mx_host, data.has_mx, data.is_catch_all,
     data.has_spf ?? null, data.has_dmarc ?? null,
     data.has_dkim ?? null, data.dkim_selector ?? null]
  );
}

/** Mark job as processing when the first worker picks it up. */
export async function markJobProcessing(jobId: string): Promise<void> {
  await query(
    `UPDATE verification_jobs SET state = 'processing' WHERE id = $1 AND state = 'pending'`,
    [jobId]
  );
}
