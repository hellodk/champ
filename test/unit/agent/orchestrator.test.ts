/**
 * Tests for AgentOrchestrator onAgentProgress callbacks.
 */
import { describe, it, expect } from "vitest";
import { AgentOrchestrator } from "@/agent/orchestrator";

describe("AgentOrchestrator — onAgentProgress", () => {
  it("calls onAgentProgress before and after each agent", async () => {
    const orch = new AgentOrchestrator();
    orch.registerAgent({
      name: "a",
      role: "test",
      execute: async () => ({ success: true, output: "done" }),
    });
    const events: string[] = [];
    await orch.executeWorkflow("test", ["a"], {
      onAgentProgress: (e) => events.push(e.type),
    });
    expect(events).toEqual(["agent_started", "agent_completed"]);
  });

  it("calls agent_failed on agent failure", async () => {
    const orch = new AgentOrchestrator();
    orch.registerAgent({
      name: "b",
      role: "test",
      execute: async () => ({ success: false, output: "no", error: "bad" }),
    });
    const events: string[] = [];
    await orch.executeWorkflow("test", ["b"], {
      maxRetries: 1,
      onAgentProgress: (e) => events.push(e.type),
    });
    expect(events).toContain("agent_started");
    expect(events).toContain("agent_failed");
  });
});
