/**
 * TDD: MetricsCollector buffer bounds (issue #108).
 * Ring buffers cap at 1000 entries (oldest evicted); cumulative totals
 * remain accurate across evictions.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MetricsCollector } from "@/observability/metrics-collector";
import type {
  AgentStepLog,
  ToolCallLog,
} from "@/observability/metrics-collector";

const CAP = 1000;

function makeStep(i: number): AgentStepLog {
  return {
    agentName: `agent-${i}`,
    startTime: i,
    endTime: i + 1,
    durationMs: 1,
    input: `in-${i}`,
    output: `out-${i}`,
    success: true,
  };
}

function makeToolCall(i: number): ToolCallLog {
  return {
    toolName: `tool-${i}`,
    startTime: i,
    durationMs: 1,
    success: true,
    args: {},
  };
}

describe("MetricsCollector buffer bounds", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  it("caps requests at 1000 entries, retaining newest", () => {
    for (let i = 0; i < CAP + 50; i++) {
      collector.recordRequest({
        requestLatency: i,
        totalLatency: i,
        inputTokens: 1,
        outputTokens: 1,
      });
    }
    const snap = collector.snapshot();
    expect(snap.recent.requests).toHaveLength(CAP);
    // Oldest 50 evicted — first retained entry is i=50, last is i=1049
    expect(snap.recent.requests[0].requestLatency).toBe(50);
    expect(snap.recent.requests[CAP - 1].requestLatency).toBe(CAP + 49);
  });

  it("keeps cumulative totals accurate across request evictions", () => {
    for (let i = 0; i < CAP + 50; i++) {
      collector.recordRequest({
        requestLatency: i,
        totalLatency: i,
        inputTokens: 1,
        outputTokens: 1,
      });
    }
    const snap = collector.snapshot();
    expect(snap.totals.requests).toBe(CAP + 50);
    expect(collector.getMetrics().totalRequests).toBe(CAP + 50);
  });

  it("caps agentSteps at 1000 with accurate totals", () => {
    for (let i = 0; i < CAP + 10; i++) {
      collector.recordAgentStep(makeStep(i));
    }
    const snap = collector.snapshot();
    expect(snap.recent.agentSteps).toHaveLength(CAP);
    expect(snap.recent.agentSteps[0].agentName).toBe("agent-10");
    expect(snap.totals.agentSteps).toBe(CAP + 10);
  });

  it("caps toolCalls at 1000 with accurate totals", () => {
    for (let i = 0; i < CAP + 10; i++) {
      collector.recordToolCall(makeToolCall(i));
    }
    const snap = collector.snapshot();
    expect(snap.recent.toolCalls).toHaveLength(CAP);
    expect(snap.recent.toolCalls[0].toolName).toBe("tool-10");
    expect(snap.totals.toolCalls).toBe(CAP + 10);
  });

  it("caps failures at 1000 with accurate totals", () => {
    for (let i = 0; i < CAP + 10; i++) {
      collector.recordFailure(`failure-${i}`);
    }
    const snap = collector.snapshot();
    expect(snap.recent.failures).toHaveLength(CAP);
    expect(snap.recent.failures[0]).toBe("failure-10");
    expect(snap.totals.failures).toBe(CAP + 10);
    expect(collector.getMetrics().totalFailures).toBe(CAP + 10);
  });

  it("caps completionAcceptances at 1000 with accurate totals", () => {
    for (let i = 0; i < CAP + 10; i++) {
      collector.recordCompletionAccepted("gpt-x", i);
    }
    const snap = collector.snapshot();
    expect(snap.recent.completionAcceptances).toHaveLength(CAP);
    expect(snap.recent.completionAcceptances[0].length).toBe(10);
    expect(snap.totals.completionAcceptances).toBe(CAP + 10);
  });

  it("does not evict below the cap", () => {
    for (let i = 0; i < 42; i++) {
      collector.recordFailure(`f-${i}`);
    }
    const snap = collector.snapshot();
    expect(snap.recent.failures).toHaveLength(42);
    expect(snap.recent.failures[0]).toBe("f-0");
    expect(snap.totals.failures).toBe(42);
  });

  it("reset clears rings and zeroes totals", () => {
    for (let i = 0; i < CAP + 5; i++) {
      collector.recordFailure(`f-${i}`);
    }
    collector.reset();
    const snap = collector.snapshot();
    expect(snap.recent.failures).toHaveLength(0);
    expect(snap.totals.failures).toBe(0);
    expect(collector.getMetrics().totalFailures).toBe(0);
  });

  it("snapshot returns copies — mutating them does not affect state", () => {
    collector.recordFailure("original");
    const snap = collector.snapshot();
    snap.recent.failures.push("mutated");
    expect(collector.snapshot().recent.failures).toEqual(["original"]);
  });

  it("snapshot reports all five totals as zero when empty", () => {
    const snap = collector.snapshot();
    expect(snap.totals).toEqual({
      requests: 0,
      agentSteps: 0,
      toolCalls: 0,
      failures: 0,
      completionAcceptances: 0,
    });
  });
});
