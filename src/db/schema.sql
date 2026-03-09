-- ─────────────────────────────────────────────────────────────────────────────
-- Email Verifier — PostgreSQL Schema
-- Run once: psql $DATABASE_URL -f src/db/schema.sql
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ─── Verification Jobs ────────────────────────────────────────────────────────
-- One row per POST /verify call. Tracks the overall batch lifecycle.
CREATE TABLE IF NOT EXISTS verification_jobs (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  state        TEXT        NOT NULL DEFAULT 'pending'
                           CHECK (state IN ('pending','processing','completed','failed')),
  total        INTEGER     NOT NULL DEFAULT 0,   -- total emails submitted
  completed    INTEGER     NOT NULL DEFAULT 0,   -- processed (any terminal status)
  failed_count INTEGER     NOT NULL DEFAULT 0,   -- processing errors (not INVALID)
  webhook_url  TEXT,                             -- optional POST callback on completion
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_jobs_state ON verification_jobs (state);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON verification_jobs (created_at DESC);

-- ─── Email Results ────────────────────────────────────────────────────────────
-- One row per email address in a job.
CREATE TABLE IF NOT EXISTS email_results (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id               UUID        NOT NULL REFERENCES verification_jobs(id) ON DELETE CASCADE,
  email                TEXT        NOT NULL,
  status               TEXT        NOT NULL DEFAULT 'pending'
                                   CHECK (status IN (
                                     'pending','VALID','INVALID','CATCH_ALL',
                                     'NO_MX','DOMAIN_INVALID','GREYLISTED','UNKNOWN'
                                   )),
  mx_host              TEXT,                   -- MX record used for SMTP check
  smtp_response_code   INTEGER,                -- Raw SMTP response code (250, 550, etc.)
  smtp_response_message TEXT,                  -- Full SMTP response line
  is_catch_all         BOOLEAN     DEFAULT FALSE,
  verification_time_ms INTEGER,                -- How long the full pipeline took
  error_message        TEXT,                   -- Internal error detail (not exposed to clients)
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at         TIMESTAMPTZ,

  CONSTRAINT uq_job_email UNIQUE (job_id, email)
);

CREATE INDEX IF NOT EXISTS idx_results_job_id  ON email_results (job_id);
CREATE INDEX IF NOT EXISTS idx_results_status  ON email_results (status);
CREATE INDEX IF NOT EXISTS idx_results_email   ON email_results (email);

-- ─── Domain Cache ─────────────────────────────────────────────────────────────
-- Cache MX and catch-all results per domain to avoid redundant lookups.
CREATE TABLE IF NOT EXISTS domain_cache (
  domain        TEXT        PRIMARY KEY,
  mx_host       TEXT,
  has_mx        BOOLEAN     NOT NULL DEFAULT FALSE,
  is_catch_all  BOOLEAN,                        -- NULL = not yet determined
  cached_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_domain_cache_expires ON domain_cache (expires_at);

-- ─── Schema Migrations (v1.1) ────────────────────────────────────────────────
-- Advanced verification fields — safe to run on existing databases.

ALTER TABLE email_results
  ADD COLUMN IF NOT EXISTS is_disposable    BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_role_based    BOOLEAN      DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS has_spf          BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_dmarc        BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_dkim         BOOLEAN,
  ADD COLUMN IF NOT EXISTS typo_suggestion  TEXT,
  ADD COLUMN IF NOT EXISTS gravatar_exists  BOOLEAN,
  ADD COLUMN IF NOT EXISTS risk_score       SMALLINT;

ALTER TABLE domain_cache
  ADD COLUMN IF NOT EXISTS has_spf       BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_dmarc     BOOLEAN,
  ADD COLUMN IF NOT EXISTS has_dkim      BOOLEAN,
  ADD COLUMN IF NOT EXISTS dkim_selector TEXT;

-- ─── Helper view: job progress ────────────────────────────────────────────────
CREATE OR REPLACE VIEW job_progress AS
SELECT
  j.id                                                      AS job_id,
  j.state,
  j.total,
  j.completed,
  j.failed_count,
  ROUND((j.completed::NUMERIC / NULLIF(j.total, 0)) * 100, 2) AS progress_pct,
  j.created_at,
  j.completed_at,
  -- Status breakdown
  COUNT(r.id) FILTER (WHERE r.status = 'VALID')            AS valid_count,
  COUNT(r.id) FILTER (WHERE r.status = 'INVALID')          AS invalid_count,
  COUNT(r.id) FILTER (WHERE r.status = 'CATCH_ALL')        AS catch_all_count,
  COUNT(r.id) FILTER (WHERE r.status = 'NO_MX')            AS no_mx_count,
  COUNT(r.id) FILTER (WHERE r.status = 'DOMAIN_INVALID')   AS domain_invalid_count,
  COUNT(r.id) FILTER (WHERE r.status = 'GREYLISTED')       AS greylisted_count,
  COUNT(r.id) FILTER (WHERE r.status = 'UNKNOWN')          AS unknown_count
FROM verification_jobs j
LEFT JOIN email_results r ON r.job_id = j.id
GROUP BY j.id;
