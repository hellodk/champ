import { describe, expect, it, vi } from "vitest";
import {
  executeSlashCommand,
  formatCostReport,
  formatUsageReport,
  formatContextReport,
  formatRouteReport,
  formatTasksReport,
  formatToolsReport,
  formatMcpReport,
  formatDoctorReport,
  formatIST,
  type SlashCommandContext,
} from "@/cli/slash-commands";
import { MetricsCollector } from "@/observability/metrics-collector";
import { BudgetEnforcer, PRICING_TABLE_VERSION } from "@/config/budget";
import type { AgentController } from "@/agent/agent-controller";
import type { ToolRegistry } from "@/tools/registry";
import type { McpRegistry } from "@/mcp/mcp-registry";

function createMockController(
  overrides: Partial<AgentController> = {},
): AgentController {
  const metrics = new MetricsCollector();
  return {
    getProvider: () => ({
      name: "anthropic",
      modelInfo: () => ({
        id: "claude-3-5-sonnet-20241022",
        name: "Claude 3.5 Sonnet",
        contextWindow: 200000,
      }),
      config: { maxTokens: 4096 },
      countTokens: (text: string) => Math.ceil(text.length / 4),
    }),
    getMode: () => "agent",
    getHistory: () => [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there!" },
    ],
    getToolRegistry: () => ({
      getAll: () => [
        {
          name: "read_file",
          description: "Read file",
          requiresApproval: false,
        },
        {
          name: "write_file",
          description: "Write file",
          requiresApproval: true,
        },
      ],
    }),
    getMetrics: () => metrics,
    getBudget: () => undefined,
    getSmartRouter: () => undefined,
    getAnalytics: () => undefined,
    ...overrides,
  } as unknown as AgentController;
}

describe("formatIST", () => {
  it("formats timestamps ending in IST with 24-hour time and Asia/Kolkata timezone", () => {
    // 2026-06-02T11:00:45.000Z -> 2026-06-02 16:30:45 IST (UTC+5:30)
    const utcDate = new Date("2026-06-02T11:00:45.000Z");
    const result = formatIST(utcDate);
    expect(result).toMatch(/02\s+[A-Za-z]+\s+2026,\s+16:30:45\s+IST/);
    expect(result.endsWith(" IST")).toBe(true);
  });

  it("handles missing or invalid date gracefully", () => {
    expect(formatIST(undefined)).toBe("n/a");
    expect(formatIST(null)).toBe("n/a");
    expect(formatIST(new Date("invalid"))).toBe("n/a");
  });
});

describe("/cost and formatCostReport", () => {
  it("generates cost report for known models with budget snapshots", async () => {
    const budget = new BudgetEnforcer({
      maxUsdPerRun: 10,
      maxUsdPerDay: 50,
      maxTokensPerRun: 1_000_000,
      maxTokensPerDay: 5_000_000,
    });
    budget.record({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      inputTokens: 5000,
      outputTokens: 2000,
      cacheReadTokens: 1000,
      cacheWriteTokens: 500,
    });

    const controller = createMockController({ getBudget: () => budget });
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
      budget,
    };

    const report = await formatCostReport(ctx);
    expect(report).toContain("Budget & Cost Report");
    expect(report).toContain("Active Provider:   anthropic");
    expect(report).toContain("Active Model:      claude-3-5-sonnet-20241022");
    expect(report).toContain(`Rate Table Ver:    ${PRICING_TABLE_VERSION}`);
    expect(report).toContain("Pricing Status:    Known");
    expect(report).toContain("Current Run Spend:");
    expect(report).toContain("Input Tokens:    5,000");
    expect(report).toContain("Output Tokens:   2,000");
    expect(report).toContain("Configured Budget Limits:");
    expect(report).toContain("Max USD / Run:   $10");
  });

  it("handles unknown model pricing by explicitly reporting unknown status (fails closed)", async () => {
    const controller = createMockController({
      getProvider: () => ({
        name: "custom-provider",
        modelInfo: () => ({
          id: "mysterious-model-9000",
          name: "Mysterious Model",
          contextWindow: 128000,
        }),
        config: {},
        countTokens: (text: string) => Math.ceil(text.length / 4),
      }),
    });
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
    };

    const report = await formatCostReport(ctx);
    expect(report).toContain("Pricing Status:    UNKNOWN");
    expect(report).toContain("unknown model pricing is treated as unknown");
  });

  it("falls back to metrics collector token spend when budget is unconfigured", async () => {
    const metrics = new MetricsCollector();
    metrics.recordRequest({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      inputTokens: 1500,
      outputTokens: 120,
      totalLatency: 2500,
      requestLatency: 800,
      success: true,
    });

    const controller = createMockController({
      getMetrics: () => metrics,
      getBudget: () => undefined,
    });
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
      metrics,
    };

    const report = await formatCostReport(ctx);
    expect(report).toContain("Session Spend (estimated from metrics):");
    expect(report).toContain("Input Tokens:    1,500");
    expect(report).toContain("Output Tokens:   120");
    expect(report).toContain("Estimated Cost:  $");
  });
});

describe("/usage and formatUsageReport", () => {
  it("reports cumulative counters, rolling averages and latency histogram distributions", () => {
    const metrics = new MetricsCollector();
    metrics.recordRequest({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      inputTokens: 100,
      outputTokens: 20,
      totalLatency: 150,
      requestLatency: 45,
      success: true,
    });
    metrics.recordRequest({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      inputTokens: 200,
      outputTokens: 40,
      totalLatency: 800,
      requestLatency: 110,
      success: true,
    });
    metrics.recordToolCall({
      toolName: "read_file",
      durationMs: 60,
      success: true,
      timestamp: Date.now(),
    });
    metrics.recordAgentStep({
      agentName: "agent",
      input: "read file",
      output: "done",
      durationMs: 200,
      success: true,
      startTime: Date.now(),
    });

    const controller = createMockController({ getMetrics: () => metrics });
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
      metrics,
    };

    const report = formatUsageReport(ctx);
    expect(report).toContain("Token & Telemetry Usage");
    expect(report).toContain("Session Start:");
    expect(report).toContain("IST");
    expect(report).toContain("Cumulative Lifetime Counters:");
    expect(report).toContain("Total Requests:    2");
    expect(report).toContain("Input Tokens:      300");
    expect(report).toContain("Output Tokens:     60");
    expect(report).toContain(
      "Rolling Window (2 recent requests in sample buffer):",
    );
    expect(report).toContain("Rolling Tokens In: 300");
    expect(report).toContain("Rolling Tokens Out:60");
    expect(report).toContain("Rolling Avg TTFT:");
    expect(report).toContain("Latency Distribution (Total Request Duration):");
    expect(report).toContain("p50:");
    expect(report).toContain("p90:");
    expect(report).toContain("Execution & Tool Totals:");
    expect(report).toContain("Tool Invocations:  1");
    expect(report).toContain("Agent Steps:       1");
  });

  it("returns notification when metrics collector is not wired", () => {
    const controller = createMockController({ getMetrics: () => undefined });
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
    };

    const report = formatUsageReport(ctx);
    expect(report).toContain(
      "Observability metrics collector is not wired in this session.",
    );
  });
});

describe("/context and formatContextReport", () => {
  it("reports context window, remaining capacity, token estimate, and checkpoint state", async () => {
    const controller = createMockController({
      getHistory: () => [
        { role: "system", content: "You are Champ" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
        { role: "tool", content: "Tool output" },
      ],
    });
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
      sessionLog: {
        checkpoint: { label: "step-1", upTo: 2, timestamp: 1234567890 },
      } as unknown as SlashCommandContext["sessionLog"],
    };

    const report = await formatContextReport(ctx);
    expect(report).toContain("Context Window Telemetry");
    expect(report).toContain("Context Window:    200,000 tokens");
    expect(report).toContain("Output Reserved:   4,096 tokens");
    expect(report).toContain("Usable Input Budget:195,904 tokens");
    expect(report).toContain(
      "History Messages:  4 (1 user, 1 assistant, 1 tool, 1 system)",
    );
    expect(report).toContain("Remaining Capacity:");
    expect(report).toContain('Active Checkpoint: "step-1" at 2 messages');
    expect(report).toContain(
      'Compaction State:  Earliest messages elided to checkpoint "step-1"',
    );
  });
});

describe("/route and formatRouteReport", () => {
  it("explains canonical scope, source, pins and exclusions", () => {
    const decision = {
      target: { endpointId: "ep_a", modelId: "m1" },
      scope: "pool" as const,
      scopeKey: "pool_local",
      pinned: false,
      source: "selection" as const,
      reason: "ranked by explicit balanced preference",
      preference: "balanced" as const,
      candidates: [{ endpointId: "ep_a", modelId: "m1" }],
      excluded: [
        {
          target: { endpointId: "ep_b", modelId: "m2" },
          reason: "no proven tools",
        },
      ],
      alternatives: [],
    };
    const controller = createMockController({
      getSmartRouter: () =>
        ({
          getMode: () => "smart",
          getModels: () => [],
          select: () => null,
          getLastRouteDecision: () => decision,
        }) as never,
    });
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
    };

    const report = formatRouteReport(ctx);
    expect(report).toContain("Decision Source:   selection");
    expect(report).toContain("Scope:             pool/pool_local");
    expect(report).toContain("Pinned:            no");
    expect(report).toContain(
      "Reason:            ranked by explicit balanced preference",
    );
    expect(report).toContain("excluded: ep_b/m2 — no proven tools");
  });

  it("reports direct mode when SmartRouter is not configured", () => {
    const controller = createMockController();
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
    };

    const report = formatRouteReport(ctx);
    expect(report).toContain("Smart Router & Model Routing");
    expect(report).toContain(
      'Active Mode:       agent (mapped to task: "coding")',
    );
    expect(report).toContain("Active Provider:   anthropic");
    expect(report).toContain("Active Model:      claude-3-5-sonnet-20241022");
    expect(report).toContain("Router Mode:       Direct");
  });

  it("reports routing decisions and model candidates when SmartRouter is present", () => {
    const mockRouter = {
      getMode: () => "cost-optimized",
      getModels: () => [
        {
          id: "claude-3-5-haiku-20241022",
          providerName: "anthropic",
          speed: "fast",
          contextWindow: 200000,
          capabilities: ["chat", "coding"],
        },
        {
          id: "claude-3-5-sonnet-20241022",
          providerName: "anthropic",
          speed: "medium",
          contextWindow: 200000,
          capabilities: ["chat", "coding"],
        },
      ],
      select: () => ({
        model: { id: "claude-3-5-haiku-20241022", providerName: "anthropic" },
        reason: "Cost efficiency preferred for coding",
      }),
    };

    const controller = createMockController({
      getSmartRouter: () =>
        mockRouter as unknown as ReturnType<AgentController["getSmartRouter"]>,
    });
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
    };

    const report = formatRouteReport(ctx);
    expect(report).toContain("Router Mode:       cost-optimized");
    expect(report).toContain("Discovered Models: 2");
    expect(report).toContain("Router Selection Decision:");
    expect(report).toContain("Selected Model:  claude-3-5-haiku-20241022");
    expect(report).toContain(
      "Reasoning:       Cost efficiency preferred for coding",
    );
    expect(report).toContain("Candidate Models:");
    expect(report).toContain("claude-3-5-haiku-20241022");
  });
});

describe("/tasks and formatTasksReport", () => {
  it("reports empty status when no agent steps are recorded", () => {
    const controller = createMockController();
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
    };

    const report = formatTasksReport(ctx);
    expect(report).toContain("Agent Tasks & Step History");
    expect(report).toContain("Total Recorded Steps: 0");
    expect(report).toContain("No agent steps recorded in this session yet.");
  });

  it("reports step history with IST timestamps, duration and character counts", () => {
    const metrics = new MetricsCollector();
    metrics.recordAgentStep({
      agentName: "planner",
      input: "plan implementation",
      output: "Plan created",
      durationMs: 1500,
      success: true,
      startTime: Date.now(),
    });
    metrics.recordAgentStep({
      agentName: "coder",
      input: "write tests",
      output: "Error writing file",
      durationMs: 800,
      success: false,
      error: "Permission denied",
      startTime: Date.now(),
    });

    const controller = createMockController({ getMetrics: () => metrics });
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
      metrics,
    };

    const report = formatTasksReport(ctx);
    expect(report).toContain("Total Recorded Steps: 2");
    expect(report).toContain("✓ planner · 1.50s");
    expect(report).toContain("✗ coder · 0.80s");
    expect(report).toContain("Error: Permission denied");
    expect(report).toContain("IST");
  });
});

describe("/tools and formatToolsReport", () => {
  it("reports tool catalog with call counts, success/error rates, total and avg durations", () => {
    const metrics = new MetricsCollector();
    metrics.recordToolCall({
      toolName: "read_file",
      durationMs: 50,
      success: true,
      timestamp: Date.now(),
    });
    metrics.recordToolCall({
      toolName: "read_file",
      durationMs: 150,
      success: true,
      timestamp: Date.now(),
    });
    metrics.recordToolCall({
      toolName: "write_file",
      durationMs: 200,
      success: false,
      timestamp: Date.now(),
    });

    const controller = createMockController({ getMetrics: () => metrics });
    const toolRegistry: ToolRegistry = {
      getAll: () => [
        {
          name: "read_file",
          description: "Read file",
          requiresApproval: false,
        },
        {
          name: "write_file",
          description: "Write file",
          requiresApproval: true,
        },
      ],
    } as unknown as ToolRegistry;

    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
      metrics,
      toolRegistry,
    };

    const report = formatToolsReport(ctx);
    expect(report).toContain("Registered Tools & Performance");
    expect(report).toContain("Registered Tools: 2");
    expect(report).toContain("read_file");
    expect(report).toContain("write_file");
    // read_file had 2 calls, 2 success, 0 error, 200ms total, 100ms avg
    expect(report).toMatch(/read_file\s+2\s+2\s+0\s+200ms\s+100ms\s+No/);
    // write_file had 1 call, 0 success, 1 error, 200ms total, 200ms avg
    expect(report).toMatch(/write_file\s+1\s+0\s+1\s+200ms\s+200ms\s+Yes/);
  });
});

describe("/mcp and formatMcpReport", () => {
  it("reports guidance when MCP registry is not attached", async () => {
    const controller = createMockController();
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
    };

    const report = await formatMcpReport(ctx);
    expect(report).toContain("Model Context Protocol (MCP) Status");
    expect(report).toContain("MCP registry is not attached in this session.");
  });

  it("reports connected servers, resources, prompts and call analytics", async () => {
    const mockMcp: McpRegistry = {
      listAllResources: async () =>
        new Map([
          [
            "postgres-mcp",
            [
              { name: "schema", uri: "postgres://db/schema" },
              { name: "tables", uri: "postgres://db/tables" },
            ],
          ],
        ]),
      listAllPrompts: async () =>
        new Map([
          [
            "code-review-mcp",
            [
              {
                name: "security-audit",
                description: "Audit security of git diff",
              },
            ],
          ],
        ]),
      getAnalytics: () => ({
        totalCalls: 15,
        successRate: 0.9333,
        avgLatencyMs: 145,
      }),
    } as unknown as McpRegistry;

    const controller = createMockController();
    const ctx: SlashCommandContext = {
      workspace: "/test/workspace",
      controller,
      mcpRegistry: mockMcp,
    };

    const report = await formatMcpReport(ctx);
    expect(report).toContain("Connected Resource Servers: 1");
    expect(report).toContain("Connected Prompt Servers:   1");
    expect(report).toContain("postgres-mcp (2 resource(s))");
    expect(report).toContain("postgres://db/schema");
    expect(report).toContain("code-review-mcp (1 prompt(s))");
    expect(report).toContain("security-audit: Audit security of git diff");
    expect(report).toContain("MCP Call Analytics:");
    expect(report).toContain("Total MCP Calls:   15");
    expect(report).toContain("Success Rate:      93%");
    expect(report).toContain("Average Latency:   145ms");
  });
});

describe("/doctor and formatDoctorReport", () => {
  it("runs fallback diagnostics when no custom doctor callback is provided", async () => {
    const controller = createMockController();
    const ctx: SlashCommandContext = {
      workspace: "/my/project",
      controller,
    };

    const report = await formatDoctorReport(ctx);
    expect(report).toContain("Champ Doctor & System Health");
    expect(report).toContain("Overall Status:    HEALTHY (PASS)");
    expect(report).toContain(
      "Provider\tanthropic configured (Claude 3.5 Sonnet)",
    );
    expect(report).toContain("Workspace\t/my/project");
    expect(report).toContain(
      `Rate Table\tVersion ${PRICING_TABLE_VERSION} loaded`,
    );
  });

  it("delegates to custom doctor callback when provided", async () => {
    const controller = createMockController();
    const ctx: SlashCommandContext = {
      workspace: "/my/project",
      controller,
      doctor: async () => ({
        healthy: false,
        lines: [
          "✓ ok Provider reachable",
          "✗ fail Rate limit exceeded on OpenAI API",
        ],
      }),
    };

    const report = await formatDoctorReport(ctx);
    expect(report).toContain("Overall Status:    FAILURES DETECTED");
    expect(report).toContain("✓ ok Provider reachable");
    expect(report).toContain("✗ fail Rate limit exceeded on OpenAI API");
  });
});

describe("executeSlashCommand dispatch", () => {
  it("dispatches all 8 commands and recognized aliases", async () => {
    const controller = createMockController();
    const ctx: SlashCommandContext = {
      workspace: "/test/ws",
      controller,
    };

    expect(await executeSlashCommand("/cost", ctx)).toContain(
      "Budget & Cost Report",
    );
    expect(await executeSlashCommand("/pricing", ctx)).toContain(
      "Budget & Cost Report",
    );
    expect(await executeSlashCommand("/budget", ctx)).toContain(
      "Budget & Cost Report",
    );

    expect(await executeSlashCommand("/usage", ctx)).toContain(
      "Token & Telemetry Usage",
    );
    expect(await executeSlashCommand("/tokens", ctx)).toContain(
      "Token & Telemetry Usage",
    );
    expect(await executeSlashCommand("/metrics", ctx)).toContain(
      "Token & Telemetry Usage",
    );

    expect(await executeSlashCommand("/context", ctx)).toContain(
      "Context Window Telemetry",
    );
    expect(await executeSlashCommand("/ctx", ctx)).toContain(
      "Context Window Telemetry",
    );

    expect(await executeSlashCommand("/route", ctx)).toContain(
      "Smart Router & Model Routing",
    );
    expect(await executeSlashCommand("/router", ctx)).toContain(
      "Smart Router & Model Routing",
    );
    expect(await executeSlashCommand("/routing", ctx)).toContain(
      "Smart Router & Model Routing",
    );

    expect(await executeSlashCommand("/tasks", ctx)).toContain(
      "Agent Tasks & Step History",
    );
    expect(await executeSlashCommand("/task", ctx)).toContain(
      "Agent Tasks & Step History",
    );

    expect(await executeSlashCommand("/tools", ctx)).toContain(
      "Registered Tools & Performance",
    );
    expect(await executeSlashCommand("/tool", ctx)).toContain(
      "Registered Tools & Performance",
    );

    expect(await executeSlashCommand("/mcp", ctx)).toContain(
      "Model Context Protocol (MCP) Status",
    );

    expect(await executeSlashCommand("/doctor", ctx)).toContain(
      "Champ Doctor & System Health",
    );
    expect(await executeSlashCommand("/health", ctx)).toContain(
      "Champ Doctor & System Health",
    );
    expect(await executeSlashCommand("/check", ctx)).toContain(
      "Champ Doctor & System Health",
    );
  });

  it("returns null for unrecognized commands", async () => {
    const controller = createMockController();
    const ctx: SlashCommandContext = {
      workspace: "/test/ws",
      controller,
    };

    expect(await executeSlashCommand("/unknown", ctx)).toBeNull();
    expect(await executeSlashCommand("/foobar", ctx)).toBeNull();
  });
});
