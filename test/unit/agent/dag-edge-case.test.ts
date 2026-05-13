import { describe, it, expect, vi } from "vitest";
import { AgentOrchestrator } from "@/agent/orchestrator";
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

describe("Edge Case: Routed node with no next() should stop", () => {
  it("stops when a routed node has no next() — does not fall through", async () => {
    const orch = new AgentOrchestrator();
    const a = makeAgent("a");
    const b = makeAgent("b");
    const c = makeAgent("c");
    const d = makeAgent("d");
    orch.registerAgent(a);
    orch.registerAgent(b);
    orch.registerAgent(c);
    orch.registerAgent(d);

    const result = await orch.executeDAG("task", [
      { name: "a" },
      {
        name: "b",
        next: () => "c", // Routes to c
      },
      { name: "c" }, // Routed to; has NO next()
      { name: "d" },
    ]);

    // Should execute a, b, c — but NOT d (c has no next and was reached via routing)
    expect(result.executionLog.map((e) => e.agentName)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(d.execute).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });
});
