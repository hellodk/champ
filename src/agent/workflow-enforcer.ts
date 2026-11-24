/**
 * Coding workflow contract.
 *
 * After a turn that mutated files the agent must inspect its diff, run the
 * relevant tests, and report honestly. This module only *assesses* the
 * recorded tool calls; it never rewrites the model's answer.
 */
import type { ToolCall } from "../providers/types";
import type { ToolResult } from "../tools/types";

const MUTATING_TOOLS = new Set([
  "edit_file",
  "create_file",
  "delete_file",
  "write_file",
  "apply_patch",
]);

const DIFF_TOOLS = new Set(["git_diff", "read_file", "git_status"]);
const TEST_PATTERN =
  /\b(pytest|vitest|jest|npm\s+test|pnpm\s+(?:test|exec)|go\s+test|cargo\s+test|make\s+test|mvn\s+test|gradle\s+test)\b/i;

export interface WorkflowAssessment {
  mutations: number;
  diffInspected: boolean;
  testsRun: boolean;
  missing: string[];
  compliant: boolean;
}

export function assessWorkflow(
  toolCalls: Array<{ call: ToolCall; result: ToolResult }>,
): WorkflowAssessment {
  const mutations = toolCalls.filter((t) =>
    MUTATING_TOOLS.has(t.call.name),
  ).length;
  const diffInspected = toolCalls.some((t) => DIFF_TOOLS.has(t.call.name));
  const testsRun = toolCalls.some(
    (t) =>
      t.call.name === "run_terminal_cmd" &&
      TEST_PATTERN.test(String(t.call.arguments?.command ?? "")),
  );

  const missing: string[] = [];
  if (mutations > 0) {
    if (!diffInspected) missing.push("inspect the diff after editing");
    if (!testsRun) missing.push("run the relevant tests");
  }
  return {
    mutations,
    diffInspected,
    testsRun,
    missing,
    compliant: missing.length === 0,
  };
}

/** Bounded corrective guidance injected once, never as an unbounded loop. */
export function workflowGuidance(assessment: WorkflowAssessment): string {
  if (assessment.compliant) return "";
  return [
    "Workflow check: this turn edited files but did not complete the required steps.",
    ...assessment.missing.map((m) => `- ${m}`),
    "Report any step you could not complete instead of claiming success.",
  ].join("\n");
}
