// ─── Verification Status Enum ────────────────────────────────────────────────
export enum VerificationStatus {
  VALID = 'VALID',             // SMTP confirmed mailbox exists
  INVALID = 'INVALID',         // SMTP confirmed mailbox does not exist (550)
  CATCH_ALL = 'CATCH_ALL',     // Domain accepts all addresses
  NO_MX = 'NO_MX',            // No MX records found
  DOMAIN_INVALID = 'DOMAIN_INVALID', // Domain does not resolve at all
  GREYLISTED = 'GREYLISTED',   // Temporary rejection, max retries exhausted
  UNKNOWN = 'UNKNOWN',         // Unclassifiable result (timeouts, errors)
}

// ─── Verification Job States ─────────────────────────────────────────────────
export type JobState = 'pending' | 'processing' | 'completed' | 'failed';

// ─── Core Result per Email ────────────────────────────────────────────────────
export interface EmailVerificationResult {
  email: string;
  status: VerificationStatus;
  // ── SMTP ────────────────────────────────────────────────────────────────────
  mx_host?: string;
  smtp_response_code?: number;
  smtp_response_message?: string;
  is_catch_all?: boolean;
  // ── Disposable / Role detection ──────────────────────────────────────────────
  is_disposable?: boolean;  // domain is a known temporary/burner provider
  is_role_based?: boolean;  // local-part is a generic alias (admin@, info@, etc.)
  // ── DNS Authentication ───────────────────────────────────────────────────────
  has_spf?: boolean;        // domain publishes an SPF record
  has_dmarc?: boolean;      // domain publishes a DMARC policy
  has_dkim?: boolean;       // domain publishes a DKIM public key
  // ── Extra signals ────────────────────────────────────────────────────────────
  typo_suggestion?: string;    // suggested correction if domain looks like a typo
  gravatar_exists?: boolean;   // Gravatar profile found (strong "real account" signal)
  // ── Score ────────────────────────────────────────────────────────────────────
  risk_score?: number;         // 0 (low risk / trusted) – 100 (high risk / likely fake)
  // ── Meta ─────────────────────────────────────────────────────────────────────
  verification_time_ms?: number;
  error?: string;
}

// ─── BullMQ Job Payload ───────────────────────────────────────────────────────
export interface EmailJobData {
  job_id: string;    // Parent verification batch job ID
  email: string;
  attempt?: number;  // Tracks manual retry count for greylisting
}

// ─── Domain Rate-limit Config ─────────────────────────────────────────────────
export interface DomainRateLimit {
  maxConcurrent: number; // Max simultaneous SMTP connections to this domain
  delayMs?: number;      // Optional fixed delay between connections
}

// ─── SMTP Connection Config ───────────────────────────────────────────────────
export interface SmtpConfig {
  heloHost: string;         // Our EHLO hostname (must match PTR/rDNS)
  fromAddress: string;      // MAIL FROM probe address
  timeoutMs: number;        // Socket connection + read timeout
  port: number;             // SMTP port (25 for direct MX checks)
}

// ─── DNS Lookup Result ────────────────────────────────────────────────────────
export interface MxRecord {
  exchange: string; // MX hostname
  priority: number; // Lower = higher priority
}

// ─── Greylisting Retry Schedule ───────────────────────────────────────────────
export const GREYLIST_RETRY_DELAYS_MS = [
  60_000,   // 1 minute
  300_000,  // 5 minutes
  900_000,  // 15 minutes
];

// ─── Per-Domain Concurrency Limits ───────────────────────────────────────────
// Domains known to throttle aggressive checkers get lower concurrency caps
export const DOMAIN_CONCURRENCY_LIMITS: Record<string, DomainRateLimit> = {
  'gmail.com':    { maxConcurrent: 5 },
  'googlemail.com': { maxConcurrent: 5 },
  'yahoo.com':    { maxConcurrent: 3 },
  'yahoo.co.uk':  { maxConcurrent: 3 },
  'hotmail.com':  { maxConcurrent: 3 },
  'outlook.com':  { maxConcurrent: 3 },
  'live.com':     { maxConcurrent: 3 },
  'aol.com':      { maxConcurrent: 2 },
  'icloud.com':   { maxConcurrent: 2 },
  'protonmail.com': { maxConcurrent: 2 },
};

export const DEFAULT_DOMAIN_CONCURRENCY = 10;

// ─── API Request/Response shapes ─────────────────────────────────────────────
export interface VerifyRequestBody {
  emails: string[];
  webhook_url?: string; // Optional callback when job completes
}

export interface VerifyResponse {
  job_id: string;
  queued: number;
  invalid_syntax: string[];
  // Point-of-capture typo suggestions returned synchronously at submit time
  typo_suggestions: Array<{ original: string; suggestion: string }>;
  message: string;
}

export interface JobStatusResponse {
  job_id: string;
  state: JobState;
  total: number;
  completed: number;
  failed: number;
  progress_pct: number;
  created_at: string;
  completed_at?: string;
}

export interface JobResultResponse {
  job_id: string;
  state: JobState;
  results: EmailVerificationResult[];
  summary: {
    total: number;
    valid: number;
    invalid: number;
    catch_all: number;
    no_mx: number;
    domain_invalid: number;
    greylisted: number;
    unknown: number;
  };
}
