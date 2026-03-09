import { createHash } from 'crypto';
import { validateSyntax } from './syntax.js';
import { lookupMx } from './dns.js';
import { checkDnsAuth, DnsAuthResult } from './dnsAuth.js';
import { smtpCheck } from './smtp.js';
import { detectCatchAll } from './catchall.js';
import { checkDisposableAndRole } from './disposable.js';
import { suggestTypoFix } from './typo.js';
import { getCachedDomain, upsertDomainCache } from '../db/queries.js';
import { config } from '../config/index.js';
import {
  EmailVerificationResult,
  VerificationStatus,
} from '../types/index.js';

// ─── Verification Pipeline ────────────────────────────────────────────────────
//
// Each email travels through up to eight layers. Short-circuits early wherever
// a definitive result can be reached cheaply.
//
//  1. Syntax check           — RFC 5321/5322, no I/O
//  2. Disposable detection   — in-memory domain blocklist
//  3. Role-based + typo      — in-memory local-part check + Levenshtein hint
//  4. Domain cache           — skip repeat DNS + catch-all work
//  5. MX + DNS Auth (∥)      — MX lookup + SPF/DMARC/DKIM in parallel
//  6. Catch-all detection    — SMTP probe with random address
//  7. SMTP RCPT + Gravatar   — definitive mailbox check + reputation signal (∥)
//  8. Risk score             — composite 0–100 score from all signals

export async function verifyEmail(email: string): Promise<EmailVerificationResult> {
  const startMs = Date.now();

  // ── Step 1: Syntax ────────────────────────────────────────────────────────
  const syntax = validateSyntax(email);
  if (!syntax.valid) {
    return result(email, VerificationStatus.INVALID, startMs, {
      smtp_response_message: 'Syntax validation failed',
      risk_score: 100,
    });
  }
  const { domain } = syntax;

  // ── Step 2 & 3: Disposable, role-based, typo (all in-memory) ─────────────
  const typoSuggestion = suggestTypoFix(syntax.email);
  const { isDisposable, isRoleBased } = config.verification.checkDisposable
    ? checkDisposableAndRole(syntax.email)
    : { isDisposable: false, isRoleBased: false };

  // Disposable emails are short-circuited — no point running SMTP
  if (isDisposable) {
    return result(email, VerificationStatus.INVALID, startMs, {
      is_disposable:   true,
      is_role_based:   isRoleBased,
      typo_suggestion: typoSuggestion,
      risk_score:      100,
    });
  }

  // ── Step 4: Domain cache ──────────────────────────────────────────────────
  const cached = await getCachedDomain(domain).catch(() => null);

  if (cached) {
    if (!cached.has_mx) {
      const status = cached.mx_host === null
        ? VerificationStatus.DOMAIN_INVALID
        : VerificationStatus.NO_MX;
      return result(email, status, startMs, {
        is_role_based:   isRoleBased,
        typo_suggestion: typoSuggestion,
        has_spf:         cached.has_spf  ?? undefined,
        has_dmarc:       cached.has_dmarc ?? undefined,
        has_dkim:        cached.has_dkim  ?? undefined,
        risk_score: computeRiskScore(status, false, isRoleBased,
          cached.has_spf, cached.has_dmarc, null),
      });
    }
    if (cached.is_catch_all === true) {
      const status = VerificationStatus.CATCH_ALL;
      return result(email, status, startMs, {
        mx_host:         cached.mx_host ?? undefined,
        is_catch_all:    true,
        is_role_based:   isRoleBased,
        typo_suggestion: typoSuggestion,
        has_spf:         cached.has_spf  ?? undefined,
        has_dmarc:       cached.has_dmarc ?? undefined,
        has_dkim:        cached.has_dkim  ?? undefined,
        risk_score: computeRiskScore(status, false, isRoleBased,
          cached.has_spf, cached.has_dmarc, null),
      });
    }
  }

  // ── Step 5: DNS MX + DNS Auth (parallel) ─────────────────────────────────
  // Re-use cached DNS auth when available; otherwise probe fresh.
  const dnsAuthCached = cached?.has_spf !== null && cached?.has_spf !== undefined;

  const EMPTY_AUTH: DnsAuthResult = { spf: false, dmarc: false, dkim: false };

  const [dnsRes, dnsAuth] = await Promise.all([
    lookupMx(domain),
    dnsAuthCached
      ? Promise.resolve<DnsAuthResult>({
          spf:          cached!.has_spf!,
          dmarc:        cached!.has_dmarc   ?? false,
          dkim:         cached!.has_dkim    ?? false,
          dkimSelector: cached!.dkim_selector ?? undefined,
        })
      : (config.verification.checkDnsAuth
          ? checkDnsAuth(domain)
          : Promise.resolve<DnsAuthResult>(EMPTY_AUTH)),
  ]);

  if (!dnsRes.domainExists) {
    await upsertDomainCache(domain, {
      mx_host: null, has_mx: false, is_catch_all: null,
      has_spf: dnsAuth.spf, has_dmarc: dnsAuth.dmarc,
      has_dkim: dnsAuth.dkim, dkim_selector: dnsAuth.dkimSelector ?? null,
    }).catch(() => undefined);
    const status = VerificationStatus.DOMAIN_INVALID;
    return result(email, status, startMs, {
      smtp_response_message: dnsRes.error,
      is_role_based:   isRoleBased,
      typo_suggestion: typoSuggestion,
      has_spf:   dnsAuth.spf,
      has_dmarc: dnsAuth.dmarc,
      has_dkim:  dnsAuth.dkim,
      risk_score: computeRiskScore(status, false, isRoleBased,
        dnsAuth.spf, dnsAuth.dmarc, null),
    });
  }

  if (!dnsRes.hasMx || !dnsRes.primaryMx) {
    // Transient DNS failure (timeout/network) — don't cache, return UNKNOWN so it can be retried
    if (dnsRes.isTransient) {
      const status = VerificationStatus.UNKNOWN;
      return result(email, status, startMs, {
        smtp_response_message: dnsRes.error,
        is_role_based:   isRoleBased,
        typo_suggestion: typoSuggestion,
        risk_score: computeRiskScore(status, false, isRoleBased, null, null, null),
      });
    }
    await upsertDomainCache(domain, {
      mx_host: null, has_mx: false, is_catch_all: null,
      has_spf: dnsAuth.spf, has_dmarc: dnsAuth.dmarc,
      has_dkim: dnsAuth.dkim, dkim_selector: dnsAuth.dkimSelector ?? null,
    }).catch(() => undefined);
    const status = VerificationStatus.NO_MX;
    return result(email, status, startMs, {
      is_role_based:   isRoleBased,
      typo_suggestion: typoSuggestion,
      has_spf:   dnsAuth.spf,
      has_dmarc: dnsAuth.dmarc,
      has_dkim:  dnsAuth.dkim,
      risk_score: computeRiskScore(status, false, isRoleBased,
        dnsAuth.spf, dnsAuth.dmarc, null),
    });
  }

  const mxHost   = dnsRes.primaryMx;
  const smtpCfg  = {
    heloHost:    config.smtp.heloHost,
    fromAddress: config.smtp.fromAddress,
    timeoutMs:   config.smtp.timeoutMs,
    port:        config.smtp.port,
  };

  // ── Step 6: Catch-all detection ───────────────────────────────────────────
  let isCatchAll = cached?.is_catch_all ?? null;

  if (isCatchAll === null) {
    const catchAllRes = await detectCatchAll(mxHost, domain, smtpCfg);
    isCatchAll = catchAllRes.isCatchAll;
    await upsertDomainCache(domain, {
      mx_host: mxHost, has_mx: true, is_catch_all: isCatchAll,
      has_spf: dnsAuth.spf, has_dmarc: dnsAuth.dmarc,
      has_dkim: dnsAuth.dkim, dkim_selector: dnsAuth.dkimSelector ?? null,
    }).catch(() => undefined);
  }

  if (isCatchAll) {
    const status = VerificationStatus.CATCH_ALL;
    return result(email, status, startMs, {
      mx_host:         mxHost,
      is_catch_all:    true,
      is_role_based:   isRoleBased,
      typo_suggestion: typoSuggestion,
      has_spf:   dnsAuth.spf,
      has_dmarc: dnsAuth.dmarc,
      has_dkim:  dnsAuth.dkim,
      risk_score: computeRiskScore(status, false, isRoleBased,
        dnsAuth.spf, dnsAuth.dmarc, null),
    });
  }

  // ── Step 7: SMTP RCPT + Gravatar (parallel) ───────────────────────────────
  const [smtp, gravatarExists] = await Promise.all([
    smtpCheck(mxHost, syntax.email, smtpCfg),
    config.verification.checkGravatar
      ? checkGravatar(syntax.email)
      : Promise.resolve<boolean | null>(null),
  ]);

  const dnsExtra = {
    mx_host:         mxHost,
    smtp_response_code:    smtp.smtpResponseCode,
    smtp_response_message: smtp.smtpResponseMessage,
    is_role_based:   isRoleBased,
    typo_suggestion: typoSuggestion,
    has_spf:   dnsAuth.spf,
    has_dmarc: dnsAuth.dmarc,
    has_dkim:  dnsAuth.dkim,
    gravatar_exists: gravatarExists ?? undefined,
  };

  // ── Step 8: Classify + risk score ────────────────────────────────────────
  switch (smtp.code) {
    case 'VALID': {
      const status = VerificationStatus.VALID;
      return result(email, status, startMs, {
        ...dnsExtra, is_catch_all: false, is_disposable: false,
        risk_score: computeRiskScore(status, false, isRoleBased,
          dnsAuth.spf, dnsAuth.dmarc, gravatarExists),
      });
    }
    case 'INVALID': {
      const status = VerificationStatus.INVALID;
      return result(email, status, startMs, {
        ...dnsExtra, is_disposable: false,
        risk_score: computeRiskScore(status, false, isRoleBased,
          dnsAuth.spf, dnsAuth.dmarc, gravatarExists),
      });
    }
    case 'GREYLISTED': {
      const status = VerificationStatus.GREYLISTED;
      return result(email, status, startMs, {
        ...dnsExtra, is_disposable: false,
        risk_score: computeRiskScore(status, false, isRoleBased,
          dnsAuth.spf, dnsAuth.dmarc, gravatarExists),
      });
    }
    default: {
      const status = VerificationStatus.UNKNOWN;
      return result(email, status, startMs, {
        ...dnsExtra, is_disposable: false,
        risk_score: computeRiskScore(status, false, isRoleBased,
          dnsAuth.spf, dnsAuth.dmarc, gravatarExists),
      });
    }
  }
}

// ─── Risk Score ───────────────────────────────────────────────────────────────
// Composite 0-100 score. 0 = low risk (trusted individual inbox).
// 100 = high risk (very likely to bounce, expire, or belong to no one).

function computeRiskScore(
  status:        VerificationStatus,
  isDisposable:  boolean,
  isRoleBased:   boolean,
  hasSPF:        boolean | null | undefined,
  hasDMARC:      boolean | null | undefined,
  gravatar:      boolean | null,
): number {
  let score: number;
  switch (status) {
    case VerificationStatus.VALID:          score =  10; break;
    case VerificationStatus.CATCH_ALL:      score =  50; break;
    case VerificationStatus.GREYLISTED:     score =  35; break;
    case VerificationStatus.UNKNOWN:        score =  45; break;
    case VerificationStatus.INVALID:        score =  85; break;
    case VerificationStatus.NO_MX:          score =  92; break;
    case VerificationStatus.DOMAIN_INVALID: score =  96; break;
    default:                                score =  50;
  }
  if (isDisposable)                 score = Math.min(100, score + 40);
  if (isRoleBased)                  score = Math.min(100, score + 15);
  if (hasSPF === false && hasDMARC === false) score = Math.min(100, score + 10);
  if (gravatar === true)            score = Math.max(0,   score - 20);
  return score;
}

// ─── Gravatar Reputation Check ────────────────────────────────────────────────
// MD5-hash the email and check gravatar.com/avatar/<hash>?d=404.
// A 200 response means the owner has registered a Gravatar profile —
// a strong signal of a real, actively-used email address.
//
// Privacy note: this sends a hashed form of the email to gravatar.com.
// Only enabled when VERIFY_GRAVATAR=true in the environment.

async function checkGravatar(email: string): Promise<boolean | null> {
  try {
    const hash = createHash('md5')
      .update(email.trim().toLowerCase())
      .digest('hex');
    const res = await fetch(
      `https://www.gravatar.com/avatar/${hash}?d=404&s=1`,
      { method: 'HEAD', signal: AbortSignal.timeout(3_000) }
    );
    return res.status === 200;
  } catch {
    return null;
  }
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function result(
  email: string,
  status: VerificationStatus,
  startMs: number,
  extra?: Partial<EmailVerificationResult>
): EmailVerificationResult {
  return {
    email,
    status,
    verification_time_ms: Date.now() - startMs,
    ...extra,
  };
}
