#!/usr/bin/env tsx
// ─── Bulk Email Verification Test Script ──────────────────────────────────────
//
// Usage:
//   tsx scripts/bulk-test.ts [--count 1000] [--file emails.txt] [--api http://localhost:3000]
//
// What it does:
//   1. Generates N synthetic emails (or reads from a file)
//   2. Posts them to POST /verify
//   3. Polls GET /status/:id until the job completes
//   4. Fetches GET /result/:id and prints a summary
//   5. Optionally writes full results to results-<jobId>.json

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

// ─── Config from CLI args ─────────────────────────────────────────────────────
const args = parseArgs(process.argv.slice(2));
const API_BASE   = args['api']   ?? 'http://localhost:3000';
const EMAIL_COUNT = parseInt(args['count'] ?? '100', 10);
const EMAIL_FILE  = args['file'] ?? null;
const OUT_FILE    = args['out']  ?? null;
const POLL_MS     = parseInt(args['poll'] ?? '3000', 10);

// ─── Synthetic email domains for testing ─────────────────────────────────────
const TEST_DOMAINS = [
  'gmail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'example.com',
  'test.invalid',       // .invalid TLD — will fail syntax
  'nonexistent-xyz.io', // likely no MX — will be NO_MX
];

const REAL_LOCALPARTS = ['john.doe', 'jane.smith', 'user123', 'contact', 'info', 'admin'];
const FAKE_LOCALPARTS = ['zzz_fake_', 'notreal_', 'invalid_'];

function generateTestEmails(count: number): string[] {
  const emails: string[] = [];
  for (let i = 0; i < count; i++) {
    const domain = TEST_DOMAINS[i % TEST_DOMAINS.length];
    const useReal = Math.random() > 0.3;
    const local = useReal
      ? REAL_LOCALPARTS[i % REAL_LOCALPARTS.length] + i
      : FAKE_LOCALPARTS[i % FAKE_LOCALPARTS.length] + i;
    emails.push(`${local}@${domain}`);
  }
  // Sprinkle in some obviously invalid ones
  emails.push('not-an-email');
  emails.push('@nodomain.com');
  emails.push('missing@');
  return emails;
}

// ─── HTTP Client (no external deps) ──────────────────────────────────────────

function httpRequest<T>(
  method: string,
  url: string,
  body?: unknown
): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : undefined;

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(raw) as T });
        } catch {
          reject(new Error(`Failed to parse response: ${raw}`));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Email Verifier — Bulk Test Script');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  API:   ${API_BASE}`);
  console.log(`  Count: ${EMAIL_COUNT}`);
  if (EMAIL_FILE) console.log(`  File:  ${EMAIL_FILE}`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // ── Load or generate emails ────────────────────────────────────────────────
  let emails: string[];

  if (EMAIL_FILE) {
    const filePath = path.resolve(EMAIL_FILE);
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`);
      process.exit(1);
    }
    emails = fs.readFileSync(filePath, 'utf-8')
      .split('\n')
      .map((e) => e.trim())
      .filter(Boolean)
      .slice(0, EMAIL_COUNT);
    console.log(`Loaded ${emails.length} emails from file.`);
  } else {
    emails = generateTestEmails(EMAIL_COUNT);
    console.log(`Generated ${emails.length} synthetic test emails.`);
  }

  // ── Submit verification job ────────────────────────────────────────────────
  console.log('\n[1/3] Submitting verification request...');
  const t0 = Date.now();

  const { status: submitStatus, data: submitData } = await httpRequest<{
    job_id: string;
    queued: number;
    invalid_syntax: string[];
    message: string;
  }>('POST', `${API_BASE}/verify`, { emails });

  if (submitStatus !== 202) {
    console.error('Failed to submit job:', submitData);
    process.exit(1);
  }

  const { job_id, queued, invalid_syntax } = submitData;
  console.log(`  ✓ Job created:       ${job_id}`);
  console.log(`  ✓ Queued:            ${queued} emails`);
  console.log(`  ✗ Syntax-rejected:   ${invalid_syntax.length} emails`);
  if (invalid_syntax.length > 0) {
    console.log(`    Examples: ${invalid_syntax.slice(0, 3).join(', ')}`);
  }

  // ── Poll for completion ────────────────────────────────────────────────────
  console.log(`\n[2/3] Polling status every ${POLL_MS / 1000}s...`);

  let lastPct = -1;
  while (true) {
    await sleep(POLL_MS);

    const { data: status } = await httpRequest<{
      state: string;
      completed: number;
      total: number;
      progress_pct: number;
    }>('GET', `${API_BASE}/status/${job_id}`);

    const pct = Math.round(status.progress_pct ?? 0);
    if (pct !== lastPct) {
      const bar = progressBar(pct);
      process.stdout.write(`\r  ${bar} ${pct}% (${status.completed}/${status.total})`);
      lastPct = pct;
    }

    if (status.state === 'completed' || status.state === 'failed') {
      console.log(`\n  ✓ Job ${status.state.toUpperCase()} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      break;
    }
  }

  // ── Fetch and display results ──────────────────────────────────────────────
  console.log('\n[3/3] Fetching results...');
  const { data: result } = await httpRequest<{
    job_id: string;
    state: string;
    summary: Record<string, number>;
    results: Array<{ email: string; status: string; mx_host?: string; smtp_response_code?: number }>;
  }>('GET', `${API_BASE}/result/${job_id}`);

  const s = result.summary;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const rate    = s.total ? ((s.total / parseFloat(elapsed)) * 3600).toFixed(0) : '0';

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Total processed:  ${s.total}`);
  console.log(`  Time elapsed:     ${elapsed}s`);
  console.log(`  Rate:             ~${rate} verifications/hour`);
  console.log('───────────────────────────────────────────────────────────');
  console.log(`  ✓ VALID:          ${s.valid}         (confirmed mailbox exists)`);
  console.log(`  ✗ INVALID:        ${s.invalid}       (confirmed doesn't exist)`);
  console.log(`  ~ CATCH_ALL:      ${s.catch_all}     (domain accepts all)`);
  console.log(`  ~ NO_MX:          ${s.no_mx}         (no mail server)`);
  console.log(`  ~ DOMAIN_INVALID: ${s.domain_invalid}  (domain doesn't exist)`);
  console.log(`  ~ GREYLISTED:     ${s.greylisted}    (temp rejection, retried)`);
  console.log(`  ? UNKNOWN:        ${s.unknown}       (timeout / other error)`);
  console.log('═══════════════════════════════════════════════════════════');

  // Sample output
  console.log('\nSample results (first 10):');
  result.results.slice(0, 10).forEach((r) => {
    const code = r.smtp_response_code ? ` [${r.smtp_response_code}]` : '';
    const mx   = r.mx_host ? ` via ${r.mx_host}` : '';
    console.log(`  ${padEnd(r.status, 14)} ${r.email}${code}${mx}`);
  });

  // ── Write full results to file ────────────────────────────────────────────
  const outPath = OUT_FILE ?? `results-${job_id}.json`;
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nFull results written to: ${outPath}`);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function progressBar(pct: number, width = 30): string {
  const filled = Math.round((pct / 100) * width);
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]`;
}

function padEnd(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') && i + 1 < argv.length) {
      result[arg.slice(2)] = argv[++i];
    }
  }
  return result;
}

// ─── Run ─────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('\nFatal error:', err);
  process.exit(1);
});
