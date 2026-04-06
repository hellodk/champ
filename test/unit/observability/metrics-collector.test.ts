/**
 * TDD: Tests for MetricsCollector.
 * Tracks latency, tokens, agent steps, failures.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MetricsCollector } from "@/observability/metrics-collector";
import type {
  Metrics,
  AgentStepLog,
  ToolCallLog,
} from "@/observability/metrics-collector";

describe("MetricsCollector", () => {
  let collector: MetricsCollector;

  beforeEach(() => {
    collector = new MetricsCollector();
  });

  it("should start with empty metrics", () => {
    const metrics = collector.getMetrics();
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.totalTokensIn).toBe(0);
    expect(metrics.totalTokensOut).toBe(0);
  });

  it("should record a request with latency and tokens", () => {
    collector.recordRequest({
      requestLatency: 500,
      totalLatency: 1200,
      inputTokens: 100,
      outputTokens: 50,
    });

    const metrics = collector.getMetrics();
    expect(metrics.totalRequests).toBe(1);
    expect(metrics.totalTokensIn).toBe(100);
    expect(metrics.totalTokensOut).toBe(50);
    expect(metrics.averageLatency).toBe(1200);
  });

  it("should calculate average latency across multiple requests", () => {
    collector.recordRequest({
      requestLatency: 200,
      totalLatency: 1000,
      inputTokens: 50,
      outputTokens: 25,
    });
    collector.recordRequest({
      requestLatency: 300,
      totalLatency: 2000,
      inputTokens: 75,
      outputTokens: 35,
    });

    const metrics = collector.getMetrics();
    expect(metrics.totalRequests).toBe(2);
    expect(metrics.averageLatency).toBe(1500);
    expect(metrics.totalTokensIn).toBe(125);
  });

  it("should record agent steps", () => {
    const step: AgentStepLog = {
      agentName: "planner",
      startTime: Date.now(),
      endTime: Date.now() + 500,
      durationMs: 500,
      input: "user request",
      output: "plan",
      success: true,
    };
    collector.recordAgentStep(step);

    const metrics = collector.getMetrics();
    expect(metrics.agentSteps).toHaveLength(1);
    expect(metrics.agentSteps[0].agentName).toBe("planner");
  });

  it("should record tool calls", () => {
    const toolLog: ToolCallLog = {
      toolName: "read_file",
      startTime: Date.now(),
      durationMs: 50,
      success: true,
      args: { path: "test.ts" },
    };
    collector.recordToolCall(toolLog);

    const metrics = collector.getMetrics();
    expect(metrics.toolCalls).toHaveLength(1);
    expect(metrics.toolCalls[0].toolName).toBe("read_file");
  });

  it("should track failure count", () => {
    collector.recordRequest({
      requestLatency: 100,
      totalLatency: 500,
      inputTokens: 10,
      outputTokens: 5,
    });
    collector.recordFailure("Rate limit exceeded");
    collector.recordFailure("Timeout");

    const metrics = collector.getMetrics();
    expect(metrics.failures).toHaveLength(2);
    expect(metrics.failures[0]).toBe("Rate limit exceeded");
  });

  it("should reset all metrics", () => {
    collector.recordRequest({
      requestLatency: 100,
      totalLatency: 500,
      inputTokens: 10,
      outputTokens: 5,
    });
    collector.recordFailure("error");
    collector.reset();

    const metrics = collector.getMetrics();
    expect(metrics.totalRequests).toBe(0);
    expect(metrics.failures).toHaveLength(0);
  });

  it("should export metrics as JSON", () => {
    collector.recordRequest({
      requestLatency: 100,
      totalLatency: 500,
      inputTokens: 10,
      outputTokens: 5,
    });
    const json = collector.toJSON();
    expect(typeof json).toBe("string");
    const parsed = JSON.parse(json);
    expect(parsed.totalRequests).toBe(1);
  });
});
