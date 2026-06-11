import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator } from "@/agent/multi-agent-runner";
import type { Agent, AgentOutput } from "@/agent/agents/types";

function makeAgent(name: string, output: Partial<AgentOutput> = {}): Agent {
  return {
    name,
    role: `${name} role`,
    execute: vi
      .fn()
      .mockResolvedValue({ success: true, output: `${name} done`, ...output }),
  };
}

describe("DAG Retry Logic", () => {
  it("retries node in place on failure, respects maxRetries", async () => {
    const orch = new AgentOrchestrator();
    const a = makeAgent("a");
    const b = makeAgent("b", { success: false, error: "bad" });
    const c = makeAgent("c");
    orch.registerAgent(a);
    orch.registerAgent(b);
    orch.registerAgent(c);

    const result = await orch.executeDAG(
      "task",
      [{ name: "a" }, { name: "b" }, { name: "c" }],
      { maxRetries: 2 },
    );

    // maxRetries: 2 means 2 total attempts, a runs once, b runs 2 times and fails, c never runs
    expect(result.executionLog.map((e) => e.agentName)).toEqual([
      "a",
      "b",
      "b",
    ]);
    expect(b.execute).toHaveBeenCalledTimes(2);
    expect(c.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});
