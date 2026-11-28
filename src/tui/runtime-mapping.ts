/**
 * Pure translations from headless runtime events into the structured values
 * stored by the TUI. Keeping them here makes the CLI adapter thin and testable.
 */
import type { ToolCompletionEvent } from "../cli/turn-runtime";
import type { UsageRecord } from "./insights";
import type { McpHealth, McpServerStatus } from "./mcp";
import type { ToolResultEvent } from "./tool-events";

interface HeadlessMcpStatus {
  name: string;
  connected: boolean;
  toolCount: number;
  error?: string;
}

export function mapMcpStatus(status: HeadlessMcpStatus): McpServerStatus {
  const health: McpHealth = status.connected ? "healthy" : "down";
  return {
    name: status.name,
    transport: "mcp",
    status: status.connected ? "running" : "stopped",
    health,
    tools: status.toolCount,
    ...(status.error === undefined ? {} : { error: status.error }),
  };
}

export function toolResultFromCompletion(
  completion: ToolCompletionEvent,
  start: { id?: string; startedAt?: string },
): ToolResultEvent {
  const derivedDuration = start.startedAt
    ? Date.now() - Date.parse(start.startedAt)
    : undefined;
  const durationMs = completion.durationMs ?? derivedDuration;
  const error =
    completion.error ??
    (completion.success
      ? undefined
      : completion.stderr || completion.output.split("\n")[0] || "tool failed");
  return {
    id: completion.id ?? start.id ?? completion.name ?? "tool",
    name: completion.name ?? "tool",
    output: completion.output,
    success: completion.success,
    ...(completion.stderr === undefined ? {} : { stderr: completion.stderr }),
    ...(completion.exitCode === undefined
      ? {}
      : { exitCode: completion.exitCode }),
    ...(durationMs === undefined || Number.isNaN(durationMs)
      ? {}
      : { durationMs }),
    ...(completion.approval === undefined
      ? {}
      : { approval: completion.approval }),
    ...(error === undefined ? {} : { error }),
  };
}

export function usageFromSummary(
  summary: { inputTokens: number; outputTokens: number },
  meta: {
    at: string;
    model: string;
    provider: string;
    latencyMs: number;
    costUsd: number;
  },
): UsageRecord {
  return {
    at: meta.at,
    model: meta.model,
    provider: meta.provider,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: meta.costUsd,
    latencyMs: meta.latencyMs,
  };
}
