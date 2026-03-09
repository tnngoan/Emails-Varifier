import { promises as dns } from 'dns';
import { MxRecord } from '../types/index.js';

// ─── DNS / MX Lookup ──────────────────────────────────────────────────────────
// Uses Node's built-in dns/promises module which leverages the OS resolver.
// MX records are sorted by priority (lowest number = highest priority) so
// the SMTP check always tries the most authoritative server first.

const DNS_TIMEOUT_MS = 8_000; // increased for slower resolvers

export interface DnsResult {
  hasMx: boolean;
  domainExists: boolean; // false if NXDOMAIN / SERVFAIL
  isTransient?: boolean;  // true if DNS timed out or had a network error (NOT authoritative)
  records: MxRecord[];   // sorted by priority asc; empty if no MX
  primaryMx?: string;    // the highest-priority exchange host
  error?: string;
}

/**
 * Resolve MX records for a domain.
 * Falls back to checking A/AAAA records when MX is absent
 * (some small domains configure SMTP on the A record — rare, we mark NO_MX).
 */
export async function lookupMx(domain: string): Promise<DnsResult> {
  // Wrap with a manual timeout since Node's dns module doesn't support one
  return Promise.race([
    _lookupMx(domain),
    timeout(DNS_TIMEOUT_MS, domain),
  ]);
}

async function _lookupMx(domain: string): Promise<DnsResult> {
  try {
    const raw = await dns.resolveMx(domain);
    const records: MxRecord[] = raw
      .map((r) => ({ exchange: r.exchange.toLowerCase(), priority: r.priority }))
      .sort((a, b) => a.priority - b.priority);

    return {
      hasMx: records.length > 0,
      domainExists: true,
      records,
      primaryMx: records[0]?.exchange,
    };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;

    // Domain genuinely doesn't exist
    if (code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ESERVFAIL') {
      // Verify NXDOMAIN vs "no MX record" — try A record as fallback
      const domainExists = await checkDomainHasARecord(domain);
      return {
        hasMx: false,
        domainExists,
        records: [],
        error: code,
      };
    }

    // DNS server timeout or other transient error — do NOT treat as DOMAIN_INVALID
    return {
      hasMx: false,
      domainExists: true,   // assume domain exists; we just couldn't verify
      isTransient: true,
      records: [],
      error: code ?? String(err),
    };
  }
}

async function checkDomainHasARecord(domain: string): Promise<boolean> {
  try {
    const addresses = await dns.resolve4(domain);
    return addresses.length > 0;
  } catch {
    try {
      const addresses = await dns.resolve6(domain);
      return addresses.length > 0;
    } catch {
      return false;
    }
  }
}

function timeout(ms: number, domain: string): Promise<DnsResult> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        hasMx: false,
        domainExists: true,   // assume domain exists; we just couldn't verify MX
        isTransient: true,
        records: [],
        error: `DNS timeout after ${ms}ms for ${domain}`,
      });
    }, ms);
  });
}
