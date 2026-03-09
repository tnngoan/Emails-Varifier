// ─── Email Domain Typo Detection (Point-of-Capture) ──────────────────────────
//
// Uses Levenshtein distance to detect whether the supplied email domain looks
// like a common mis-spelling of a popular provider.
//
// Examples:
//   anntr@gamil.com   → suggest anntr@gmail.com   (distance 1)
//   bob@outloook.com  → suggest bob@outlook.com   (distance 1)
//   sue@yahooo.com    → suggest sue@yahoo.com     (distance 1)
//
// Threshold: only fire when distance ≤ 2 (1 or 2 character edits).
// Results are returned immediately at the POST /verify level so callers can
// prompt users to correct typos before the job is even processed.

const POPULAR_DOMAINS = [
  // Google
  'gmail.com', 'googlemail.com',
  // Yahoo
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.fr', 'yahoo.de',
  'yahoo.es', 'yahoo.it', 'yahoo.com.br', 'yahoo.com.au',
  // Microsoft
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de',
  'hotmail.es', 'hotmail.it', 'hotmail.com.au',
  'outlook.com', 'live.com', 'live.co.uk', 'live.fr', 'live.de', 'live.es',
  'msn.com',
  // Apple
  'icloud.com', 'me.com', 'mac.com',
  // Other majors
  'aol.com',
  'protonmail.com', 'proton.me', 'pm.me',
  'mail.com', 'gmx.com', 'gmx.net', 'gmx.de',
  'zoho.com',
  'yandex.com', 'yandex.ru',
  'fastmail.com', 'fastmail.fm',
  'hey.com',
];

// ─── Levenshtein distance (two-row DP, O(m·n) time, O(n) space) ──────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns a corrected email suggestion if the domain looks like a typo of a
 * popular provider (Levenshtein distance ≤ 2), otherwise returns undefined.
 *
 * Returns undefined for domains that are already an exact known-good match,
 * so it won't fire redundantly on "gmail.com" itself.
 */
export function suggestTypoFix(email: string): string | undefined {
  const atIdx = email.lastIndexOf('@');
  if (atIdx < 0) return undefined;

  const local  = email.slice(0, atIdx);
  const domain = email.slice(atIdx + 1).toLowerCase();

  // Already perfectly correct
  if (POPULAR_DOMAINS.includes(domain)) return undefined;

  let bestDomain: string | undefined;
  let bestDist = Infinity;

  for (const popular of POPULAR_DOMAINS) {
    const dist = levenshtein(domain, popular);
    if (dist < bestDist) {
      bestDist   = dist;
      bestDomain = popular;
    }
  }

  if (bestDist <= 2 && bestDomain) {
    return `${local}@${bestDomain}`;
  }
  return undefined;
}
