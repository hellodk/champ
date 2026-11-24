/**
 * File ownership rules for CLI team runs.
 *
 * TeamRunner executes agents in the same dependency group in parallel. The
 * CLI refuses to start a run when two agents that can mutate files have no
 * proven-disjoint ownership patterns. This is a fail-closed check: model
 * prompts are never trusted to avoid concurrent writes.
 */
import * as path from "path";
import type {
  TeamAgentDefinition,
  TeamDefinition,
} from "../agent/team-definition";

/** Tools that can change files or external repository state. */
export const MUTATING_TEAM_TOOLS = new Set([
  "edit_file",
  "create_file",
  "delete_file",
  "git",
  "generate_doc",
  "generate_diagram",
  "run_terminal_cmd",
]);

function canMutate(agent: Required<TeamAgentDefinition>): boolean {
  return agent.tools.some((tool) => MUTATING_TEAM_TOOLS.has(tool));
}

function normalizePattern(pattern: string): string {
  let value = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  while (value.endsWith("/")) value = value.slice(0, -1);
  return value;
}

function staticPrefix(pattern: string): string {
  const parts: string[] = [];
  for (const segment of normalizePattern(pattern).split("/")) {
    if (/[*?[]/.test(segment)) break;
    parts.push(segment);
  }
  return parts.join("/");
}

/** Conservative overlap: a leading wildcard is assumed to overlap everything. */
function overlaps(left: string, right: string): boolean {
  const a = normalizePattern(left);
  const b = normalizePattern(right);
  if (a === b) return true;
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  if (!pa || !pb) return true;
  return `${pa}/`.startsWith(`${pb}/`) || `${pb}/`.startsWith(`${pa}/`);
}

/** Validate a single agent's ownership patterns. */
export function ownershipPatternIssues(
  agentId: string,
  patterns: string[],
): string[] {
  const issues: string[] = [];
  if (patterns.length === 0) return issues;
  for (const pattern of patterns) {
    const normalized = normalizePattern(pattern);
    if (!normalized) {
      issues.push(`agent "${agentId}" has an empty ownership pattern`);
      continue;
    }
    if (path.isAbsolute(normalized) || normalized.split("/").includes("..")) {
      issues.push(
        `agent "${agentId}" ownership pattern "${pattern}" must be workspace-relative`,
      );
    }
  }
  return issues;
}

/**
 * Return every reason the team cannot safely run in parallel.
 * An empty array means the declared ownership is sufficient.
 */
export function findOwnershipConflicts(
  team: TeamDefinition,
  groups: Required<TeamAgentDefinition>[][],
): string[] {
  const issues: string[] = [];
  const ownership = team.fileOwnership ?? {};

  for (const agent of team.agents) {
    if (!canMutate(agent)) continue;
    const patterns = ownership[agent.id] ?? [];
    issues.push(...ownershipPatternIssues(agent.id, patterns));
    if (patterns.length === 0) {
      issues.push(
        `agent "${agent.id}" can mutate files but declares no owns patterns`,
      );
    }
  }

  for (const group of groups) {
    const mutators = group.filter(canMutate);
    for (let i = 0; i < mutators.length; i++) {
      for (let j = i + 1; j < mutators.length; j++) {
        const left = mutators[i];
        const right = mutators[j];
        const leftPatterns = ownership[left.id] ?? [];
        const rightPatterns = ownership[right.id] ?? [];
        const clash = leftPatterns.find((a) =>
          rightPatterns.some((b) => overlaps(a, b)),
        );
        if (clash) {
          const other = rightPatterns.find((b) => overlaps(clash, b))!;
          issues.push(
            `agents "${left.id}" and "${right.id}" can run in parallel but own overlapping paths: "${clash}" and "${other}"`,
          );
        }
      }
    }
  }
  return [...new Set(issues)];
}
