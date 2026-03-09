# Architecture & Data Flow

## System Overview

The system is split into two independently-scalable processes connected through Redis:

- **API Service** — accepts requests, queues work, serves results, hosts the web UI
- **Worker Service** — pulls jobs from the queue, runs multi-layer verification, writes results

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Browser UI  /  API Client                          │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ POST /verify  { emails: [...] }
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        API Service (Fastify)                        │
│                                                                     │
│  1. IP-level rate limit (@fastify/rate-limit via Redis)             │
│  2. Zod body validation                                             │
│  3. Syntax pre-filter      → reject malformed addresses inline      │
│  4. Typo detection         → Levenshtein vs popular domains (sync)  │
│  5. Deduplicate emails                                              │
│  6. INSERT verification_jobs row         (PostgreSQL)               │
│  7. Bulk INSERT email_results placeholders                          │
│  8. queue.addBulk(emails, 1k chunks)     (BullMQ → Redis)          │
│  9. Return 202  { job_id, queued, invalid_syntax,                   │
│                   typo_suggestions }                                │
│  Port: 3003 (configurable via API_PORT)                             │
└─────────────────────────────────────────────────────────────────────┘
          │                              │
          │ Redis LPUSH                  │ GET /status/:id  GET /result/:id
          ▼                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Redis (BullMQ Queue)                            │
│  Queue: email-verification                                          │
│  ├── Pending / Active / Delayed (greylisted) / Failed jobs         │
│  └── Domain semaphores  domain:semaphore:<domain> → counter         │
└──────────────┬──────────────────────────────────────────────────────┘
               │ Worker polls (BRPOPLPUSH)
     ┌─────────┴─────────┐
     │                   │                  (scale with --scale worker=N)
     ▼                   ▼
┌─────────┐         ┌─────────┐
│ Worker 1│   ...   │ Worker N│
└────┬────┘         └────┬────┘
     └─────────┬─────────┘
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Verification Pipeline                            │
│  (runs per-email inside each worker, up to WORKER_CONCURRENCY jobs) │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Verification Pipeline (per email — 8 layers)

Each email travels through up to eight layers. The pipeline short-circuits the moment a definitive result is reached, avoiding unnecessary network I/O.

```
Input: raw email string
│
▼
┌────── Layer 1: Syntax ─────────────────────────────────────────────┐
│  validator.isEmail()  (RFC 5321/5322, no I/O)                      │
│  FAIL → status: INVALID, risk: 100                                 │
└──────────────────────────────────────┬─────────────────────────────┘
                                       │ PASS
                                       ▼
┌────── Layer 2: Disposable Domain ──────────────────────────────────┐
│  In-memory Set of 500+ known DEA providers (O(1) lookup)           │
│  isDisposable=true → status: INVALID, risk: 100                    │
└──────────────────────────────────────┬─────────────────────────────┘
                                       │ not disposable
                                       ▼
┌────── Layer 3: Role-based + Typo ──────────────────────────────────┐
│  isRoleBased — set of 85 generic local-part prefixes               │
│  typoSuggestion — Levenshtein ≤ 2 vs 50 popular domains            │
│  (neither hard-rejects; both enrich the result & risk score)       │
└──────────────────────────────────────┬─────────────────────────────┘
                                       │
                                       ▼
┌────── Layer 4: Domain Cache ────────────────────────────────────────┐
│  SELECT FROM domain_cache WHERE domain=? AND expires_at > NOW()     │
│  HIT (no MX)       → NO_MX / DOMAIN_INVALID (skip DNS)             │
│  HIT (catch-all)   → CATCH_ALL (skip SMTP)                         │
│  MISS / partial    → continue                                       │
└──────────────────────────────────────┬─────────────────────────────┘
                                       │ cache miss or partial
                                       ▼
┌────── Layer 5: DNS (parallel) ──────────────────────────────────────┐
│                                                                      │
│  ┌── MX Lookup ───────┐   ┌── DNS Auth ────────────────────────┐   │
│  │ dns.resolveMx()    │   │ SPF  — TXT @ domain root           │   │
│  │ timeout: 8 s       │   │ DMARC — TXT @ _dmarc.<domain>     │   │
│  │ A/AAAA fallback    │   │ DKIM  — TXT @ <sel>._domainkey.…  │   │
│  └──────────┬─────────┘   │         (8 selectors in parallel) │   │
│             │              └────────────────────────────────────┘   │
│   No MX / NXDOMAIN → NO_MX / DOMAIN_INVALID                        │
│   Has MX → continue                                                 │
└──────────────────────────────────────┬─────────────────────────────┘
                                       │
                                       ▼
┌────── Layer 6: Catch-All Detection ─────────────────────────────────┐
│  SMTP probe with xvz_nonexistent_<rand>@domain                      │
│  250 response → CATCH_ALL (skip RCPT check for real address)        │
│  550 response → domain is precise; continue to SMTP                 │
└──────────────────────────────────────┬─────────────────────────────┘
                                       │ not catch-all
                                       ▼
┌────── Layer 7: SMTP RCPT + Gravatar (parallel) ──────────────────────┐
│                                                                       │
│  ┌── SMTP EHLO→MAIL FROM→RCPT TO ─┐  ┌── Gravatar check (opt-in) ─┐ │
│  │  Raw TCP, no mail sent           │  │  MD5(email) → HEAD request │ │
│  │  250 → VALID                     │  │  200 → gravatar_exists=true │ │
│  │  550/551/553 → INVALID           │  │  (strong "real user" signal) │ │
│  │  421/45x → GREYLISTED            │  └────────────────────────────┘ │
│  │  other → UNKNOWN                 │                                  │
│  └──────────────────────────────────┘                                  │
└───────────────────────────────────────────────────┬───────────────────┘
                                                    │
                                                    ▼
┌────── Layer 8: Risk Score ──────────────────────────────────────────┐
│  Composite 0–100 score from all signals:                             │
│  Base: VALID=10, CATCH_ALL=50, GREYLISTED=35, UNKNOWN=45,           │
│        INVALID=85, NO_MX=92, DOMAIN_INVALID=96                      │
│  +40  isDisposable                                                   │
│  +15  isRoleBased                                                    │
│  +10  no SPF AND no DMARC                                            │
│  −20  Gravatar profile found                                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Database Schema

### `verification_jobs`
Tracks each batch submission:
`id, state, total, completed, failed_count, webhook_url, created_at, completed_at`

### `email_results`
One row per email per job — stores every signal from every pipeline layer:

| Column | Source layer |
|---|---|
| `status` | SMTP RCPT (layer 7) |
| `mx_host`, `smtp_response_code`, `smtp_response_message` | SMTP (layer 7) |
| `is_catch_all` | Catch-all detection (layer 6) |
| `is_disposable` | Disposable check (layer 2) |
| `is_role_based` | Role-based check (layer 3) |
| `has_spf`, `has_dmarc`, `has_dkim` | DNS Auth (layer 5) |
| `typo_suggestion` | Typo correction (layer 3, also at API layer) |
| `gravatar_exists` | Gravatar check (layer 7, opt-in) |
| `risk_score` | Composite score (layer 8) |

### `domain_cache`
Caches per-domain signals for 24 hours to avoid re-probing on repeat submissions:
`mx_host, has_mx, is_catch_all, has_spf, has_dmarc, has_dkim, dkim_selector`

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Web UI (single-page, no build step) — served on port **3003** |
| `POST` | `/verify` | Submit batch; returns `job_id` + real-time `typo_suggestions` |
| `GET` | `/status/:job_id` | Poll progress (state, completed/total, progress_pct) |
| `GET` | `/result/:job_id` | Full results with all verification signals + risk scores |
| `GET` | `/health` | Health check |

---

## Implemented Verification Methods (2026)

| Method | Module | Notes |
|---|---|---|
| Advanced SMTP handshake | `smtp.ts` | Full 220→EHLO→MAIL FROM→RCPT TO; hard vs soft failure analysis |
| MX record lookup | `dns.ts` | With A/AAAA fallback, distinguishes NO_MX from DOMAIN_INVALID |
| SPF verification | `dnsAuth.ts` | TXT record @ domain root |
| DMARC verification | `dnsAuth.ts` | TXT record @ `_dmarc.<domain>` |
| DKIM verification | `dnsAuth.ts` | 8 common selectors probed in parallel |
| Disposable email detection | `disposable.ts` | 500+ known DEA/burner providers |
| Role-based address detection | `disposable.ts` | 85 generic local-part prefixes |
| Typo correction | `typo.ts` | Levenshtein ≤ 2 vs 50+ popular domains; point-of-capture |
| Catch-all domain detection | `catchall.ts` | Random-probe SMTP strategy |
| Gravatar reputation signal | `pipeline.ts` | Opt-in (VERIFY_GRAVATAR=true); MD5 hash, no PII sent |
| Risk score | `pipeline.ts` | Composite 0–100 from all signals |


## System Overview

The system is split into two independently-scalable processes connected through Redis:

- **API Service** — accepts requests, queues work, serves results
- **Worker Service** — pulls jobs from the queue, runs verification, writes results

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Client / Caller                            │
└─────────────────────────┬──────────────────────────────────────────┘
                          │ POST /verify  { emails: [...] }
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        API Service (Fastify)                        │
│                                                                     │
│  1. IP-level rate limit (@fastify/rate-limit via Redis)             │
│  2. Zod body validation                                             │
│  3. Syntax pre-filter   → reject obvious bad formats inline         │
│  4. Deduplicate emails                                              │
│  5. INSERT verification_jobs row         (PostgreSQL)               │
│  6. Bulk INSERT email_results placeholders                          │
│  7. queue.addBulk(emails, 1k chunks)     (BullMQ → Redis)          │
│  8. Return 202  { job_id, queued, invalid_syntax }                  │
└─────────────────────────────────────────────────────────────────────┘
                          │
                          │ Redis LPUSH (BullMQ internal)
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Redis (BullMQ Queue)                            │
│                                                                     │
│  Queue: email-verification                                          │
│  ├── Pending jobs (LPUSH / ZSET)                                    │
│  ├── Active jobs  (currently being processed)                       │
│  ├── Delayed jobs (greylisted — waiting for backoff)                │
│  ├── Failed jobs  (max retries exhausted)                           │
│  └── Domain semaphores  domain:semaphore:<domain> → counter         │
└──────────────┬──────────────────────────────────────────────────────┘
               │ BRPOPLPUSH (Worker polls)
               │
     ┌─────────┴─────────┐
     │                   │                  (scale with --scale worker=N)
     ▼                   ▼
┌─────────┐         ┌─────────┐
│ Worker 1│   ...   │ Worker N│
└────┬────┘         └────┬────┘
     │                   │
     └─────────┬─────────┘
               │
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Verification Pipeline                            │
│  (runs per-email inside each worker, up to WORKER_CONCURRENCY jobs) │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Verification Pipeline (per email)

Each email travels through up to five layers. The pipeline short-circuits as soon as a definitive result is reached, avoiding unnecessary network I/O.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Input: raw email string                                            │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
         ┌────────────────▼────────────────┐
         │       Step 1: Syntax Check       │  (in-process, no I/O)
         │   validator.isEmail(email)        │
         └────────────────┬────────────────┘
                   FAIL   │   PASS
              ┌───────────┘   └──────────────────────┐
              ▼                                       ▼
          INVALID                    ┌────────────────▼────────────────┐
                                     │   Step 2: Domain Cache Lookup    │
                                     │   SELECT FROM domain_cache       │
                                     │   WHERE domain = ? AND           │
                                     │         expires_at > NOW()       │
                                     └────────────────┬────────────────┘
                                            HIT       │    MISS
                                  ┌───────────────────┘    └─────────────────────┐
                                  │                                               │
                    ┌─────────────▼──────────────┐          ┌────────────────────▼──────────────┐
                    │  Cached: no MX?             │          │   Step 3: DNS / MX Lookup          │
                    │  → NO_MX / DOMAIN_INVALID   │          │   dns.resolveMx(domain)            │
                    │  Cached: is_catch_all=true? │          │   timeout: 5s                      │
                    │  → CATCH_ALL (skip SMTP)    │          └────────────────────┬──────────────┘
                    └─────────────────────────────┘                    │
                                                       No MX / NXDOMAIN│  Has MX records
                                                              ┌─────────┘   └──────────────────────┐
                                                              ▼                                     │
                                                    NO_MX / DOMAIN_INVALID       ┌──────────────────▼──────────────┐
                                                    (upsert domain_cache)        │   Step 4: Catch-All Detection    │
                                                                                 │   SMTP probe with:               │
                                                                                 │   xvz_nonexistent_<rand>@domain  │
                                                                                 └──────────────────┬──────────────┘
                                                                                      250 (accept)  │  550 (reject)
                                                                            ┌───────────────────────┘   └────────────────────┐
                                                                            ▼                                                 │
                                                                        CATCH_ALL                         ┌────────────────────▼──────────────┐
                                                                        (upsert cache)                    │   Step 5: SMTP RCPT TO Check       │
                                                                                                          │   net.createConnection(mxHost, 25) │
                                                                                                          │   EHLO → MAIL FROM → RCPT TO        │
                                                                                                          │   → read response → QUIT            │
                                                                                                          └────────────────────┬──────────────┘
                                                                                                                               │
                                                                                              ┌────────────────────────────────┤
                                                                                              │                                │
                                                                                   ┌──────────▼──────┐              ┌──────────▼───────┐
                                                                                   │  2xx response   │              │  4xx response    │
                                                                                   │  VALID          │              │  GREYLISTED      │
                                                                                   └─────────────────┘              │  → retry later   │
                                                                                                                    └──────────────────┘
                                                                                   ┌──────────▼──────┐              ┌──────────▼───────┐
                                                                                   │  5xx response   │              │  timeout/error   │
                                                                                   │  INVALID        │              │  UNKNOWN         │
                                                                                   └─────────────────┘              └──────────────────┘
```

---

## SMTP Handshake Detail

Only a TCP handshake is performed. **No email content is ever transmitted.**

```
Worker (TCP client)                         MX Server (port 25)
─────────────────────────────────────────────────────────────────
                             ←──── 220 mail.example.com ESMTP Ready
EHLO verifier.yourdomain.com ────►
                             ◄──── 250-mail.example.com
                             ◄──── 250-PIPELINING
                             ◄──── 250 SIZE 52428800
MAIL FROM:<probe@verifier.yourdomain.com> ────►
                             ◄──── 250 OK
RCPT TO:<target@example.com> ────►
                             ◄──── 250 OK           → VALID
                             ◄──── 550 No such user → INVALID
                             ◄──── 421 Try later    → GREYLISTED
QUIT                         ────►
                             ◄──── 221 Bye
[connection closed — no DATA command, no email sent]
```

---

## Greylisting Retry Flow

Some mail servers intentionally reject the first connection attempt (greylisting) to filter spam. The system handles this with exponential backoff:

```
RCPT TO response: 421 / 450 / 451 / 452
         │
         ▼
  processor.ts throws Error("GREYLISTED:...")
         │
         ▼
  BullMQ moves job to Delayed queue
         │
  ┌──────┴───────────────────────────────────────────────┐
  │  Attempt 1 failure  →  retry in  1 minute  (60s)     │
  │  Attempt 2 failure  →  retry in  5 minutes (300s)    │
  │  Attempt 3 failure  →  retry in  15 minutes (900s)   │
  │  Attempt 4 failure  →  persist status = GREYLISTED   │
  └──────────────────────────────────────────────────────┘
```

---

## Per-Domain Rate Limiting

Prevents IP bans from aggressive SMTP providers by capping simultaneous connections:

```
Before SMTP connection:
  acquireDomainSlot(redis, domain)
       │
       ▼
  Redis Lua (atomic):
  ┌─────────────────────────────────────────────────────┐
  │  cur = GET domain:semaphore:<domain>                │
  │  if cur < limit → INCR + EXPIRE(ttl) → return 1    │
  │  else           → return 0  (slot full, wait 200ms) │
  └─────────────────────────────────────────────────────┘
       │
  ┌────┴──────┐
  │ Got slot  │  max wait = 30s, then BullMQ retries
  └────┬──────┘
       │
  [SMTP check runs]
       │
       ▼
  releaseDomainSlot(redis, domain)
  → DECR domain:semaphore:<domain>

Domain concurrency caps:
  gmail.com     → 5 concurrent connections
  yahoo.com     → 3 concurrent connections
  hotmail.com   → 3 concurrent connections
  icloud.com    → 2 concurrent connections
  (others)      → 10 concurrent connections (default)
```

---

## Horizontal Scaling

The system is designed to scale by adding worker containers with zero config changes:

```
                        Redis (shared queue)
                              │
              ┌───────────────┼───────────────┐
              │               │               │
         ┌────▼────┐     ┌────▼────┐     ┌────▼────┐
         │Worker 1 │     │Worker 2 │     │Worker N │
         │ conc=50 │     │ conc=50 │     │ conc=50 │
         └────┬────┘     └────┬────┘     └────┬────┘
              │               │               │
              └───────────────┼───────────────┘
                              │
                       PostgreSQL (writes)

Total throughput = N workers × 50 concurrency × verification_rate
Target: 10,000 verifications/hour/worker
```

To scale: `docker-compose up --scale worker=10`

---

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/verify` | Submit a batch of emails. Returns `job_id` immediately. |
| `GET` | `/status/:job_id` | Lightweight progress check — safe to poll frequently. |
| `GET` | `/result/:job_id` | Full result set with per-email statuses and summary. |
| `GET` | `/health` | Health check for load balancers. |

### POST /verify — Request
```json
{
  "emails": ["user@example.com", "..."],
  "webhook_url": "https://your-server.com/callback"
}
```

### POST /verify — Response `202 Accepted`
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "queued": 9997,
  "invalid_syntax": ["notanemail", "@broken.com"],
  "message": "Job created. 9997 emails queued for verification."
}
```

### GET /result/:job_id — Response
```json
{
  "job_id": "550e8400-...",
  "state": "completed",
  "summary": {
    "total": 9997,
    "valid": 6120,
    "invalid": 2100,
    "catch_all": 890,
    "no_mx": 412,
    "domain_invalid": 200,
    "greylisted": 180,
    "unknown": 95
  },
  "results": [
    {
      "email": "user@example.com",
      "status": "VALID",
      "mx_host": "mail.example.com",
      "smtp_response_code": 250,
      "smtp_response_message": "OK",
      "is_catch_all": false,
      "verification_time_ms": 342
    }
  ]
}
```
