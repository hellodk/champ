import * as path from "path";
import { RulesEngine } from "../rules/rules-engine";

/**
 * Non-negotiable coding workflow. Added as an always-on rule so every CLI
 * turn sees it, independent of project rules or model instructions.
 */
export const CLI_WORKFLOW_RULE = `Coding workflow (mandatory):
1. After any file edit, inspect the resulting diff before continuing.
2. Run the smallest relevant test command for the changed area.
3. If a step cannot be completed, say so explicitly. Never claim untested work is verified.
4. Retry a failing command at most twice, then report the failure with the exact error.`;

export interface CliRulesOptions {
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** `userRules` from the effective config file, if any. */
  userRules?: string;
  /** Add the mandatory CLI coding-workflow rule (default false for unit purity). */
  includeWorkflowRule?: boolean;
}

/**
 * Load project rules from `<workspaceRoot>/.champ/rules` and optional `userRules`.
 * Non-ENOENT directory errors are warned on stderr and do not abort the CLI.
 */
export async function loadCliRules(
  opts: CliRulesOptions,
): Promise<RulesEngine> {
  const engine = new RulesEngine(opts.workspaceRoot);
  if (opts.includeWorkflowRule) {
    engine.addRule({
      name: "champ-cli-workflow",
      content: CLI_WORKFLOW_RULE,
      type: "always",
      source: "team",
    });
  }
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
