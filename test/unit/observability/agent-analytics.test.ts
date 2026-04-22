import { describe, it, expect } from "vitest";
import { AgentAnalytics } from "@/observability/agent-analytics";

describe("AgentAnalytics", () => {
  it("records a completed task", () => {
    const analytics = new AgentAnalytics();
    analytics.startTask("coder");
    analytics.recordTokens("coder", 100, 50);
    analytics.recordToolCall("coder", {
      toolName: "read_file",
      args: { path: "foo.ts" },
      startTime: Date.now(),
      durationMs: 12,
      success: true,
      result: "content",
    });
    analytics.endTask("coder", true);

    const report = analytics.toReport();
    expect(report.agents).toHaveLength(1);
    expect(report.agents[0].agentName).toBe("coder");
    expect(report.agents[0].inputTokens).toBe(100);
    expect(report.agents[0].outputTokens).toBe(50);
    expect(report.agents[0].toolCalls).toHaveLength(1);
    expect(report.agents[0].success).toBe(true);
    expect(report.totalInputTokens).toBe(100);
    expect(report.totalOutputTokens).toBe(50);
    expect(report.success).toBe(true);
  });

  it("marks run as failed when any task fails", () => {
    const analytics = new AgentAnalytics();
    analytics.startTask("planner");
    analytics.endTask("planner", false, "timeout");
    const report = analytics.toReport();
    expect(report.success).toBe(false);
    expect(report.agents[0].error).toBe("timeout");
  });

  it("formatMarkdown returns a non-empty string", () => {
    const analytics = new AgentAnalytics();
    analytics.startTask("reviewer");
    analytics.endTask("reviewer", true);
    const md = analytics.formatMarkdown();
    expect(md).toContain("reviewer");
    expect(md.length).toBeGreaterThan(10);
  });

  it("generates a unique runId", () => {
    const a = new AgentAnalytics();
    const b = new AgentAnalytics();
    expect(a.toReport().runId).not.toBe(b.toReport().runId);
  });

  it("accumulates tokens across multiple calls", () => {
    const analytics = new AgentAnalytics();
    analytics.startTask("agent");
    analytics.recordTokens("agent", 10, 5);
    analytics.recordTokens("agent", 20, 10);
    analytics.endTask("agent", true);
    const report = analytics.toReport();
    expect(report.totalInputTokens).toBe(30);
    expect(report.totalOutputTokens).toBe(15);
  });
});
