import { describe, it, expect, vi } from "vitest";
import {
  MultiAgentRunner,
  AgentOrchestrator,
} from "../../../src/agent/multi-agent-runner";

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

describe("MultiAgentRunner — inlined execution (retry, retry-from, abort)", () => {
  function makeAgent(
    name: string,
    responses: Array<{ success: boolean; output: string }>,
  ): import("../../../src/agent/agents/types").Agent {
    let call = 0;
    return {
      name,
      role: name,
      async execute() {
        const r = responses[Math.min(call, responses.length - 1)];
        call++;
        return r;
      },
    };
  }

  it("retries a failing agent up to maxRetries times then succeeds", async () => {
    const runner = new MultiAgentRunner();
    runner.registerAgent(
      makeAgent("a", [
        { success: false, output: "fail 1" },
        { success: false, output: "fail 2" },
        { success: true, output: "ok" },
      ]),
    );
    const result = await runner.run("test", { sequence: ["a"], maxRetries: 3 });
    expect(result.success).toBe(true);
    expect(result.output).toBe("ok");
  });

  it("returns failure when maxRetries exceeded", async () => {
    const runner = new MultiAgentRunner();
    runner.registerAgent(
      makeAgent("a", [{ success: false, output: "always fail" }]),
    );
    const result = await runner.run("test", { sequence: ["a"], maxRetries: 2 });
    expect(result.success).toBe(false);
  });

  it("branches back to retryFrom target on failure", async () => {
    const visited: string[] = [];
    function trackAgent(name: string, failOnFirstCall = false) {
      let calls = 0;
      return {
        name,
        role: name,
        async execute(): Promise<
          import("../../../src/agent/agents/types").AgentOutput
        > {
          calls++;
          visited.push(name);
          if (failOnFirstCall && calls === 1)
            return { success: false, output: "fail" };
          return { success: true, output: `${name} ok` };
        },
      };
    }
    const runner = new MultiAgentRunner();
    runner.registerAgent(trackAgent("code"));
    runner.registerAgent(trackAgent("reviewer", true));
    const result = await runner.run("test", {
      sequence: ["code", "reviewer"],
      maxRetries: 3,
      retryFrom: { reviewer: "code" },
    });
    expect(result.success).toBe(true);
    expect(visited).toEqual(["code", "reviewer", "code", "reviewer"]);
  });

  it("aborts on signal", async () => {
    const controller = new AbortController();
    const runner = new MultiAgentRunner();
    runner.registerAgent({
      name: "slow",
      role: "slow",
      async execute() {
        controller.abort();
        return { success: true, output: "done" };
      },
    });
    runner.registerAgent(
      makeAgent("never", [{ success: true, output: "should not run" }]),
    );
    const result = await runner.run("test", {
      sequence: ["slow", "never"],
      abortSignal: controller.signal,
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("abort");
  });
});
