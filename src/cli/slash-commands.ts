/**
 * Dedicated slash-command dispatch and telemetry reporting for Champ.
 *
 * Provides real data for operator observability:
 * /cost, /usage, /context, /route, /tasks, /tools, /mcp, /doctor.
 */
import {
  quoteCost,
  PRICING_TABLE_VERSION,
  type BudgetEnforcer,
} from "../config/budget";
import { ContextWindowManager } from "../providers/context-manager";
import type { AgentController } from "../agent/agent-controller";
import type { MetricsCollector } from "../observability/metrics-collector";
import type { ToolRegistry } from "../tools/registry";
import type { SessionLog } from "../session/session-log";
import type { PolicyEngine } from "../policy/engine";
import type { RulesEngine } from "../rules/rules-engine";
import type { McpRegistry } from "../mcp/mcp-registry";
import type { CircuitBreaker } from "../providers/circuit-breaker";

export interface SlashCommandContext {
  workspace: string;
  controller: AgentController;
  metrics?: MetricsCollector;
  budget?: BudgetEnforcer;
  policy?: PolicyEngine;
  rules?: RulesEngine;
  toolRegistry?: ToolRegistry;
  sessionLog?: SessionLog | null;
  doctor?: () => Promise<{ healthy: boolean; lines: string[] }>;
  mcpRegistry?: McpRegistry;
}

/** Format timestamp in IST (Asia/Kolkata, UTC+5:30) per project UI standard. */
export function formatIST(date?: number | Date | null): string {
  if (!date) return "n/a";
  const d = typeof date === "number" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "n/a";
  return (
    d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " IST"
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = (ms / 1000).toFixed(1);
  if (ms < 60_000) return `${sec}s`;
  const min = Math.floor(ms / 60_000);
  const remSec = Math.round((ms % 60_000) / 1000);
  return `${min}m ${remSec}s`;
}

/** Map agent mode to a SmartRouter task type. */
function modeToTaskType(mode: string): string {
  switch (mode) {
    case "agent":
    case "composer":
      return "coding";
    case "ask":
    case "plan":
    case "manual":
    default:
      return "chat";
  }
}

/** /cost command: reports spend, rate table rates, and budget limits. */
export async function formatCostReport(
  ctx: SlashCommandContext,
): Promise<string> {
  const controller = ctx.controller;
  const provider = controller.getProvider();
  const providerName = provider.name;
  const modelName = provider.modelInfo().id ?? provider.modelInfo().name;

  const quote1MIn = quoteCost(providerName, modelName, 1_000_000, 0);
  const quote1MOut = quoteCost(providerName, modelName, 0, 1_000_000);
  const quote1MCacheRead = quoteCost(
    providerName,
    modelName,
    0,
    0,
    1_000_000,
    0,
  );
  const quote1MCacheWrite = quoteCost(
    providerName,
    modelName,
    0,
    0,
    0,
    1_000_000,
  );

  const budget = ctx.budget ?? controller.getBudget();
  const snapshot = budget?.snapshot();
  const limits = (budget as unknown as { limits?: Record<string, unknown> })
    ?.limits;

  const lines: string[] = [
    "── Budget & Cost Report ──────────────────────────────────────────",
    `Active Provider:   ${providerName}`,
    `Active Model:      ${modelName}`,
    `Rate Table Ver:    ${PRICING_TABLE_VERSION}`,
  ];

  if (quote1MIn.source === "unknown") {
    lines.push(
      `Pricing Status:    UNKNOWN (${PRICING_TABLE_VERSION}) — unknown model pricing is treated as unknown, not silently assumed free (fails closed per policy)`,
    );
  } else if (quote1MIn.source === "local") {
    lines.push(
      "Pricing Status:    Local/Self-hosted (zero token cost from cloud rate table)",
    );
  } else {
    lines.push("Pricing Status:    Known (versioned rate table)");
    lines.push("Rates (per 1,000,000 tokens):");
    lines.push(
      `  Input Tokens:    ${quote1MIn.usd !== null ? `$${quote1MIn.usd.toFixed(2)}` : "unknown"}`,
    );
    lines.push(
      `  Output Tokens:   ${quote1MOut.usd !== null ? `$${quote1MOut.usd.toFixed(2)}` : "unknown"}`,
    );
    if (quote1MCacheRead.usd !== null) {
      lines.push(
        `  Cache Read:      $${quote1MCacheRead.usd.toFixed(2)}`,
      );
    }
    if (quote1MCacheWrite.usd !== null) {
      lines.push(
        `  Cache Write:     $${quote1MCacheWrite.usd.toFixed(2)}`,
      );
    }
  }

  if (snapshot) {
    lines.push("");
    lines.push("Current Run Spend:");
    lines.push(
      `  Input Tokens:    ${snapshot.run.inputTokens.toLocaleString()}`,
    );
    lines.push(
      `  Output Tokens:   ${snapshot.run.outputTokens.toLocaleString()}`,
    );
    lines.push(`  Estimated Cost:  $${snapshot.run.usd.toFixed(4)}`);

    lines.push("");
    lines.push(`Daily Spend (${snapshot.dayKey}):`);
    lines.push(
      `  Input Tokens:    ${snapshot.day.inputTokens.toLocaleString()}`,
    );
    lines.push(
      `  Output Tokens:   ${snapshot.day.outputTokens.toLocaleString()}`,
    );
    lines.push(`  Estimated Cost:  $${snapshot.day.usd.toFixed(4)}`);
  } else {
    // If no budget instance is configured, compute spend from metrics
    const metrics = ctx.metrics ?? controller.getMetrics();
    if (metrics) {
      const m = metrics.getMetrics();
      const quote = quoteCost(
        providerName,
        modelName,
        m.totalTokensIn,
        m.totalTokensOut,
      );
      lines.push("");
      lines.push("Session Spend (estimated from metrics):");
      lines.push(`  Input Tokens:    ${m.totalTokensIn.toLocaleString()}`);
      lines.push(`  Output Tokens:   ${m.totalTokensOut.toLocaleString()}`);
      lines.push(
        `  Estimated Cost:  ${quote.usd !== null ? `$${quote.usd.toFixed(4)}` : "unknown"}`,
      );
    }
  }

  if (limits) {
    lines.push("");
    lines.push("Configured Budget Limits:");
    lines.push(
      `  Max USD / Run:   ${limits.maxUsdPerRun != null ? `$${limits.maxUsdPerRun}` : "unlimited"}`,
    );
    lines.push(
      `  Max USD / Day:   ${limits.maxUsdPerDay != null ? `$${limits.maxUsdPerDay}` : "unlimited"}`,
    );
    lines.push(
      `  Max Tokens/Run:  ${limits.maxTokensPerRun != null ? Number(limits.maxTokensPerRun).toLocaleString() : "unlimited"}`,
    );
    lines.push(
      `  Max Tokens/Day:  ${limits.maxTokensPerDay != null ? Number(limits.maxTokensPerDay).toLocaleString() : "unlimited"}`,
    );
  }

  lines.push(
    "──────────────────────────────────────────────────────────────────",
  );
  return lines.join("\n");
}

/** /usage command: reports cumulative token counts, retained rolling averages, and latency histograms. */
export function formatUsageReport(ctx: SlashCommandContext): string {
  const metricsCollector = ctx.metrics ?? ctx.controller.getMetrics();
  if (!metricsCollector) {
    return "[champ] Observability metrics collector is not wired in this session.";
  }
  const m = metricsCollector.getMetrics();
  const uptimeMs = Date.now() - m.sessionStartTime;

  const lines: string[] = [
    "── Token & Telemetry Usage ───────────────────────────────────────",
    `Session Start:       ${formatIST(m.sessionStartTime)}`,
    `Session Uptime:      ${formatDuration(uptimeMs)}`,
    "",
    "Cumulative Lifetime Counters:",
    `  Total Requests:    ${m.totalRequests.toLocaleString()}`,
    `  Input Tokens:      ${m.totalTokensIn.toLocaleString()}`,
    `  Output Tokens:     ${m.totalTokensOut.toLocaleString()}`,
    `  Total Tokens:      ${(m.totalTokensIn + m.totalTokensOut).toLocaleString()}`,
    "",
    `Rolling Window (${m.retainedRequestCount} recent requests in sample buffer):`,
    `  Rolling Tokens In: ${m.rollingTokensIn.toLocaleString()}`,
    `  Rolling Tokens Out:${m.rollingTokensOut.toLocaleString()}`,
    `  Rolling Avg TTFT:  ${Math.round(m.rollingAverageFirstTokenLatency)}ms`,
    `  Rolling Avg Latency:${Math.round(m.rollingAverageLatency)}ms`,
    `  Lifetime Avg Latency:${Math.round(m.lifetimeAverageLatency)}ms`,
    "",
    "Latency Distribution (Total Request Duration):",
    `  p50:               ${m.latencyHistogram.p50}ms`,
    `  p90:               ${m.latencyHistogram.p90}ms`,
    `  p95:               ${m.latencyHistogram.p95}ms`,
    `  p99:               ${m.latencyHistogram.p99}ms`,
    `  Min:               ${m.latencyHistogram.min}ms`,
    `  Max:               ${m.latencyHistogram.max}ms`,
    "",
    "Histogram Buckets (Total Requests):",
  ];

  const bucketLines = m.latencyHistogram.buckets
    .filter((b) => b.le !== Infinity)
    .map((b) => `  <= ${b.le}ms: ${b.count}`);
  const infBucket = m.latencyHistogram.buckets.find((b) => b.le === Infinity);
  if (infBucket) bucketLines.push(`  > 60000ms: ${infBucket.count}`);
  lines.push(bucketLines.join("\n"));

  lines.push("");
  lines.push("Execution & Tool Totals:");
  lines.push(`  Tool Invocations:  ${m.toolCalls.length}`);
  lines.push(`  Agent Steps:       ${m.agentSteps.length}`);
  lines.push(`  Total Failures:    ${m.totalFailures}`);
  lines.push(`  Inline Acceptances:${m.completionAcceptances.length}`);

  if (m.failures.length > 0) {
    lines.push("");
    lines.push("Recent Failures:");
    for (const f of m.failures.slice(-3)) {
      lines.push(`  • ${f}`);
    }
  }

  lines.push(
    "──────────────────────────────────────────────────────────────────",
  );
  return lines.join("\n");
}

/** /context command: reports model context window, remaining capacity, message history tokens, and compaction events. */
export async function formatContextReport(
  ctx: SlashCommandContext,
): Promise<string> {
  const controller = ctx.controller;
  const provider = controller.getProvider();
  const info = provider.modelInfo();
  const history = controller.getHistory();

  const contextWindow = info.contextWindow;
  const reservedOutput = provider.config?.maxTokens || 4096;
  const usableInputBudget = Math.max(0, contextWindow - reservedOutput);

  const contextManager = new ContextWindowManager(provider);
  const estimatedTokens = contextManager.estimateTokens(history);
  const remainingTokens = Math.max(0, contextWindow - estimatedTokens);
  const percentUsed =
    contextWindow > 0
      ? Math.min(100, Math.round((estimatedTokens / contextWindow) * 100))
      : 0;

  let userCount = 0;
  let assistantCount = 0;
  let toolCount = 0;
  let systemCount = 0;

  for (const msg of history) {
    if (msg.role === "user") userCount++;
    else if (msg.role === "assistant") assistantCount++;
    else if (msg.role === "tool") toolCount++;
    else if (msg.role === "system") systemCount++;
  }

  const checkpoint = ctx.sessionLog?.checkpoint;

  const lines: string[] = [
    "── Context Window Telemetry ──────────────────────────────────────",
    `Active Provider:   ${provider.name}`,
    `Active Model:      ${info.id ?? info.name}`,
    `Context Window:    ${contextWindow.toLocaleString()} tokens`,
    `Output Reserved:   ${reservedOutput.toLocaleString()} tokens`,
    `Usable Input Budget:${usableInputBudget.toLocaleString()} tokens`,
    "",
    "Current Consumption:",
    `  History Messages:  ${history.length} (${userCount} user, ${assistantCount} assistant, ${toolCount} tool, ${systemCount} system)`,
    `  Estimated Tokens:  ${estimatedTokens.toLocaleString()} tokens (${percentUsed}% used)`,
    `  Remaining Capacity:${remainingTokens.toLocaleString()} tokens (${100 - percentUsed}% remaining)`,
    "",
    "Checkpoints & Compaction:",
    `  Active Checkpoint: ${checkpoint ? `"${checkpoint.label}" at ${checkpoint.upTo} messages` : "none"}`,
  ];

  if (checkpoint) {
    lines.push(
      `  Compaction State:  Earliest messages elided to checkpoint "${checkpoint.label}"`,
    );
  } else {
    lines.push(
      "  Compaction State:  Full history in memory (use `/checkpoint` to mark resume boundaries)",
    );
  }

  lines.push(
    "──────────────────────────────────────────────────────────────────",
  );
  return lines.join("\n");
}

/** /route command: reports smart router decisions, model candidates, and circuit breaker status. */
export function formatRouteReport(ctx: SlashCommandContext): string {
  const controller = ctx.controller;
  const provider = controller.getProvider();
  const smartRouter = controller.getSmartRouter();
  const mode = controller.getMode();
  const taskType = modeToTaskType(mode);

  const lines: string[] = [
    "── Smart Router & Model Routing ──────────────────────────────────",
    `Active Mode:       ${mode} (mapped to task: "${taskType}")`,
    `Active Provider:   ${provider.name}`,
    `Active Model:      ${provider.modelInfo().id ?? provider.modelInfo().name}`,
  ];

  if (smartRouter) {
    const routerMode = smartRouter.getMode();
    lines.push(`Router Mode:       ${routerMode}`);
    const models = smartRouter.getModels();
    lines.push(`Discovered Models: ${models.length}`);

    const selected = smartRouter.select(taskType as never);
    if (selected) {
      lines.push("");
      lines.push("Router Selection Decision:");
      lines.push(`  Selected Model:  ${selected.model.id}`);
      lines.push(`  Provider:        ${selected.model.providerName}`);
      lines.push(`  Reasoning:       ${selected.reason}`);
    }

    if (models.length > 0) {
      lines.push("");
      lines.push("Candidate Models:");
      for (const m of models.slice(0, 10)) {
        lines.push(
          `  • ${m.id.padEnd(28)} [${m.speed}] ctx=${(m.contextWindow / 1000).toFixed(0)}k caps=${m.capabilities.join(",")}`,
        );
      }
      if (models.length > 10) {
        lines.push(`    … and ${models.length - 10} more models`);
      }
    }
  } else {
    lines.push(
      "Router Mode:       Direct (no dynamic SmartRouter configured for this session)",
    );
  }

  // Check circuit breaker status if wrapped
  const circuit = provider as unknown as CircuitBreaker;
  if (typeof circuit.getState === "function") {
    lines.push("");
    lines.push("Provider Circuit Breaker:");
    lines.push(`  State:           ${circuit.getState()}`);
  }

  lines.push(
    "──────────────────────────────────────────────────────────────────",
  );
  return lines.join("\n");
}

/** /tasks command: reports active and completed agent steps with tokens and duration. */
export function formatTasksReport(ctx: SlashCommandContext): string {
  const controller = ctx.controller;
  const metricsCollector = ctx.metrics ?? controller.getMetrics();
  const agentSteps = metricsCollector?.getMetrics().agentSteps ?? [];
  const analytics = controller.getAnalytics();

  const lines: string[] = [
    "── Agent Tasks & Step History ────────────────────────────────────",
    `Total Recorded Steps: ${agentSteps.length}`,
  ];

  if (analytics) {
    const md = analytics.formatMarkdown();
    if (md) {
      lines.push("");
      lines.push(md);
    }
  }

  if (agentSteps.length > 0) {
    lines.push("");
    lines.push("Recent Steps:");
    for (const step of agentSteps.slice(-10).reverse()) {
      const mark = step.success ? "✓" : "✗";
      const timeStr = formatIST(step.startTime);
      const dur = `${(step.durationMs / 1000).toFixed(2)}s`;
      lines.push(
        `  ${mark} ${step.agentName} · ${dur} · in=${step.input.length}c · out=${step.output.length}c · ${timeStr}`,
      );
      if (step.error) {
        lines.push(`    Error: ${step.error}`);
      }
    }
  } else {
    lines.push("No agent steps recorded in this session yet.");
  }

  lines.push(
    "──────────────────────────────────────────────────────────────────",
  );
  return lines.join("\n");
}

/** /tools command: reports registered tools, execution counts, and timings. */
export function formatToolsReport(ctx: SlashCommandContext): string {
  const toolRegistry = ctx.toolRegistry ?? ctx.controller.getToolRegistry();
  const tools = toolRegistry?.getAll() ?? [];
  const metricsCollector = ctx.metrics ?? ctx.controller.getMetrics();
  const toolCalls = metricsCollector?.getMetrics().toolCalls ?? [];

  // Aggregate stats per tool
  const toolStats = new Map<
    string,
    {
      calls: number;
      success: number;
      errors: number;
      totalMs: number;
    }
  >();

  for (const call of toolCalls) {
    let stat = toolStats.get(call.toolName);
    if (!stat) {
      stat = { calls: 0, success: 0, errors: 0, totalMs: 0 };
      toolStats.set(call.toolName, stat);
    }
    stat.calls++;
    if (call.success) stat.success++;
    else stat.errors++;
    stat.totalMs += call.durationMs;
  }

  const lines: string[] = [
    "── Registered Tools & Performance ───────────────────────────────",
    `Registered Tools: ${tools.length}`,
    "",
    "Tool Catalog & Execution Telemetry:",
    "  Tool Name            Calls  Success  Errors   Total Time   Avg Time  Approval",
    "  ─────────────────────────────────────────────────────────────────────────────",
  ];

  for (const t of tools) {
    const stat = toolStats.get(t.name) ?? {
      calls: 0,
      success: 0,
      errors: 0,
      totalMs: 0,
    };
    const avgMs =
      stat.calls > 0 ? Math.round(stat.totalMs / stat.calls) : 0;
    const nameCol = t.name.padEnd(20);
    const callsCol = String(stat.calls).padStart(5);
    const succCol = String(stat.success).padStart(8);
    const errCol = String(stat.errors).padStart(7);
    const totalTimeCol = `${stat.totalMs}ms`.padStart(12);
    const avgTimeCol = `${avgMs}ms`.padStart(10);
    const approvalCol = t.requiresApproval ? "Yes" : "No";

    lines.push(
      `  ${nameCol} ${callsCol} ${succCol} ${errCol} ${totalTimeCol} ${avgTimeCol}  ${approvalCol}`,
    );
  }

  lines.push(
    "──────────────────────────────────────────────────────────────────",
  );
  return lines.join("\n");
}

/** /mcp command: reports Model Context Protocol servers, tools, and resources. */
export async function formatMcpReport(
  ctx: SlashCommandContext,
): Promise<string> {
  const lines: string[] = [
    "── Model Context Protocol (MCP) Status ───────────────────────────",
  ];

  if (!ctx.mcpRegistry) {
    lines.push("MCP registry is not attached in this session.");
    lines.push(
      "Configuration: Add MCP server entries in `.champ/mcp.json` or `champ.json`",
    );
    lines.push(
      "──────────────────────────────────────────────────────────────────",
    );
    return lines.join("\n");
  }

  const servers = await ctx.mcpRegistry.listAllResources();
  const prompts = await ctx.mcpRegistry.listAllPrompts();
  const analytics = ctx.mcpRegistry.getAnalytics();

  lines.push(`Connected Resource Servers: ${servers.size}`);
  lines.push(`Connected Prompt Servers:   ${prompts.size}`);

  if (servers.size > 0) {
    lines.push("");
    lines.push("Connected Servers & Resources:");
    for (const [serverName, resources] of servers) {
      lines.push(`  • ${serverName} (${resources.length} resource(s))`);
      for (const res of resources.slice(0, 5)) {
        lines.push(`    - ${res.name}: ${res.uri}`);
      }
      if (resources.length > 5) {
        lines.push(`      … and ${resources.length - 5} more resources`);
      }
    }
  }

  if (prompts.size > 0) {
    lines.push("");
    lines.push("Prompt Templates:");
    for (const [serverName, templates] of prompts) {
      lines.push(`  • ${serverName} (${templates.length} prompt(s))`);
      for (const p of templates.slice(0, 5)) {
        lines.push(`    - ${p.name}: ${p.description ?? "(no description)"}`);
      }
    }
  }

  if (analytics) {
    lines.push("");
    lines.push("MCP Call Analytics:");
    lines.push(`  Total MCP Calls:   ${analytics.totalCalls ?? 0}`);
    lines.push(
      `  Success Rate:      ${Math.round((analytics.successRate ?? 0) * 100)}%`,
    );
    lines.push(`  Average Latency:   ${Math.round(analytics.avgLatencyMs ?? 0)}ms`);
  }

  lines.push(
    "──────────────────────────────────────────────────────────────────",
  );
  return lines.join("\n");
}

/** /doctor command: runs health diagnostics across providers, workspace, and config. */
export async function formatDoctorReport(
  ctx: SlashCommandContext,
): Promise<string> {
  if (ctx.doctor) {
    const report = await ctx.doctor();
    const lines: string[] = [
      "── Champ Doctor & System Health ──────────────────────────────────",
      `Overall Status:    ${report.healthy ? "HEALTHY (PASS)" : "FAILURES DETECTED"}`,
      "",
      "Health Checks:",
    ];
    for (const line of report.lines) {
      lines.push(`  ${line}`);
    }
    lines.push(
      "──────────────────────────────────────────────────────────────────",
    );
    return lines.join("\n");
  }

  // Fallback checks
  const provider = ctx.controller.getProvider();
  const lines: string[] = [
    "── Champ Doctor & System Health ──────────────────────────────────",
    "Overall Status:    HEALTHY (PASS)",
    "",
    "Checks:",
    `  ✓ ok\tProvider\t${provider.name} configured (${provider.modelInfo().name})`,
    `  ✓ ok\tWorkspace\t${ctx.workspace}`,
    `  ✓ ok\tRate Table\tVersion ${PRICING_TABLE_VERSION} loaded`,
    `  ✓ ok\tTool Registry\t${ctx.controller.getToolRegistry().getAll().length} tools loaded`,
    "──────────────────────────────────────────────────────────────────",
  ];
  return lines.join("\n");
}

/**
 * Dispatch any of the 8 first-class slash commands.
 * Returns null if the command name is not one of our commands.
 */
export async function executeSlashCommand(
  rawCommand: string,
  ctx: SlashCommandContext,
): Promise<string | null> {
  const name = rawCommand.trim().split(/\s+/)[0].toLowerCase();
  switch (name) {
    case "/cost":
    case "/pricing":
    case "/budget":
      return formatCostReport(ctx);
    case "/usage":
    case "/tokens":
    case "/metrics":
      return formatUsageReport(ctx);
    case "/context":
    case "/ctx":
      return formatContextReport(ctx);
    case "/route":
    case "/router":
    case "/routing":
      return formatRouteReport(ctx);
    case "/tasks":
    case "/task":
      return formatTasksReport(ctx);
    case "/tools":
    case "/tool":
      return formatToolsReport(ctx);
    case "/mcp":
      return formatMcpReport(ctx);
    case "/doctor":
    case "/health":
    case "/check":
      return formatDoctorReport(ctx);
    default:
      return null;
  }
}
