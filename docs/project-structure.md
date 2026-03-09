# Project Structure

```
emails-softping/
├── docs/
│   ├── project-structure.md        — This file
│   └── architecture-flow.md        — System architecture and data flow
│
├── src/
│   ├── types/
│   │   └── index.ts                — All TypeScript types, enums, and constants
│   │                                  (VerificationStatus, EmailVerificationResult,
│   │                                   EmailJobData, SmtpConfig, VerifyResponse, etc.)
│   │
│   ├── config/
│   │   └── index.ts                — Centralised env-var config; fails fast on missing
│   │                                  required vars. Feature flags: VERIFY_DISPOSABLE,
│   │                                  VERIFY_DNS_AUTH, VERIFY_GRAVATAR.
│   │
│   ├── db/
│   │   ├── schema.sql              — PostgreSQL DDL + v1.1 ALTER TABLE migrations.
│   │   │                             Tables: verification_jobs, email_results, domain_cache
│   │   │                             New columns: is_disposable, is_role_based, has_spf,
│   │   │                             has_dmarc, has_dkim, typo_suggestion, gravatar_exists,
│   │   │                             risk_score (email_results); has_spf, has_dmarc,
│   │   │                             has_dkim, dkim_selector (domain_cache)
│   │   ├── client.ts               — pg.Pool singleton + withTransaction() helper
│   │   └── queries.ts              — All DB operations: jobs, email_results, domain cache
│   │
│   ├── queue/
│   │   ├── client.ts               — BullMQ Queue + Redis (IORedis) singleton instances
│   │   └── rateLimiter.ts          — Per-domain Redis Lua semaphore (concurrency caps)
│   │
│   ├── verification/
│   │   ├── syntax.ts               — RFC 5321/5322 syntax validation via `validator`
│   │   ├── disposable.ts           — In-memory disposable domain blocklist + role-based
│   │   │                             local-part detection (500+ known DEA providers)
│   │   ├── typo.ts                 — Levenshtein-based domain typo correction.
│   │   │                             Compares against 50+ popular providers; fires at ≤2
│   │   │                             edits. Returns suggestion for point-of-capture UX.
│   │   ├── dns.ts                  — MX record lookup with configurable 5 s timeout;
│   │   │                             A/AAAA fallback to distinguish NO_MX from NXDOMAIN
│   │   ├── dnsAuth.ts              — Parallel SPF / DMARC / DKIM DNS record checker.
│   │   │                             DKIM probes 8 common selectors (Google, M365, etc.)
│   │   ├── smtp.ts                 — Raw TCP SMTP handshake (220→EHLO→MAIL FROM→RCPT TO).
│   │   │                             Full response-code analysis; no email is ever sent.
│   │   ├── catchall.ts             — Random-probe catch-all domain detection
│   │   └── pipeline.ts             — 8-layer verification orchestrator (see below)
│   │
│   ├── worker/
│   │   ├── processor.ts            — BullMQ job handler: rate-limit → verify → persist
│   │   └── worker.ts               — Worker entry point; graceful shutdown on SIGTERM
│   │
│   └── api/
│       ├── middleware/
│       │   └── validation.ts       — Zod request schema validation
│       ├── routes/
│       │   ├── verify.ts           — POST /verify (typo suggestions returned synchronously)
│       │   └── jobs.ts             — GET /status/:id  GET /result/:id  GET /health
│       └── server.ts               — Fastify server bootstrap; serves public/ UI
│
├── public/
│   └── index.html                  — Single-file web UI: drag-and-drop CSV upload,
│                                     column auto-detection, live progress bar, stats,
│                                     typo warnings, two download buttons on completion:
│                                     · good_emails.csv  — VALID addresses only
│                                     · bad_emails.csv   — all rejections with status column
│                                     (files are in-memory blobs; cleared on page reload)
│
├── docker/
│   ├── Dockerfile.api              — Multi-stage build for the API service
│   ├── Dockerfile.worker           — Multi-stage build for the worker service
│   └── docker-compose.yml          — Full stack: postgres, redis, migrate, api, worker
│
├── scripts/
│   └── bulk-test.ts                — CLI load-test tool with live progress bar
│
├── .env.example                    — All supported environment variables with comments
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## Source Modules

### `src/types/index.ts`
Central type registry. Defines:
- `VerificationStatus` enum — `VALID | INVALID | CATCH_ALL | NO_MX | DOMAIN_INVALID | GREYLISTED | UNKNOWN`
- `EmailVerificationResult` — extended with `is_disposable`, `is_role_based`, `has_spf`, `has_dmarc`, `has_dkim`, `typo_suggestion`, `gravatar_exists`, `risk_score`
- `EmailJobData` — BullMQ job payload
- `SmtpConfig`, `MxRecord`, `DomainRateLimit`
- `GREYLIST_RETRY_DELAYS_MS` — `[60s, 300s, 900s]`
- `DOMAIN_CONCURRENCY_LIMITS` — per-provider caps (Gmail=5, Yahoo=3, etc.)
- API request/response shapes (VerifyResponse now includes `typo_suggestions[]`)

### `src/config/index.ts`
Reads all environment variables at startup. Missing required vars throw immediately (fail-fast). Exposes a single frozen `config` object including `config.verification` feature flags.

| Flag | Env var | Default | Effect |
|---|---|---|---|
| `checkDisposable` | `VERIFY_DISPOSABLE` | `true` | Block disposable / burner domains |
| `checkDnsAuth` | `VERIFY_DNS_AUTH` | `true` | Run SPF/DMARC/DKIM lookup |
| `checkGravatar` | `VERIFY_GRAVATAR` | `false` | Probe Gravatar (opt-in, adds latency) |

### `src/db/`
| File | Responsibility |
|---|---|
| `schema.sql` | DDL + idempotent v1.1 `ALTER TABLE` migrations. New columns in `email_results` and `domain_cache` for auth signals and risk metadata. |
| `client.ts` | `pg.Pool` singleton; `query<T>()` and `withTransaction()` helpers |
| `queries.ts` | `createJob`, `insertEmailPlaceholders` (chunked), `updateEmailResult` (all 16 fields), `getJobStatus`, `getJobResult`, `getCachedDomain`, `upsertDomainCache` |

### `src/queue/`
| File | Responsibility |
|---|---|
| `client.ts` | Singleton `IORedis` connection; BullMQ `Queue` and `QueueEvents` instances |
| `rateLimiter.ts` | Atomic Redis Lua semaphore — `acquireDomainSlot()` / `releaseDomainSlot()` |

### `src/verification/`
| File | Responsibility |
|---|---|
| `syntax.ts` | Wraps `validator.isEmail()` — fast, no I/O, runs in-process |
| `disposable.ts` | 500+ blocklisted DEA domain names (Set lookup O(1)); + Set of 85 role-based local-part prefixes |
| `typo.ts` | Levenshtein distance vs 50+ popular provider domains; threshold ≤ 2 edits; handles sub-addressing |
| `dns.ts` | `dns/promises.resolveMx()` with 5 s timeout; A-record fallback |
| `dnsAuth.ts` | Parallel async check: `resolveTxt` for SPF at domain root; `resolveTxt` at `_dmarc.<domain>`; `resolveTxt` at `<selector>._domainkey.<domain>` for 8 DKIM selectors |
| `smtp.ts` | Raw `net.createConnection()` SMTP state machine — 220→EHLO→MAIL FROM→RCPT TO→QUIT; no mail sent |
| `catchall.ts` | Generates `xvz_nonexistent_<random>@domain`, SMTP-checks it, returns `isCatchAll` |
| `pipeline.ts` | Orchestrates all 8 layers (see Architecture section) |

### `src/worker/`
| File | Responsibility |
|---|---|
| `processor.ts` | BullMQ job handler: acquires domain slot → runs pipeline → releases slot → persists result |
| `worker.ts` | Entry point; sets concurrency from config; graceful SIGTERM/SIGINT shutdown |


```
emails-softping/
├── docs/
│   ├── project-structure.md        — This file
│   └── architecture-flow.md        — System architecture and data flow
│
├── src/
│   ├── types/
│   │   └── index.ts                — All TypeScript types, enums, and constants
│   │                                  (VerificationStatus, EmailJobData, SmtpConfig, etc.)
│   │
│   ├── config/
│   │   └── index.ts                — Centralised environment variable config
│   │                                  (reads .env, fails fast on missing required vars)
│   │
│   ├── db/
│   │   ├── schema.sql              — PostgreSQL DDL: tables, indexes, domain_cache view
│   │   ├── client.ts               — pg.Pool singleton + withTransaction() helper
│   │   └── queries.ts              — All DB operations: jobs, email_results, domain cache
│   │
│   ├── queue/
│   │   ├── client.ts               — BullMQ Queue + Redis (IORedis) singleton instances
│   │   └── rateLimiter.ts          — Per-domain Redis Lua semaphore (concurrency caps)
│   │
│   ├── verification/
│   │   ├── syntax.ts               — RFC 5321/5322 syntax validation via `validator`
│   │   ├── dns.ts                  — MX record lookup with configurable timeout
│   │   ├── smtp.ts                 — Raw TCP SMTP handshake (NO email is sent)
│   │   ├── catchall.ts             — Random-probe catch-all domain detection
│   │   └── pipeline.ts             — Layered verification orchestrator (1–5 steps)
│   │
│   ├── worker/
│   │   ├── processor.ts            — BullMQ job handler: rate-limit → verify → persist
│   │   └── worker.ts               — Worker entry point; graceful shutdown on SIGTERM
│   │
│   └── api/
│       ├── middleware/
│       │   └── validation.ts       — Zod request schema validation
│       ├── routes/
│       │   ├── verify.ts           — POST /verify
│       │   └── jobs.ts             — GET /status/:id  GET /result/:id  GET /health
│       └── server.ts               — Fastify server bootstrap + error handler
│
├── docker/
│   ├── Dockerfile.api              — Multi-stage build for the API service
│   ├── Dockerfile.worker           — Multi-stage build for the worker service
│   └── docker-compose.yml          — Full stack: postgres, redis, migrate, api, worker
│
├── scripts/
│   └── bulk-test.ts                — CLI load-test tool with live progress bar
│
├── .env.example                    — All supported environment variables with comments
├── .gitignore
├── package.json
└── tsconfig.json
```

---

## Source Modules

### `src/types/index.ts`
Central type registry. Defines:
- `VerificationStatus` enum — `VALID | INVALID | CATCH_ALL | NO_MX | DOMAIN_INVALID | GREYLISTED | UNKNOWN`
- `EmailJobData` — BullMQ job payload
- `SmtpConfig`, `MxRecord`, `DomainRateLimit`
- `GREYLIST_RETRY_DELAYS_MS` — `[60s, 300s, 900s]`
- `DOMAIN_CONCURRENCY_LIMITS` — per-provider caps (Gmail=5, Yahoo=3, etc.)
- API request/response shapes

### `src/config/index.ts`
Reads all environment variables at startup. Missing required vars throw immediately (fail-fast). Exposes a single frozen `config` object used throughout the codebase.

### `src/db/`
| File | Responsibility |
|---|---|
| `schema.sql` | `verification_jobs`, `email_results`, `domain_cache` tables + `job_progress` view |
| `client.ts` | `pg.Pool` singleton; `query<T>()` and `withTransaction()` helpers |
| `queries.ts` | `createJob`, `insertEmailPlaceholders` (chunked), `updateEmailResult`, `getJobStatus`, `getJobResult`, `getCachedDomain`, `upsertDomainCache` |

### `src/queue/`
| File | Responsibility |
|---|---|
| `client.ts` | Singleton `IORedis` connection; BullMQ `Queue` and `QueueEvents` instances |
| `rateLimiter.ts` | Atomic Redis Lua semaphore — `acquireDomainSlot()` / `releaseDomainSlot()` |

### `src/verification/`
| File | Responsibility |
|---|---|
| `syntax.ts` | Wraps `validator.isEmail()` — fast, no I/O, runs in-process |
| `dns.ts` | `dns/promises.resolveMx()` with manual timeout; A-record fallback |
| `smtp.ts` | Raw `net.createConnection()` SMTP state machine — no actual mail sent |
| `catchall.ts` | Generates `xvz_nonexistent_<random>@domain`, probes SMTP, checks 250 |
| `pipeline.ts` | Orchestrates all five layers; reads/writes domain cache |

### `src/worker/`
| File | Responsibility |
|---|---|
| `processor.ts` | Per-job logic: acquire slot → run pipeline → persist → release slot; greylist retry throws |
| `worker.ts` | BullMQ `Worker` setup; event listeners; graceful `SIGTERM` drain |

### `src/api/`
| File | Responsibility |
|---|---|
| `middleware/validation.ts` | Zod schema for `POST /verify` body |
| `routes/verify.ts` | Syntax filter → dedup → create job → bulk enqueue (1k-chunk BullMQ `addBulk`) |
| `routes/jobs.ts` | Status polling, full result fetch, health check |
| `server.ts` | Fastify bootstrap; `@fastify/rate-limit`; global error handler; shutdown |

---

## Database Schema

```sql
verification_jobs
  id           UUID  PK
  state        TEXT  pending | processing | completed | failed
  total        INT   total emails submitted
  completed    INT   terminal-status emails (auto-incremented by worker)
  failed_count INT
  webhook_url  TEXT  optional POST callback
  created_at   TIMESTAMPTZ
  completed_at TIMESTAMPTZ

email_results
  id                    UUID  PK
  job_id                UUID  FK → verification_jobs
  email                 TEXT
  status                TEXT  pending | VALID | INVALID | ...
  mx_host               TEXT
  smtp_response_code    INT
  smtp_response_message TEXT
  is_catch_all          BOOL
  verification_time_ms  INT
  error_message         TEXT
  created_at / completed_at

domain_cache
  domain        TEXT  PK
  mx_host       TEXT
  has_mx        BOOL
  is_catch_all  BOOL  (NULL = not yet probed)
  cached_at     TIMESTAMPTZ
  expires_at    TIMESTAMPTZ  (24-hour TTL)
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `API_PORT` | `3000` | HTTP listen port |
| `DATABASE_URL` | `postgresql://...` | PostgreSQL connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `QUEUE_NAME` | `email-verification` | BullMQ queue name |
| `SMTP_HELO_HOST` | — | **Must match PTR record of public IP** |
| `SMTP_FROM_ADDRESS` | — | Probe sender address |
| `SMTP_TIMEOUT_MS` | `8000` | Socket timeout per SMTP check |
| `SMTP_PORT` | `25` | Direct MX port |
| `WORKER_CONCURRENCY` | `50` | Jobs per worker process |
| `WORKER_MAX_RETRIES` | `3` | BullMQ-level retry attempts |
| `DEFAULT_MAX_CONCURRENT` | `10` | Max SMTP connections to unknown domains |
| `DOMAIN_RATE_WINDOW_SEC` | `60` | Redis semaphore TTL |

See [`.env.example`](../.env.example) for the full list with comments.
