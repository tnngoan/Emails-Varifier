import validator from 'validator';

// ─── Syntax Validation ────────────────────────────────────────────────────────
// Uses the battle-tested `validator` library which covers RFC 5321/5322 rules
// plus sane real-world constraints (TLD must exist, no back-to-back dots, etc.).

export interface SyntaxResult {
  valid: boolean;
  email: string;   // normalised (lowercase)
  domain: string;
  localPart: string;
}

export function validateSyntax(raw: string): SyntaxResult {
  // Trim whitespace — common in CSV/paste imports
  const email = raw.trim().toLowerCase();

  const valid = validator.isEmail(email, {
    allow_utf8_local_part: false,  // reject punycode in local-part for safety
    require_tld: true,
    allow_ip_domain: false,        // [192.168.1.1] addresses are not mailboxes
    domain_specific_validation: false,
  });

  const atIndex = email.lastIndexOf('@');
  const localPart = atIndex >= 0 ? email.slice(0, atIndex) : email;
  const domain    = atIndex >= 0 ? email.slice(atIndex + 1) : '';

  return { valid, email, domain, localPart };
}

/**
 * Fast-path bulk syntax filter.
 * Returns two arrays: valid email strings and rejected email strings.
 */
export function bulkSyntaxFilter(emails: string[]): {
  valid: string[];
  invalid: string[];
} {
  const valid: string[] = [];
  const invalid: string[] = [];

  for (const raw of emails) {
    const result = validateSyntax(raw);
    if (result.valid) {
      valid.push(result.email);
    } else {
      invalid.push(raw.trim());
    }
  }

  return { valid, invalid };
}
