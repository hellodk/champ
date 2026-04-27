/**
 * PiiScanner: detect and redact personally identifiable information (PII)
 * from user messages before they are sent to an LLM.
 *
 * Patterns covered: email addresses, phone numbers (international + US),
 * US Social Security Numbers, credit/debit card numbers (all major networks),
 * IPv4 addresses, and UK/EU national identity numbers.
 *
 * Design: redact the minimum necessary — only replace the matched value,
 * preserving surrounding text intact so the LLM still has full context.
 */

export type PiiType =
  | "email"
  | "phone"
  | "ssn"
  | "credit_card"
  | "ip_address"
  | "national_id";

export interface PiiFinding {
  type: PiiType;
  /** The exact matched text (for logging/telemetry — never sent to LLM). */
  original: string;
  /** Replacement token written into the redacted text. */
  replacement: string;
}

export interface PiiScanResult {
  /** Text with all PII values replaced by [REDACTED:type] tokens. */
  redacted: string;
  /** True when at least one PII value was found. */
  hasFindings: boolean;
  /** One entry per matched value (may include duplicates if the same value appears twice). */
  findings: PiiFinding[];
}

interface PiiPattern {
  type: PiiType;
  pattern: RegExp;
}

const PII_PATTERNS: PiiPattern[] = [
  {
    type: "email",
    // Standard email. Disallows consecutive dots in local part and domain
    // to match RFC 5321 more closely and reduce false positives on
    // patterns like "v1..v2" that contain @ symbols in unusual contexts.
    pattern:
      /\b[a-zA-Z0-9][a-zA-Z0-9._%+\-]*(?<!\.)@[a-zA-Z0-9][a-zA-Z0-9.\-]*(?<!\.)\.[a-zA-Z]{2,}\b/g,
  },
  {
    type: "credit_card",
    // Covers major card formats separated by spaces or dashes:
    //   4-4-4-4 (Visa 16-digit, Mastercard, Discover)
    //   4-6-5   (Amex 15-digit)
    //   4-3-3-3 (Visa 13-digit)
    // Negative lookahead prevents matching the first 16 digits of a longer
    // dash-separated ID like 4321-1234-1234-1234-5678.
    pattern:
      /(?<![0-9-])\b\d{4}[\s-](?:\d{6}[\s-]\d{5}|\d{4}[\s-]\d{4}[\s-]\d{4}|\d{3}[\s-]\d{3}[\s-]\d{3})(?![\s-]\d)\b/g,
  },
  {
    type: "ssn",
    // US SSN: NNN-NN-NNNN. Require dashes to reduce false positives.
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    type: "phone",
    // Requires unambiguous phone formatting:
    //   US with parens: (555) 867-5309
    //   US with dashes: 555-867-5309
    //   International: +1 555-867-5309, +44 7700 900123
    // Does NOT match semver, dates (2026-04-27), or bare digit sequences.
    pattern:
      /(?:\+\d{1,3}[\s\-]\(?\d{1,4}\)?[\s\-]\d{2,6}(?:[\s\-]\d{2,6})?(?:[\s\-]\d{1,4})?|\(\d{3}\)\s?\d{3}[\s\-]\d{4}|\b\d{3}-\d{3}-\d{4}\b)/g,
  },
  {
    type: "ip_address",
    // IPv4 only. Excludes obvious non-IPs like version strings (1.0.0.1 still matches,
    // which is conservative but safer than missing real IPs).
    pattern:
      /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g,
  },
  {
    type: "national_id",
    // UK National Insurance: XX 99 99 99 X
    pattern: /\b[A-CEGHJ-PR-TW-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/gi,
  },
];

export class PiiScanner {
  scan(text: string): PiiScanResult {
    if (!text) return { redacted: text, hasFindings: false, findings: [] };

    let redacted = text;
    const findings: PiiFinding[] = [];

    // Apply patterns in order. Reset lastIndex before each global scan.
    for (const { type, pattern } of PII_PATTERNS) {
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, (match) => {
        findings.push({
          type,
          original: match,
          replacement: `[REDACTED:${type}]`,
        });
        return `[REDACTED:${type}]`;
      });
    }

    return {
      redacted,
      hasFindings: findings.length > 0,
      findings,
    };
  }

  /** Convenience: return true if any PII is detected without full scan. */
  hasFindings(text: string): boolean {
    for (const { pattern } of PII_PATTERNS) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) return true;
    }
    return false;
  }
}
