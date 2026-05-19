import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpAnalytics } from "../mcp-analytics";
import { MCPClientManager } from "../mcp-client";

describe("McpAnalytics", () => {
  let analytics: McpAnalytics;

  beforeEach(() => {
    analytics = new McpAnalytics();
  });

  it("returns empty stats when no records exist", () => {
    const stats = analytics.getStats();
    expect(stats.totalCalls).toBe(0);
    expect(stats.successRate).toBe(1);
    expect(stats.avgLatencyMs).toBe(0);
    expect(stats.byTool).toEqual({});
  });

  it("records a single successful call and computes stats", () => {
    analytics.record({
      serverName: "srv",
      toolName: "read_file",
      latencyMs: 50,
      success: true,
      timestamp: Date.now(),
    });

    const stats = analytics.getStats();
    expect(stats.totalCalls).toBe(1);
    expect(stats.successRate).toBe(1);
    expect(stats.avgLatencyMs).toBe(50);
    expect(stats.byTool["srv:read_file"]).toMatchObject({
      calls: 1,
      successRate: 1,
      avgLatencyMs: 50,
    });
  });

  it("records a failed call and reflects it in success rate", () => {
    analytics.record({
      serverName: "srv",
      toolName: "write_file",
      latencyMs: 100,
      success: false,
      timestamp: Date.now(),
    });

    const stats = analytics.getStats();
    expect(stats.totalCalls).toBe(1);
    expect(stats.successRate).toBe(0);
    expect(stats.byTool["srv:write_file"].successRate).toBe(0);
  });

  it("averages latency across multiple calls", () => {
    analytics.record({
      serverName: "s",
      toolName: "t",
      latencyMs: 100,
      success: true,
      timestamp: 0,
    });
    analytics.record({
      serverName: "s",
      toolName: "t",
      latencyMs: 200,
      success: true,
      timestamp: 0,
    });

    const stats = analytics.getStats();
    expect(stats.avgLatencyMs).toBe(150);
    expect(stats.byTool["s:t"].avgLatencyMs).toBe(150);
  });

  it("computes mixed success/failure rates correctly", () => {
    analytics.record({
      serverName: "s",
      toolName: "t",
      latencyMs: 10,
      success: true,
      timestamp: 0,
    });
    analytics.record({
      serverName: "s",
      toolName: "t",
      latencyMs: 20,
      success: false,
      timestamp: 0,
    });
    analytics.record({
      serverName: "s",
      toolName: "t",
      latencyMs: 30,
      success: true,
      timestamp: 0,
    });

    const stats = analytics.getStats();
    expect(stats.totalCalls).toBe(3);
    expect(stats.successRate).toBeCloseTo(2 / 3);
    expect(stats.byTool["s:t"].successRate).toBeCloseTo(2 / 3);
  });

  it("filters by serverName when provided", () => {
    analytics.record({
      serverName: "alpha",
      toolName: "tool1",
      latencyMs: 10,
      success: true,
      timestamp: 0,
    });
    analytics.record({
      serverName: "beta",
      toolName: "tool2",
      latencyMs: 20,
      success: false,
      timestamp: 0,
    });

    const alphaStats = analytics.getStats("alpha");
    expect(alphaStats.totalCalls).toBe(1);
    expect(alphaStats.successRate).toBe(1);
    expect("alpha:tool1" in alphaStats.byTool).toBe(true);
    expect("beta:tool2" in alphaStats.byTool).toBe(false);

    const betaStats = analytics.getStats("beta");
    expect(betaStats.totalCalls).toBe(1);
    expect(betaStats.successRate).toBe(0);
  });

  it("returns empty stats for a serverName with no records", () => {
    analytics.record({
      serverName: "alpha",
      toolName: "t",
      latencyMs: 10,
      success: true,
      timestamp: 0,
    });
    const stats = analytics.getStats("unknown");
    expect(stats.totalCalls).toBe(0);
    expect(stats.successRate).toBe(1);
    expect(stats.avgLatencyMs).toBe(0);
  });

  it("evicts oldest record when maxRecords is exceeded", () => {
    // Access private field for testing via type cast
    const maxRecords = (analytics as unknown as { maxRecords: number })
      .maxRecords;
    for (let i = 0; i < maxRecords + 10; i++) {
      analytics.record({
        serverName: "s",
        toolName: `tool_${i}`,
        latencyMs: i,
        success: true,
        timestamp: i,
      });
    }

    const stats = analytics.getStats();
    expect(stats.totalCalls).toBe(maxRecords);
    // First 10 records were evicted, so tool_0..tool_9 should be gone
    expect(`s:tool_0` in stats.byTool).toBe(false);
  });

  it("clear() removes all records", () => {
    analytics.record({
      serverName: "s",
      toolName: "t",
      latencyMs: 10,
      success: true,
      timestamp: 0,
    });
    analytics.clear();
    const stats = analytics.getStats();
    expect(stats.totalCalls).toBe(0);
    expect(stats.byTool).toEqual({});
  });
});

describe("MCPClientManager analytics integration", () => {
  it("records a successful tool call with timing", async () => {
    const manager = new MCPClientManager();
    const analytics = new McpAnalytics();
    manager.analytics = analytics;

    // Stub _invokeToolInternal via the private method by mocking sendRequest
    // We mock at the invokeTool level by overriding the private method
    (
      manager as unknown as {
        _invokeToolInternal: (...args: unknown[]) => unknown;
      }
    )._invokeToolInternal = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });

    const result = await manager.invokeTool("test-srv", "my_tool", {});
    expect(result.isError).toBe(false);

    const stats = analytics.getStats("test-srv");
    expect(stats.totalCalls).toBe(1);
    expect(stats.successRate).toBe(1);
    expect("test-srv:my_tool" in stats.byTool).toBe(true);
  });

  it("records a failed tool call", async () => {
    const manager = new MCPClientManager();
    const analytics = new McpAnalytics();
    manager.analytics = analytics;

    (
      manager as unknown as {
        _invokeToolInternal: (...args: unknown[]) => unknown;
      }
    )._invokeToolInternal = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "error" }],
      isError: true,
    });

    await manager.invokeTool("test-srv", "bad_tool", {});

    const stats = analytics.getStats("test-srv");
    expect(stats.totalCalls).toBe(1);
    expect(stats.successRate).toBe(0);
  });

  it("does not throw if analytics is not wired", async () => {
    const manager = new MCPClientManager();
    // No analytics set

    (
      manager as unknown as {
        _invokeToolInternal: (...args: unknown[]) => unknown;
      }
    )._invokeToolInternal = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });

    await expect(manager.invokeTool("srv", "tool", {})).resolves.toBeDefined();
  });
});
