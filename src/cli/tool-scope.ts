import type { ToolRegistry } from "../tools/registry";

export interface AppliedToolScope {
  /** Re-register every tool that was present before filtering. Idempotent. */
  restore(): void;
  /** Declared tools this CLI does not have. */
  missing: string[];
}

/**
 * Temporarily restrict `registry` to the intersection of its current tools and
 * `allowedTools`. If `allowedTools` is undefined or empty, returns a no-op scope.
 * If none of `allowedTools` are available, all tools are unregistered for the turn.
 */
export function applyAllowedTools(
  registry: ToolRegistry,
  allowedTools?: readonly string[],
): AppliedToolScope {
  if (!allowedTools || allowedTools.length === 0) {
    return { restore: () => {}, missing: [] };
  }

  const saved = registry.getAll();
  const available = new Set(saved.map((t) => t.name));
  const missing = allowedTools.filter((n) => !available.has(n));
  const wanted = new Set(allowedTools.filter((n) => available.has(n)));

  for (const tool of saved) {
    if (!wanted.has(tool.name)) {
      registry.unregister(tool.name);
    }
  }

  let restored = false;
  return {
    missing,
    restore(): void {
      if (restored) return;
      restored = true;
      for (const tool of saved) {
        registry.register(tool);
      }
    },
  };
}
