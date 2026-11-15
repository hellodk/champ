import * as path from "path";
import { RulesEngine } from "../rules/rules-engine";

export interface CliRulesOptions {
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** `userRules` from the effective config file, if any. */
  userRules?: string;
}

/**
 * Load project rules from `<workspaceRoot>/.champ/rules` and optional `userRules`.
 * Non-ENOENT directory errors are warned on stderr and do not abort the CLI.
 */
export async function loadCliRules(
  opts: CliRulesOptions,
): Promise<RulesEngine> {
  const engine = new RulesEngine(opts.workspaceRoot);
  try {
    await engine.loadRulesFromDirectory(
      path.join(opts.workspaceRoot, ".champ", "rules"),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[champ] rules: ${msg}\n`);
  }
  if (opts.userRules?.trim()) {
    engine.setUserRules(opts.userRules);
  }
  return engine;
}

/** Always + user rules + glob-matched rules for the given file. */
export function rulesPrompt(
  engine: RulesEngine,
  ctx: { mode: string; currentFile?: string },
): string {
  const active = engine.getActiveRules({
    mode: ctx.mode,
    currentFile: ctx.currentFile,
  });
  return active.map((r) => r.content).join("\n\n");
}
