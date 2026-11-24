/**
 * Explicit permission profiles.
 *
 * A profile is a security floor chosen by the operator (CLI flag, config or
 * environment), never by the model. It is enforced before tool execution and
 * cannot be weakened by prompt text, tool arguments, `--yes`, or a project
 * policy file. Admin/user DENY rules still win because the profile gate runs
 * alongside — not instead of — the policy engine.
 *
 *  - read-only   deny every state-changing tool outright
 *  - supervised  require a human approval for state-changing tools (default)
 *  - autonomous  allow state-changing tools without an approval prompt
 */
import type { Tool } from "../tools/types";

export type PermissionProfile = "read-only" | "supervised" | "autonomous";

export const PERMISSION_PROFILES: readonly PermissionProfile[] = [
  "read-only",
  "supervised",
  "autonomous",
];

export const DEFAULT_PERMISSION_PROFILE: PermissionProfile = "supervised";

export const PERMISSION_PROFILE_ENV = "CHAMP_PERMISSION_PROFILE";

export function isPermissionProfile(
  value: unknown,
): value is PermissionProfile {
  return (
    typeof value === "string" &&
    PERMISSION_PROFILES.includes(value as PermissionProfile)
  );
}

/** Strict parser: an unknown profile fails closed with an actionable message. */
export function parsePermissionProfile(
  value: unknown,
  source = "permission profile",
): PermissionProfile {
  if (!isPermissionProfile(value)) {
    throw new Error(
      `Invalid ${source}: ${String(value)}. Expected one of ${PERMISSION_PROFILES.join(", ")}.`,
    );
  }
  return value;
}

/** Strict-but-optional parser for settings that may be unset. */
export function parseOptionalPermissionProfile(
  value: unknown,
  source = "permission profile",
): PermissionProfile | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return parsePermissionProfile(value, source);
}

export interface ProfileSourceInput {
  /** Explicit CLI flag. */
  flag?: string;
  /** Persisted config / extension setting. */
  config?: string;
  /** Environment variable. */
  env?: string;
  /** `--yes` / yoloMode implies autonomous only when no explicit profile is set. */
  autoApprove?: boolean;
}

/**
 * Resolve the effective profile with a fixed precedence:
 * flag > config > env > --yes > default. Model output is never an input.
 */
export function resolvePermissionProfile(
  input: ProfileSourceInput,
): PermissionProfile {
  if (input.flag !== undefined && input.flag.length > 0) {
    return parsePermissionProfile(input.flag, "--permission-profile");
  }
  if (input.config !== undefined && input.config.length > 0) {
    return parsePermissionProfile(input.config, "agent.permissionProfile");
  }
  if (input.env !== undefined && input.env.length > 0) {
    return parsePermissionProfile(input.env, PERMISSION_PROFILE_ENV);
  }
  return input.autoApprove === true ? "autonomous" : DEFAULT_PERMISSION_PROFILE;
}

/** A tool can change state if it needs approval or declares mutation paths. */
export function isMutatingTool(
  tool: Pick<Tool, "requiresApproval" | "mutationPaths" | "name">,
): boolean {
  return (
    tool.requiresApproval === true || typeof tool.mutationPaths === "function"
  );
}

export interface ProfileGateResult {
  /** True when the profile alone blocks the call. */
  denied: boolean;
  decision: "DENY" | "ASK" | "ALLOW";
  reason: string;
}

/**
 * Decide how a profile affects one tool call. `headless` mirrors the policy
 * engine: supervised profiles cannot ask a human when none is available.
 */
export function evaluateProfileGate(
  profile: PermissionProfile | undefined,
  tool: Pick<Tool, "requiresApproval" | "mutationPaths" | "name">,
  options: { headless?: boolean } = {},
): ProfileGateResult {
  if (!profile) {
    return { denied: false, decision: "ALLOW", reason: "no profile" };
  }
  if (!isMutatingTool(tool)) {
    return {
      denied: false,
      decision: "ALLOW",
      reason: `${profile} profile: read-only tool`,
    };
  }

  const subject = `tool "${tool.name}"`;
  if (profile === "read-only") {
    return {
      denied: true,
      decision: "DENY",
      reason: `read-only profile denies ${subject} because it can change state`,
    };
  }
  if (profile === "supervised") {
    if (options.headless) {
      return {
        denied: true,
        decision: "DENY",
        reason: `supervised profile cannot request approval in headless mode for ${subject}`,
      };
    }
    return {
      denied: false,
      decision: "ASK",
      reason: `supervised profile requires approval for ${subject}`,
    };
  }
  return {
    denied: false,
    decision: "ALLOW",
    reason: `autonomous profile allows ${subject}`,
  };
}
