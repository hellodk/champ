/**
 * SecretScanner: detects and redacts common secret patterns before content
 * is sent to an LLM. This is a defense-in-depth measure — users are still
 * expected to keep secrets out of the workspace.
 */

export interface ScanResult {
  hasSecrets: boolean;
  redacted: string;
  secretCount: number;
}

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

/**
 * Patterns ordered from most specific to most general so that we redact
 * the narrowest match first. Each pattern's match is replaced with
 * `[REDACTED]`.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  // PEM private keys: match the BEGIN marker and any following content.
  // Matching just the marker avoids dependence on whether the full key
  // footer is present.
  {
    name: "private_key",
    pattern:
      /-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?/g,
  },
  // AWS access keys
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  // Anthropic API keys. The official format is sk-ant-apiNN-XXXX, but we
  // also catch test fixtures like sk-ant-api-xxx using a loose variant.
  { name: "anthropic_key", pattern: /\bsk-ant-api[\w-]+/g },
  // OpenAI API keys (official and test fixtures)
  { name: "openai_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{3,}\b/g },
  // GitHub personal access / app / refresh tokens
  {
    name: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{3,}\b/g,
  },
  // Google API keys
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  // Slack tokens
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Password-style env var assignments. Matches PASSWORD=, DB_PASSWORD=,
  // etc. We use a non-alphabetic character boundary rather than \b because
  // underscores (common in env var names) are considered word characters.
  {
    name: "password_env",
    pattern:
      /(?<=(?:^|[^a-zA-Z])(?:password|passwd|pwd)\s*[:=]\s*["']?)[^\s"'`]{3,}/gim,
  },
  // Generic API key / token assignments
  {
    name: "api_key_env",
    pattern:
      /(?<=(?:^|[^a-zA-Z])(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?)[^\s"'`]{6,}/gim,
  },
];

export class SecretScanner {
  /**
   * Scan text for secrets and return a redacted version.
   */
  scan(text: string): ScanResult {
    let redacted = text;
    let secretCount = 0;

    for (const { pattern } of SECRET_PATTERNS) {
      // Reset lastIndex for global regex between calls.
      pattern.lastIndex = 0;
      const matches = redacted.match(pattern);
      if (matches) {
        secretCount += matches.length;
        redacted = redacted.replace(pattern, "[REDACTED]");
      }
    }

    return {
      hasSecrets: secretCount > 0,
      redacted,
      secretCount,
    };
  }
}
