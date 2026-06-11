/**
 * Acceptance test for issue #16: the inline 5-agent pipeline
 * (formerly run by AgentOrchestrator) now runs correctly via MultiAgentRunner.
 */
import { describe, it, expect } from "vitest";
import type { IWorkflowRunner } from "../../../src/agent/workflow-runner";
import { MultiAgentRunner } from "../../../src/agent/multi-agent-runner";
import type {
  Agent,
  AgentInput,
  AgentOutput,
} from "../../../src/agent/agents/types";
import type { SharedMemory } from "../../../src/agent/agents/types";

function mockAgent(name: string): Agent {
  return {
    name,
    role: name,
    async execute(
      _input: AgentInput,
      _memory: SharedMemory,
    ): Promise<AgentOutput> {
      return { success: true, output: `${name} done` };
    },
  };
}

describe("Sequential pipeline via MultiAgentRunner (issue #16 acceptance)", () => {
  it("MultiAgentRunner satisfies IWorkflowRunner interface", () => {
    const runner: IWorkflowRunner = new MultiAgentRunner();
    expect(runner).toBeDefined();
  });

  it("runs a 5-agent pipeline in order and returns success", async () => {
    const runner = new MultiAgentRunner();
    const order: string[] = [];
    for (const name of [
      "planner",
      "context",
      "code",
      "reviewer",
      "validator",
    ]) {
      runner.registerAgent({
        name,
        role: name,
        async execute(): Promise<AgentOutput> {
          order.push(name);
          return { success: true, output: `${name} done` };
        },
      });
    }
    const result = await runner.run("build a feature", {
      sequence: ["planner", "context", "code", "reviewer", "validator"],
    });
    expect(result.success).toBe(true);
    expect(order).toEqual([
      "planner",
      "context",
      "code",
      "reviewer",
      "validator",
    ]);
    expect(result.executionLog).toHaveLength(5);
  });

  it("registerAgent and listAgents work without AgentOrchestrator dependency", () => {
    const runner = new MultiAgentRunner();
    runner.registerAgent(mockAgent("alpha"));
    runner.registerAgent(mockAgent("beta"));
    const names = runner.listAgents().map((a) => a.name);
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
  });

  it("fires onProgress events for each agent", async () => {
    const runner = new MultiAgentRunner();
    runner.registerAgent(mockAgent("a"));
    runner.registerAgent(mockAgent("b"));
    const events: string[] = [];
    await runner.run("test", {
      sequence: ["a", "b"],
      onProgress: (e) => events.push(e.type),
    });
    expect(events).toContain("agent_started");
    expect(events).toContain("agent_completed");
    expect(events).toContain("workflow_complete");
  });
});
