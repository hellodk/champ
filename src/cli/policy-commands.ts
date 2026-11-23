/**
 * Enterprise policy diagnostics: `champ policy show` and `champ policy validate`.
 *
 * These commands are read-only. They report the rules that were actually
 * loaded, grouped by precedence layer, and fail validation when any rule was
 * rejected instead of silently granting access.
 */
import type { PolicyEngine, PolicyScope } from "../policy/engine";

export type PolicyCommand =
  | { name: "policy-show" }
  | { name: "policy-validate" };

export interface PolicyCommandDeps {
  engine: PolicyEngine;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const SCOPES: PolicyScope[] = ["managed", "user", "project", "session"];

export function formatPolicyReport(engine: PolicyEngine): string {
  const lines: string[] = [];
  let total = 0;
  for (const scope of SCOPES) {
    const rules = engine.rulesFor(scope);
    total += rules.length;
    lines.push(`${scope} (${rules.length})`);
    for (const rule of rules) {
      lines.push(
        `  ${rule.decision} ${rule.kind} ${rule.target}${rule.reason ? ` (${rule.reason})` : ""}`,
      );
    }
  }
  lines.push(`invalid rules: ${engine.invalidRules}`);
  lines.push(`total rules: ${total}`);
  return `${lines.join("\n")}\n`;
}

export async function runPolicyCommand(
  cmd: PolicyCommand,
  deps: PolicyCommandDeps,
): Promise<number> {
  if (cmd.name === "policy-show") {
    deps.stdout(formatPolicyReport(deps.engine));
    return 0;
  }

  if (deps.engine.invalidRules > 0) {
    deps.stderr(
      `invalid rules: ${deps.engine.invalidRules}\npolicy invalid: ${deps.engine.invalidRules} rule(s) rejected\n`,
    );
    return 1;
  }
  let count = 0;
  for (const scope of SCOPES) count += deps.engine.rulesFor(scope).length;
  deps.stdout(`policy valid: ${count} rules\n`);
  return 0;
}
