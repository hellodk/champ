import { randomUUID } from "crypto";
import type {
  AgentRunReport,
  AgentTaskRecord,
  ToolCallRecord,
} from "../agent-manager/types";

export class AgentAnalytics {
  private readonly runId = randomUUID();
  private readonly startTime = Date.now();
  private readonly tasks: AgentTaskRecord[] = [];
  private activeTasks = new Map<
    string,
    {
      startTime: number;
      inputTokens: number;
      outputTokens: number;
      toolCalls: ToolCallRecord[];
    }
  >();

  startTask(agentName: string): void {
    this.activeTasks.set(agentName, {
      startTime: Date.now(),
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: [],
    });
  }

  recordTokens(
    agentName: string,
    inputTokens: number,
    outputTokens: number,
  ): void {
    const t = this.activeTasks.get(agentName);
    if (t) {
      t.inputTokens += inputTokens;
      t.outputTokens += outputTokens;
    }
  }

  recordToolCall(agentName: string, record: ToolCallRecord): void {
    this.activeTasks.get(agentName)?.toolCalls.push(record);
  }

  endTask(agentName: string, success: boolean, error?: string): void {
    const t = this.activeTasks.get(agentName);
    if (!t) return;
    const endTime = Date.now();
    this.tasks.push({
      agentName,
      startTime: t.startTime,
      endTime,
      durationMs: endTime - t.startTime,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      toolCalls: t.toolCalls,
      success,
      error,
    });
    this.activeTasks.delete(agentName);
  }

  toReport(): AgentRunReport {
    const now = Date.now();
    return {
      runId: this.runId,
      startTime: this.startTime,
      totalDurationMs: now - this.startTime,
      totalInputTokens: this.tasks.reduce((s, a) => s + a.inputTokens, 0),
      totalOutputTokens: this.tasks.reduce((s, a) => s + a.outputTokens, 0),
      success: this.tasks.every((a) => a.success),
      agents: [...this.tasks],
    };
  }

  formatMarkdown(): string {
    const report = this.toReport();
    const lines: string[] = [
      `**Analytics** — run \`${report.runId.slice(0, 8)}\` · ${(report.totalDurationMs / 1000).toFixed(1)}s · in=${report.totalInputTokens} out=${report.totalOutputTokens} · ${report.success ? "✓" : "✗"}`,
      "",
    ];
    for (const a of report.agents) {
      lines.push(
        `- ${a.success ? "✓" : "✗"} **${a.agentName}** ${(a.durationMs / 1000).toFixed(1)}s  in=${a.inputTokens} out=${a.outputTokens} tools=${a.toolCalls.length}${a.error ? `  ⚠ ${a.error}` : ""}`,
      );
    }
    return lines.join("\n");
  }
}
