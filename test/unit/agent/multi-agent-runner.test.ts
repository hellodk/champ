import { describe, it, expect, vi } from "vitest";
import { MultiAgentRunner } from "../../../src/agent/multi-agent-runner";
import { AgentOrchestrator } from "../../../src/agent/orchestrator";

function makeOrchestrator(
  agentNames: string[],
  succeed = true,
): AgentOrchestrator {
  const orch = new AgentOrchestrator();
  for (const name of agentNames) {
    orch.registerAgent({
      name,
      role: name,
      execute: vi
        .fn()
        .mockResolvedValue({ success: succeed, output: `${name}-done` }),
    });
  }
  return orch;
}

describe("MultiAgentRunner", () => {
  it("runs the sequence and emits progress events", async () => {
    const orch = makeOrchestrator([
      "planner",
      "context",
      "code",
      "reviewer",
      "validator",
    ]);
    const runner = new MultiAgentRunner(orch);
    const events: string[] = [];
    const result = await runner.run("build auth feature", {
      onProgress: (e) => events.push(e.type),
    });
    expect(result.success).toBe(true);
    expect(events).toContain("agent_started");
    expect(events).toContain("agent_completed");
    expect(events).toContain("workflow_complete");
  });

  it("emits workflow_complete with report when analytics provided", async () => {
    const { AgentAnalytics } =
      await import("../../../src/observability/agent-analytics");
    const orch = makeOrchestrator(["planner"]);
    const runner = new MultiAgentRunner(orch);
    const analytics = new AgentAnalytics();
    // Simulate agent recording
    analytics.startTask("planner");
    analytics.recordTokens("planner", 50, 30);
    analytics.endTask("planner", true);

    let completedReport:
      | import("../../../src/agent-manager/types").AgentRunReport
      | undefined;
    await runner.run("test", {
      analytics,
      onProgress: (e) => {
        if (e.type === "workflow_complete") completedReport = e.report;
      },
    });
    expect(completedReport).toBeDefined();
    expect(completedReport!.agents).toHaveLength(1);
    expect(completedReport!.agents[0].agentName).toBe("planner");
  });

  it("emits workflow_complete with success=false when an agent fails", async () => {
    const orch = makeOrchestrator(["planner"], false);
    const runner = new MultiAgentRunner(orch);
    let workflowComplete:
      | { type: string; report: { success: boolean } }
      | undefined;
    const result = await runner.run("test", {
      maxRetries: 1,
      onProgress: (e) => {
        if (e.type === "workflow_complete")
          workflowComplete = e as typeof workflowComplete;
      },
    });
    expect(result.success).toBe(false);
    expect(workflowComplete?.report.success).toBe(false);
  });
});
