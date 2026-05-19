/**
 * McpAnalytics: lightweight in-memory analytics for MCP tool calls.
 *
 * Tracks per-tool call counts, success rates, and latency so that
 * the McpMarketplacePanel can display health indicators without
 * introducing any external dependencies.
 */

export interface ToolCallRecord {
  serverName: string;
  toolName: string;
  latencyMs: number;
  success: boolean;
  timestamp: number;
}

export class McpAnalytics {
  private records: ToolCallRecord[] = [];
  private readonly maxRecords = 1000;

  record(entry: ToolCallRecord): void {
    this.records.push(entry);
    if (this.records.length > this.maxRecords) this.records.shift();
  }

  getStats(serverName?: string): {
    totalCalls: number;
    successRate: number;
    avgLatencyMs: number;
    byTool: Record<
      string,
      { calls: number; successRate: number; avgLatencyMs: number }
    >;
  } {
    const filtered = serverName
      ? this.records.filter((r) => r.serverName === serverName)
      : this.records;
    if (filtered.length === 0) {
      return { totalCalls: 0, successRate: 1, avgLatencyMs: 0, byTool: {} };
    }

    const byTool: Record<
      string,
      { calls: number; successes: number; totalLatency: number }
    > = {};
    for (const r of filtered) {
      const key = `${r.serverName}:${r.toolName}`;
      byTool[key] ??= { calls: 0, successes: 0, totalLatency: 0 };
      byTool[key].calls++;
      if (r.success) byTool[key].successes++;
      byTool[key].totalLatency += r.latencyMs;
    }

    const successes = filtered.filter((r) => r.success).length;
    return {
      totalCalls: filtered.length,
      successRate: successes / filtered.length,
      avgLatencyMs:
        filtered.reduce((sum, r) => sum + r.latencyMs, 0) / filtered.length,
      byTool: Object.fromEntries(
        Object.entries(byTool).map(([k, v]) => [
          k,
          {
            calls: v.calls,
            successRate: v.successes / v.calls,
            avgLatencyMs: v.totalLatency / v.calls,
          },
        ]),
      ),
    };
  }

  clear(): void {
    this.records = [];
  }
}
