/**
 * CommandSandbox: denylist/allowlist for terminal commands.
 *
 * Blocks a small set of unambiguously dangerous commands (rm -rf /,
 * mkfs, dd to disk devices, curl-piped-to-shell, sudo). Supports a
 * strict allowlist-only mode for high-trust environments.
 *
 * ⚠️  SECURITY LIMITATION: this is a best-effort denylist, NOT a real
 * sandbox. Any command not matching a deny pattern executes unrestricted
 * via `bash -c`. It cannot prevent data exfiltration, file enumeration,
 * or arbitrary code execution by a compromised or malicious LLM.
 * The approval dialog (`requiresApproval: true` on run_terminal) is the
 * primary defence — do not rely on this filter alone for untrusted
 * workloads. Use `allowlistOnly: true` in high-security contexts.
 */

export interface SandboxOptions {
  /** If set, only commands matching allowPatterns are permitted. */
  allowlistOnly?: boolean;
  /** Regex patterns for allowed commands (only used when allowlistOnly). */
  allowPatterns?: RegExp[];
  /** Additional deny patterns on top of the built-in list. */
  denyPatterns?: RegExp[];
}

export interface SandboxCheckResult {
  allowed: boolean;
  reason?: string;
}

/** Built-in patterns for commands that should never run. */
const DEFAULT_DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\brm\s+(-[rRf]+\s+|--recursive\s+|--force\s+)+(\/|~|\$HOME|\*)/,
    reason: "rm -rf on root, home, or wildcard is dangerous",
  },
  {
    pattern: /\brm\s+-[rRf]+\s*$/,
    reason: "rm -rf without explicit target is suspicious",
  },
  {
    pattern: /\bmkfs(\.|_|\s)/,
    reason: "filesystem formatting commands are dangerous",
  },
  {
    pattern: /\bdd\s+.*of=\/dev\//,
    reason: "dd to a block device can destroy data",
  },
  {
    pattern: /curl\s+[^|]*\|\s*(bash|sh|zsh|fish)/,
    reason: "piping curl output to a shell executes untrusted code",
  },
  {
    pattern: /wget\s+[^|]*\|\s*(bash|sh|zsh|fish)/,
    reason: "piping wget output to a shell executes untrusted code",
  },
  {
    pattern: /\bsudo\s+/,
    reason: "sudo is disabled by default; use allowlistOnly if you need it",
  },
  {
    pattern: /:\(\)\s*\{\s*:\|:&\s*\}/,
    reason: "fork bomb",
  },
  {
    pattern: /\bchmod\s+-R\s+777\s+\//,
    reason: "recursive chmod 777 on root is dangerous",
  },
];

export class CommandSandbox {
  private readonly options: SandboxOptions;

  constructor(options: SandboxOptions = {}) {
    this.options = options;
  }

  /**
   * Quick boolean check whether a command is allowed.
   */
  isAllowed(command: string): boolean {
    return this.check(command).allowed;
  }

  /**
   * Detailed check with reason when blocked.
   */
  check(command: string): SandboxCheckResult {
    const trimmed = command.trim();

    // Allowlist-only mode: must match at least one allow pattern.
    if (this.options.allowlistOnly) {
      const allowPatterns = this.options.allowPatterns ?? [];
      const matched = allowPatterns.some((p) => p.test(trimmed));
      if (!matched) {
        return {
          allowed: false,
          reason: "command not in allowlist",
        };
      }
    }

    // Check built-in deny patterns.
    for (const { pattern, reason } of DEFAULT_DENY_PATTERNS) {
      if (pattern.test(trimmed)) {
        return { allowed: false, reason: `blocked: ${reason} (dangerous)` };
      }
    }

    // Check user-provided deny patterns.
    if (this.options.denyPatterns) {
      for (const pattern of this.options.denyPatterns) {
        if (pattern.test(trimmed)) {
          return { allowed: false, reason: "blocked by custom denylist" };
        }
      }
    }

    return { allowed: true };
  }
}
