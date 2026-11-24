/**
 * Git safety guard.
 *
 * The agent must never discard user changes by itself. Destructive git
 * commands are blocked before execution regardless of approval state or
 * model instructions.
 */
export interface GitSafetyCheck {
  allowed: boolean;
  reason?: string;
}

const BLOCKED: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: "git reset --hard discards working-tree changes",
  },
  {
    pattern: /\bgit\s+clean\s+(?:-[a-z]*[fd][a-z]*\s*)?/i,
    reason: "git clean deletes untracked files",
  },
  {
    pattern: /\bgit\s+checkout\s+(?:-f\s+|--\s+)/i,
    reason: "git checkout -f/-- discards working-tree changes",
  },
  {
    pattern: /\bgit\s+restore\b(?!\s+--staged\b)/i,
    reason: "git restore discards working-tree changes",
  },
  {
    pattern: /\bgit\s+stash\s+(?:drop|clear)\b/i,
    reason: "git stash drop/clear deletes saved user changes",
  },
  {
    pattern: /\bgit\s+branch\s+-D\b/i,
    reason: "git branch -D deletes branches",
  },
  {
    pattern: /\bgit\s+push\s+.*--force(?:-with-lease)?\b/i,
    reason: "force push overwrites remote history",
  },
];

/** Check a shell command for destructive git operations. */
export function checkGitSafety(command: string): GitSafetyCheck {
  // Strip quoted strings so a path named "git reset --hard" is not flagged.
  const normalized = command.replace(/"[^"]*"|'[^']*'/g, " ");
  for (const { pattern, reason } of BLOCKED) {
    if (pattern.test(normalized)) return { allowed: false, reason };
  }
  return { allowed: true };
}
