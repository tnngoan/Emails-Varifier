// ─── Centralised Configuration ────────────────────────────────────────────────
// All environment variables are read once at startup; missing required vars
// throw immediately so broken deploys fail fast.

function optional(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function optionalInt(key: string, fallback: number): number {
  const val = process.env[key];
  return val ? parseInt(val, 10) : fallback;
}

export const config = {
  // ── Server ──────────────────────────────────────────────────────────────────
  api: {
    host: optional('API_HOST', '0.0.0.0'),
    port: optionalInt('API_PORT', 3003),
    // Max emails accepted in a single POST /verify request
    maxEmailsPerRequest: optionalInt('MAX_EMAILS_PER_REQUEST', 100_000),
  },

  // ── PostgreSQL ───────────────────────────────────────────────────────────────
  db: {
    url: optional(
      'DATABASE_URL',
      'postgresql://postgres:postgres@localhost:5432/email_verifier'
    ),
    poolMin: optionalInt('DB_POOL_MIN', 2),
    poolMax: optionalInt('DB_POOL_MAX', 10),
  },

  // ── Redis ────────────────────────────────────────────────────────────────────
  redis: {
    url: optional('REDIS_URL', 'redis://localhost:6379'),
    // BullMQ queue name for individual email verification jobs
    queueName: optional('QUEUE_NAME', 'email-verification'),
  },

  // ── SMTP Verification ────────────────────────────────────────────────────────
  smtp: {
    // EHLO hostname — MUST match your PTR (rDNS) record for deliverability
    heloHost: optional('SMTP_HELO_HOST', 'verifier.example.com'),
    // Probe "from" address — does not need to be real
    fromAddress: optional('SMTP_FROM_ADDRESS', 'probe@verifier.example.com'),
    // Socket timeout in ms (5–10 s recommended)
    timeoutMs: optionalInt('SMTP_TIMEOUT_MS', 8_000),
    port: optionalInt('SMTP_PORT', 25),
  },

  // ── Worker ───────────────────────────────────────────────────────────────────
  worker: {
    // How many jobs this worker processes concurrently.
    // Keep low on local dev (macOS DNS resolver saturates at high concurrency).
    concurrency: optionalInt('WORKER_CONCURRENCY', 5),
    // Max BullMQ retries for a single job (on top of app-level greylist retries)
    maxRetries: optionalInt('WORKER_MAX_RETRIES', 3),
  },

  // ── Rate Limiting ────────────────────────────────────────────────────────────
  rateLimit: {
    // Redis key TTL (seconds) for per-domain concurrency counters
    domainWindowSec: optionalInt('DOMAIN_RATE_WINDOW_SEC', 60),
    // Default max concurrent SMTP connections to unknown domains
    defaultMaxConcurrent: optionalInt('DEFAULT_MAX_CONCURRENT', 10),
  },
  // ── Verification Feature Flags ────────────────────────────────────────────────
  verification: {
    // Block disposable / temporary email providers (default: on)
    checkDisposable: optional('VERIFY_DISPOSABLE', 'true') !== 'false',
    // Verify SPF, DMARC, and DKIM DNS records (default: on)
    checkDnsAuth:    optional('VERIFY_DNS_AUTH', 'true') !== 'false',
    // Probe Gravatar for a "real account" signal. Makes one HTTP request per
    // email — opt-in only because it adds latency at scale (default: off)
    checkGravatar:   optional('VERIFY_GRAVATAR', 'false') === 'true',
  },} as const;
