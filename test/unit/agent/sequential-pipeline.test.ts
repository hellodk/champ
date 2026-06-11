import { describe, it, expect } from "vitest";
import type { IWorkflowRunner } from "../../../src/agent/workflow-runner";
import { MultiAgentRunner } from "../../../src/agent/multi-agent-runner";

describe("IWorkflowRunner interface", () => {
  it("MultiAgentRunner satisfies IWorkflowRunner (compile-time check)", () => {
    const runner: IWorkflowRunner = {} as MultiAgentRunner;
    expect(runner).toBeDefined();
  });
});
