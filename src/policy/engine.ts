/**
 * Policy engine: ALLOW / ASK / DENY with fixed layer precedence.
 *
 * Layers are evaluated in order managed > user > project > session. The first
 * matching rule in the highest-precedence layer decides. When no rule matches,
 * approval-required tools produce ASK and everything else is ALLOW (preserving
 * existing behaviour). ASK is downgraded to DENY when no human can answer.
 */
import * as fs from "fs";
import * as path from "path";

export type PolicyDecision = "ALLOW" | "ASK" | "DENY";
export type PolicyScope = "managed" | "user" | "project" | "session";
export type PolicyKind = "tool" | "shell" | "path" | "mcp" | "subagent";

export interface PolicyRule {
  scope: PolicyScope;
  kind: PolicyKind;
  /** Exact name/path/command or glob pattern (`*` and `?`). */
  target: string;
  decision: PolicyDecision;
  reason?: string;
}

export interface PolicySubject {
  kind: PolicyKind;
  id: string;
  requiresApproval?: boolean;
  args?: Record<string, unknown>;
}

export interface PolicyEvaluationOptions {
  headless?: boolean;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  source: PolicyScope | "default";
  reason: string;
}

const SCOPES: PolicyScope[] = ["managed", "user", "project", "session"];
const KINDS = new Set<PolicyKind>(["tool", "shell", "path", "mcp", "subagent"]);
const DECISIONS = new Set<PolicyDecision>(["ALLOW", "ASK", "DENY"]);

export function isValidRule(value: unknown): value is PolicyRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<PolicyRule>;
  return (
    SCOPES.includes(rule.scope as PolicyScope) &&
    KINDS.has(rule.kind as PolicyKind) &&
    typeof rule.target === "string" &&
    rule.target.length > 0 &&
    DECISIONS.has(rule.decision as PolicyDecision)
  );
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const char of pattern) {
    if (char === "*") source += "[\\s\\S]*";
    else if (char === "?") source += "[\\s\\S]";
    else source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${source}$`);
}

function matches(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return false;
  return globToRegExp(pattern).test(value);
}

export class PolicyEngine {
  readonly invalidRules: number;
  private readonly layers: Record<PolicyScope, PolicyRule[]>;

  constructor(layers: Partial<Record<PolicyScope, PolicyRule[]>> = {}) {
    let invalid = 0;
    this.layers = {
      managed: [],
      user: [],
      project: [],
      session: [],
    };
    for (const scope of SCOPES) {
      for (const rule of layers[scope] ?? []) {
        if (!isValidRule(rule) || rule.scope !== scope) {
          invalid++;
          continue;
        }
        this.layers[scope].push(rule);
      }
    }
    this.invalidRules = invalid;
  }

  evaluate(
    subject: PolicySubject,
    options: PolicyEvaluationOptions = {},
  ): PolicyEvaluation {
    for (const scope of SCOPES) {
      for (const rule of this.layers[scope]) {
        if (rule.kind !== subject.kind) continue;
        if (!matches(rule.target, subject.id)) continue;
        if (options.headless && rule.decision === "ASK") {
          return {
            decision: "DENY",
            source: scope,
            reason: rule.reason
              ? `headless mode cannot ask: ${rule.reason}`
              : "headless mode cannot request approval",
          };
        }
        return {
          decision: rule.decision,
          source: scope,
          reason: rule.reason ?? `${scope} policy: ${rule.kind} ${rule.target}`,
        };
      }
    }

    if (subject.kind === "tool" && subject.requiresApproval) {
      if (options.headless) {
        return {
          decision: "DENY",
          source: "default",
          reason: "headless mode cannot request approval for this tool",
        };
      }
      return {
        decision: "ASK",
        source: "default",
        reason: "tool requires approval",
      };
    }
    return {
      decision: "ALLOW",
      source: "default",
      reason: "no matching policy rule",
    };
  }

  rulesFor(scope: PolicyScope): PolicyRule[] {
    return [...this.layers[scope]];
  }
}

/** Read a JSON policy file. Missing, malformed or invalid entries are ignored. */
export function loadPolicyFile(file: string, scope: PolicyScope): PolicyRule[] {
  try {
    return parsePolicyFile(fs.readFileSync(file, "utf8"), scope, false);
  } catch {
    return [];
  }
}

/** Thrown when a policy file that must be trustworthy cannot be loaded. */
export class PolicyLoadError extends Error {}

function parsePolicyFile(
  text: string,
  scope: PolicyScope,
  strict: boolean,
): PolicyRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new PolicyLoadError(
      `${scope} policy: invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const raw = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? (parsed as { rules?: unknown }).rules
      : undefined;
  if (!Array.isArray(raw)) {
    throw new PolicyLoadError(`${scope} policy: expected an array of rules`);
  }
  const rules: PolicyRule[] = [];
  let invalid = 0;
  for (const rule of raw) {
    const candidate =
      rule && typeof rule === "object" ? { ...rule, scope } : rule;
    if (!isValidRule(candidate)) {
      invalid++;
      continue;
    }
    rules.push(candidate);
  }
  if (invalid > 0 && strict) {
    throw new PolicyLoadError(
      `${scope} policy: ${invalid} invalid rule(s) rejected`,
    );
  }
  return rules;
}

/**
 * Strict loader for layers that must fail closed. A missing file is fine; an
 * unreadable, malformed or invalid file is not — treating it as an empty layer
 * would silently drop administrator/user restrictions.
 */
export function loadPolicyFileStrict(
  file: string,
  scope: PolicyScope,
): PolicyRule[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw new PolicyLoadError(
      `${scope} policy: cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parsePolicyFile(text, scope, true);
}

export interface PolicyEngineOptions {
  workspace?: string;
  userPolicyPath?: string;
  managedPolicyPath?: string;
  sessionRules?: PolicyRule[];
  env?: Record<string, string | undefined>;
  /**
   * Project-level ALLOW rules only grant access in a trusted workspace.
   * Defaults to false so a cloned repository cannot grant itself permissions.
   */
  workspaceTrusted?: boolean;
}

export const MANAGED_POLICY_ENV = "CHAMP_MANAGED_POLICY";

export function createPolicyEngine(
  opts: PolicyEngineOptions = {},
): PolicyEngine {
  const env = opts.env ?? process.env;
  const managedPath =
    opts.managedPolicyPath ?? env[MANAGED_POLICY_ENV] ?? undefined;
  const userPath =
    opts.userPolicyPath ??
    path.join(env.HOME ?? env.USERPROFILE ?? "", ".champ", "policy.json");
  const projectPath = opts.workspace
    ? path.join(opts.workspace, ".champ", "policy.json")
    : undefined;
  const projectRules = projectPath
    ? loadPolicyFile(projectPath, "project")
    : [];
  const trusted = opts.workspaceTrusted === true;
  return new PolicyEngine({
    managed: managedPath ? loadPolicyFileStrict(managedPath, "managed") : [],
    user: userPath ? loadPolicyFileStrict(userPath, "user") : [],
    // DENY/ASK still apply in an untrusted workspace; only grants are withheld.
    project: trusted
      ? projectRules
      : projectRules.filter((rule) => rule.decision !== "ALLOW"),
    session: opts.sessionRules ?? [],
  });
}
