import { describe, expect, it } from "vitest";
import { assessWorkflow, workflowGuidance } from "@/agent/workflow-enforcer";
import type { ToolCall } from "@/providers/types";

function call(name: string, args: Record<string, unknown> = {}) {
  return {
    call: { id: name, name, arguments: args } as ToolCall,
    result: { success: true, output: "" },
  };
}

describe("coding workflow enforcement", () => {
  it("requires diff inspection and tests after an edit", () => {
    const assessment = assessWorkflow([call("edit_file", { path: "a.ts" })]);
    expect(assessment.mutations).toBe(1);
    expect(assessment.compliant).toBe(false);
    expect(assessment.missing).toEqual([
      "inspect the diff after editing",
      "run the relevant tests",
    ]);
    expect(workflowGuidance(assessment)).toContain("inspect the diff");
  });

  it("accepts a complete edit → diff → test sequence", () => {
    const assessment = assessWorkflow([
      call("edit_file", { path: "a.ts" }),
      call("git_diff"),
      call("run_terminal_cmd", { command: "pnpm exec vitest run a.test.ts" }),
    ]);
    expect(assessment.compliant).toBe(true);
    expect(workflowGuidance(assessment)).toBe("");
  });

  it("does not demand a workflow for read-only turns", () => {
    expect(assessWorkflow([call("read_file")]).compliant).toBe(true);
  });
});
