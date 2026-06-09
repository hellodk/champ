/**
 * TDD: Tests for MetricsCollector.
 * Tracks latency, tokens, agent steps, failures.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MetricsCollector } from "@/observability/metrics-collector";
import type {
  Metrics,
  AgentStepLog,
  ToolCallLog,
} from "@/observability/metrics-collector";
import { ToolCallingLoop } from "@/agent/tool-calling-loop";
import { TeamAgent } from "@/agent/team-agent";
import { SharedMemory } from "@/agent/shared-memory";

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

describe("MetricsCollector wiring", () => {
  it("recordToolCall stores log entries", () => {
    const mc = new MetricsCollector();
    mc.recordToolCall({
      toolName: "read_file",
      startTime: Date.now(),
      durationMs: 50,
      success: true,
      args: { path: "/tmp/test" },
      result: "file content",
    });
    const metrics = mc.getMetrics();
    expect(metrics.toolCalls).toHaveLength(1);
    expect(metrics.toolCalls[0].toolName).toBe("read_file");
  });

  it("recordAgentStep stores log entries", () => {
    const mc = new MetricsCollector();
    mc.recordAgentStep({
      agentName: "researcher",
      startTime: Date.now() - 100,
      endTime: Date.now(),
      durationMs: 100,
      input: "research topic X",
      output: "findings about X",
      success: true,
    });
    const metrics = mc.getMetrics();
    expect(metrics.agentSteps).toHaveLength(1);
    expect(metrics.agentSteps[0].agentName).toBe("researcher");
  });

  it("ToolCallingLoop calls metrics.recordToolCall when a tool executes", async () => {
    const mc = new MetricsCollector();
    const recordToolCallSpy = vi.spyOn(mc, "recordToolCall");

    const fakeRegistry = {
      getDefinitions: () => [
        {
          name: "echo",
          description: "echo tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      execute: vi.fn().mockResolvedValue({ output: "echoed", success: true }),
    };

    let callCount = 0;
    const fakeProvider = {
      chat: async function* () {
        callCount++;
        if (callCount === 1) {
          // First iteration: emit a tool call
          yield {
            type: "tool_call_start" as const,
            toolCall: {
              id: "call_1",
              name: "echo",
              arguments: { msg: "hello" },
            },
          };
          yield {
            type: "done" as const,
            usage: { inputTokens: 5, outputTokens: 2 },
          };
        } else {
          // Second iteration: no more tool calls — loop terminates
          yield { type: "text" as const, text: "done" };
          yield {
            type: "done" as const,
            usage: { inputTokens: 3, outputTokens: 1 },
          };
        }
      },
    };

    const loop = new ToolCallingLoop(
      fakeProvider as any,
      fakeRegistry as any,
      {
        workspaceRoot: "/tmp",
        abortSignal: new AbortController().signal,
        reportProgress: () => {},
        requestApproval: async () => true,
      },
      mc,
    );

    await loop.run([{ role: "user", content: "call echo" }]);

    expect(recordToolCallSpy).toHaveBeenCalledTimes(1);
    expect(recordToolCallSpy.mock.calls[0][0].toolName).toBe("echo");
    expect(recordToolCallSpy.mock.calls[0][0].success).toBe(true);
  });

  it("TeamAgent calls metrics.recordAgentStep after execute()", async () => {
    const mc = new MetricsCollector();
    const recordAgentStepSpy = vi.spyOn(mc, "recordAgentStep");

    const agentDef = {
      id: "spy-agent",
      name: "SpyAgent",
      role: "Spy",
      systemPrompt: "You are a spy agent.",
      dependsOn: [] as string[],
      condition: "",
      tools: [] as string[],
      model: "",
      maxTokens: 100,
      outputKey: "spy",
      outputFormat: "text" as const,
      selfCritique: false,
    };

    const fakeProvider = {
      name: "fake",
      config: { provider: "fake" as const, model: "fake" },
      chat: async function* () {
        yield { type: "text" as const, text: "spy output" };
        yield {
          type: "done" as const,
          usage: { inputTokens: 3, outputTokens: 5 },
        };
      },
      complete: async function* () {},
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      countTokens: (text: string) => Math.ceil(text.length / 4),
      modelInfo: () => ({
        contextWindow: 4096,
        name: "fake",
        provider: "fake" as const,
      }),
      dispose: () => {},
    };

    const agent = new TeamAgent(agentDef, fakeProvider as any);
    agent.setMetrics(mc);

    const memory = new SharedMemory();
    await agent.execute({ userRequest: "do something", context: [] }, memory);

    expect(recordAgentStepSpy).toHaveBeenCalledTimes(1);
    expect(recordAgentStepSpy.mock.calls[0][0].agentName).toBe("spy-agent");
    expect(recordAgentStepSpy.mock.calls[0][0].success).toBe(true);
  });
});
