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

describe("AgentOrchestrator.executeDAG", () => {
  it("runs all nodes in order when no conditions or routing", async () => {
    const orch = new AgentOrchestrator();
    const a = makeAgent("a");
    const b = makeAgent("b");
    const c = makeAgent("c");
    orch.registerAgent(a);
    orch.registerAgent(b);
    orch.registerAgent(c);
    const result = await orch.executeDAG("task", [
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ]);
    expect(result.success).toBe(true);
    expect(result.executionLog.map((e) => e.agentName)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("skips a node when condition returns false", async () => {
    const orch = new AgentOrchestrator();
    const a = makeAgent("a");
    const b = makeAgent("b");
    const c = makeAgent("c");
    orch.registerAgent(a);
    orch.registerAgent(b);
    orch.registerAgent(c);
    const result = await orch.executeDAG("task", [
      { name: "a" },
      { name: "b", condition: () => false },
      { name: "c" },
    ]);
    expect(result.executionLog.map((e) => e.agentName)).toEqual(["a", "c"]);
    expect(b.execute).not.toHaveBeenCalled();
  });

  it("routes to a named node via next()", async () => {
    const orch = new AgentOrchestrator();
    const a = makeAgent("a", { approved: false });
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
        next: (_output, memory) =>
          memory.getOutput("a")?.approved === false ? "c" : "d",
      },
      { name: "c" },
      { name: "d" },
    ]);
    expect(result.executionLog.map((e) => e.agentName)).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(d.execute).not.toHaveBeenCalled();
  });

  it("stops workflow when next() returns null", async () => {
    const orch = new AgentOrchestrator();
    const a = makeAgent("a");
    const b = makeAgent("b");
    orch.registerAgent(a);
    orch.registerAgent(b);
    const result = await orch.executeDAG("task", [
      { name: "a", next: () => null },
      { name: "b" },
    ]);
    expect(result.executionLog).toHaveLength(1);
    expect(b.execute).not.toHaveBeenCalled();
  });
});
