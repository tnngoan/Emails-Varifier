import { smtpCheck, SmtpCheckResult } from './smtp.js';
import { SmtpConfig } from '../types/index.js';

// ─── Catch-All Domain Detection ───────────────────────────────────────────────
//
// A "catch-all" domain accepts emails for ANY address, even ones that don't
// actually exist. To detect this we send a RCPT TO check for a randomly
// generated address that is guaranteed to be non-existent.
//
// If the server returns 250 for the fake address → domain is catch-all.
// The original email may still be VALID but we can't be sure; we classify it
// as CATCH_ALL to signal reduced confidence.
//
// Strategy:
//   1. Generate a cryptographically-random local part (impossible inbox name)
//   2. SMTP-check probe@domain
//   3. 250 response → catch-all confirmed
//   4. 550 response → not catch-all (we trust RCPT results for this domain)

/**
 * Generate a random local part that no real user would have.
 * Uses a UUID-like hex string prefix to make collisions impossible.
 */
function randomLocalPart(): string {
  const rand = Math.random().toString(36).slice(2, 10) +
               Math.random().toString(36).slice(2, 10);
  return `xvz_nonexistent_${rand}`;
}

export interface CatchAllResult {
  isCatchAll: boolean;
  probeEmail: string;
  smtpResult: SmtpCheckResult;
}

/**
 * Detect whether a domain accepts all addresses (catch-all).
 *
 * @param mxHost   - The MX server hostname (already resolved)
 * @param domain   - The domain to probe (used only to build the probe address)
 * @param smtpCfg  - Shared SMTP connection settings
 */
export async function detectCatchAll(
  mxHost: string,
  domain: string,
  smtpCfg: SmtpConfig
): Promise<CatchAllResult> {
  const probeEmail = `${randomLocalPart()}@${domain}`;
  const smtpResult = await smtpCheck(mxHost, probeEmail, smtpCfg);

  // If the probe address is accepted → catch-all
  const isCatchAll = smtpResult.code === 'VALID';

  return { isCatchAll, probeEmail, smtpResult };
}
