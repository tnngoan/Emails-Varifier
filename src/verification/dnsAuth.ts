import { promises as dns } from 'dns';

// ─── Email Authentication DNS Record Checker ──────────────────────────────────
//
// Verifies three complementary DNS-based email authentication records:
//
//  SPF   (Sender Policy Framework)
//        TXT record on the domain itself starting with "v=spf1"
//        Lists servers authorised to send email on behalf of the domain.
//
//  DMARC (Domain-based Message Authentication, Reporting & Conformance)
//        TXT record at _dmarc.<domain> starting with "v=DMARC1"
//        Defines policy (none/quarantine/reject) for SPF/DKIM failures.
//
//  DKIM  (DomainKeys Identified Mail)
//        TXT record at <selector>._domainkey.<domain> containing "v=DKIM1"
//        We probe a short list of common selectors in parallel.
//
// Domains missing all three records are loosely configured and more likely
// to be burner / recently-registered domains.  Results are cached in
// domain_cache for 24 hours (same TTL as MX records).

// ─── Common DKIM selectors to probe ──────────────────────────────────────────
// Covers Gmail/Google Workspace, Microsoft 365, SendGrid, Mailchimp,
// and common self-hosted setups.
const DKIM_SELECTORS = [
  'google',     // Gmail / Google Workspace
  'selector1',  // Microsoft 365 – primary key
  'selector2',  // Microsoft 365 – secondary key
  'k1',         // Mailchimp, SendGrid, Klaviyo
  's1',         // Various ESPs
  'default',    // Common manual / cPanel setup
  'mail',       // Common manual setup
  'dkim',       // Common manual setup
] as const;

const DNS_AUTH_TIMEOUT_MS = 4_000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DnsAuthResult {
  spf:           boolean;
  dmarc:         boolean;
  dkim:          boolean;
  dkimSelector?: string;
  spfRecord?:    string;   // truncated to 120 chars for storage
  dmarcRecord?:  string;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Check SPF, DMARC, and DKIM for a domain, all in parallel with a timeout.
 * Never throws — returns { spf:false, dmarc:false, dkim:false } on error.
 */
export async function checkDnsAuth(domain: string): Promise<DnsAuthResult> {
  const [spfRes, dmarcRes, dkimRes] = await Promise.allSettled([
    withTimeout(checkSpf(domain),   DNS_AUTH_TIMEOUT_MS),
    withTimeout(checkDmarc(domain), DNS_AUTH_TIMEOUT_MS),
    withTimeout(checkDkim(domain),  DNS_AUTH_TIMEOUT_MS),
  ]);

  return {
    spf:          spfRes.status   === 'fulfilled' ? spfRes.value.found   : false,
    dmarc:        dmarcRes.status === 'fulfilled' ? dmarcRes.value.found : false,
    dkim:         dkimRes.status  === 'fulfilled' ? dkimRes.value.found  : false,
    dkimSelector: dkimRes.status  === 'fulfilled' ? dkimRes.value.selector : undefined,
    spfRecord:    spfRes.status   === 'fulfilled' ? spfRes.value.record   : undefined,
    dmarcRecord:  dmarcRes.status === 'fulfilled' ? dmarcRes.value.record : undefined,
  };
}

// ─── SPF ──────────────────────────────────────────────────────────────────────

async function checkSpf(
  domain: string
): Promise<{ found: boolean; record?: string }> {
  try {
    const records = await dns.resolveTxt(domain);
    for (const parts of records) {
      const rec = parts.join('');
      if (rec.startsWith('v=spf1')) {
        return { found: true, record: rec.slice(0, 120) };
      }
    }
    return { found: false };
  } catch {
    return { found: false };
  }
}

// ─── DMARC ────────────────────────────────────────────────────────────────────

async function checkDmarc(
  domain: string
): Promise<{ found: boolean; record?: string }> {
  try {
    const records = await dns.resolveTxt(`_dmarc.${domain}`);
    for (const parts of records) {
      const rec = parts.join('');
      if (rec.startsWith('v=DMARC1')) {
        return { found: true, record: rec.slice(0, 120) };
      }
    }
    return { found: false };
  } catch {
    return { found: false };
  }
}

// ─── DKIM ─────────────────────────────────────────────────────────────────────
// All selectors are probed in parallel. Returns on first positive hit.

async function checkDkim(
  domain: string
): Promise<{ found: boolean; selector?: string }> {
  const attempts = DKIM_SELECTORS.map((sel) =>
    checkSelector(sel, domain).then((found) => (found ? sel : null))
  );
  const results = await Promise.allSettled(attempts);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value !== null) {
      return { found: true, selector: r.value };
    }
  }
  return { found: false };
}

async function checkSelector(selector: string, domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
    for (const parts of records) {
      const rec = parts.join('');
      if (rec.includes('v=DKIM1') || rec.includes('p=')) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ─── Timeout helper ───────────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`DNS auth timeout after ${ms}ms`)), ms)
    ),
  ]);
}
