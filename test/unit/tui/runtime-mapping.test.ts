import { describe, expect, it } from "vitest";
import {
  mapMcpStatus,
  toolResultFromCompletion,
  usageFromSummary,
} from "@/tui/runtime-mapping";

describe("runtime event mapping", () => {
  it("maps MCP connection status into TUI health", () => {
    expect(
      mapMcpStatus({ name: "fs", connected: true, toolCount: 4 }),
    ).toMatchObject({ health: "healthy", status: "running", tools: 4 });
    expect(
      mapMcpStatus({
        name: "bad",
        connected: false,
        toolCount: 0,
        error: "refused",
      }),
    ).toMatchObject({ health: "down", status: "stopped", error: "refused" });
  });

  it("preserves full tool output and maps failure details", () => {
    const event = toolResultFromCompletion(
      {
        id: "t1",
        name: "run",
        output: "x".repeat(300),
        success: false,
        stderr: "boom",
        exitCode: 2,
        durationMs: 12,
      },
      { id: "t1", startedAt: "start" },
    );
    expect(event.output).toHaveLength(300);
    expect(event).toMatchObject({
      stderr: "boom",
      exitCode: 2,
      durationMs: 12,
      error: "boom",
    });
  });

  it("derives a usage record from a turn summary", () => {
    const record = usageFromSummary(
      { inputTokens: 3, outputTokens: 4 },
      { at: "now", model: "m", provider: "p", latencyMs: 10, costUsd: 0.001 },
    );
    expect(record).toMatchObject({
      inputTokens: 3,
      outputTokens: 4,
      model: "m",
      provider: "p",
    });
  });

  it("preserves cache tokens and nullable unknown cost in usageFromSummary", () => {
    const record = usageFromSummary(
      {
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 40,
        cacheWriteTokens: 10,
      },
      {
        at: "now",
        model: "custom-model",
        provider: "unknown-vendor",
        latencyMs: 250,
        costUsd: null,
        costKnown: false,
        costSource: "unknown",
      },
    );
    expect(record).toMatchObject({
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      costUsd: null,
      costKnown: false,
      costSource: "unknown",
    });
  });
});
