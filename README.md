# Email Verifier

Email Verifier is a bulk email validation system built for teams that need to clean, score, and separate large email lists before using them in outreach, sales, onboarding, or data operations. Instead of relying on a single yes/no check, the application runs each address through a multi-step verification pipeline that combines syntax validation, domain intelligence, DNS checks, catch-all detection, SMTP probing, and risk scoring. The result is a more realistic view of deliverability: which emails are safe to use, which are unsafe, and which should be treated with caution.

The product solves a common operational problem: raw email lists are noisy. They often contain malformed addresses, disposable inboxes, role accounts, typo domains, dead domains, catch-all mailboxes, and recipients that will hard-bounce. Sending to those lists hurts campaign performance, wastes time, damages sender reputation, and increases infrastructure costs. This app gives users a practical way to upload a CSV, validate the addresses asynchronously, review progress in the browser, and download two clean result files at the end of the run: one CSV for good emails and one CSV for bad emails. Those files exist only in the browser session, which keeps the workflow simple and avoids building unnecessary long-term file storage.

## What This Product Solves

This system is designed to reduce the risk and cost of using unverified email data.

It helps with:

- Removing invalid addresses before they reach marketing or outbound systems
- Identifying disposable and low-quality addresses that create poor lead quality
- Catching obvious domain typos such as common misspellings of major providers
- Detecting domains with no valid mail exchange configuration
- Flagging catch-all infrastructure where mailbox-level certainty is lower
- Separating high-confidence valid emails from unusable or risky ones
- Processing large batches without blocking the user interface
- Giving operations teams a simple CSV-in / CSV-out workflow

In practical terms, the app helps protect sender reputation, reduce bounce rates, improve list hygiene, and make downstream outreach more reliable.

## Core Product Flow

1. A user uploads a CSV file in the browser UI.
2. The API extracts and validates the submitted email list.
3. Valid-looking emails are queued through Redis using BullMQ.
4. Worker processes verify each email through the multi-layer pipeline.
5. Results are stored in PostgreSQL while job progress is tracked.
6. The browser polls the API for live progress updates.
7. When processing completes, the UI builds in-memory download files:
   - `good_emails.csv` for `VALID` addresses
   - `bad_emails.csv` for non-valid outcomes plus syntax-invalid inputs
8. If the page is refreshed, the generated download files are lost by design.

## Technology Stack

### Backend

- Node.js
- TypeScript
- Fastify for the HTTP API
- Zod for request validation
- BullMQ for background job orchestration
- Redis for queue transport and distributed rate limiting
- PostgreSQL for jobs, per-email results, and domain cache storage
- `validator` for email syntax validation
- Raw DNS and SMTP probing implemented inside the application code

### Frontend

- Single-file HTML, CSS, and vanilla JavaScript UI
- Drag-and-drop CSV upload with client-side parsing
- Live polling for progress updates
- In-browser CSV generation using Blob URLs for downloads

### Infrastructure

- Docker and Docker Compose for local and containerized deployment
- Separate API and worker containers
- Redis as the shared queue and coordination layer
- PostgreSQL as the system of record for verification jobs and results

## Verification Technologies Used

The verification engine is not a basic regex filter. It combines several layers of checks so the result is useful for real operations.

- Syntax validation to reject malformed addresses early
- Disposable email domain detection using an in-memory provider list
- Role-based address detection for generic inboxes such as support or admin
- Domain typo suggestion logic based on edit-distance matching
- Domain cache reuse to avoid repeating expensive checks
- MX lookup with fallback handling for domains with incomplete DNS setups
- SPF, DMARC, and DKIM presence checks for domain-level trust signals
- Catch-all probing to detect domains that accept mail for any recipient
- SMTP `RCPT TO` verification to estimate mailbox validity without sending email
- Optional Gravatar signal enrichment
- Composite risk scoring to summarize multiple signals into one score

## Architecture Summary

The application is split into two independent runtime roles:

- API service: accepts requests, validates input, creates jobs, serves status, and hosts the browser UI
- Worker service: consumes queued email jobs, runs verification, and persists results

This separation matters because email verification is network-heavy and slow compared to normal API requests. By moving the expensive work into workers, the product stays responsive even when users submit large CSV files.

## Why This Architecture Fits the Product

Bulk email verification has a few hard constraints:

- SMTP and DNS checks are slow and sometimes unreliable
- Many domains need per-provider concurrency limits
- Large jobs should not tie up request-response threads
- Results need to be resumable and queryable while processing is still running

Using Fastify, BullMQ, Redis, and PostgreSQL together addresses those constraints well:

- Fastify keeps the API layer lightweight and fast
- BullMQ gives the app a durable asynchronous job model
- Redis supports queueing and domain-level concurrency control
- PostgreSQL stores job state, results, and domain cache data in a structured way

## Current Runtime Profile

- Default API port: `3003`
- API process and worker process run independently
- Worker concurrency is configurable through environment variables
- Result CSVs are generated client-side and are not stored permanently

## Repository Contents

- `src/api` - HTTP server, routes, and request validation
- `src/worker` - BullMQ worker bootstrap and job processor
- `src/verification` - email verification pipeline and network checks
- `src/db` - schema, DB client, and SQL queries
- `src/queue` - Redis and queue integration
- `public/index.html` - browser UI
- `docs/architecture-flow.md` - low-level system flow and pipeline detail
- `docs/project-structure.md` - codebase layout reference

## Who This Is For

This app is useful for:

- lead generation teams
- outbound sales operations
- marketing operations
- CRM cleanup projects
- data enrichment and list hygiene workflows
- internal tools that need bulk email quality checks before sending

## Summary

Email Verifier is a practical bulk verification product built around asynchronous processing, domain-aware checks, and download-ready CSV results. It is designed to answer a real operational question at scale: which email addresses in this list are usable, which are risky, and which should be removed before sending anything.
