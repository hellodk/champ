/** Context-budget and usage/cost views for the TUI. */
export interface CompactionEntry {
  at: string;
  label: string;
  elided: number;
}

export interface ContextSnapshot {
  usedTokens: number;
  limit: number;
  model: string;
  messages: number;
  compactions: CompactionEntry[];
}

export interface ContextBudget {
  used: number;
  remaining: number;
  percent: number;
  bar: string;
}

export function contextBudget(snapshot: ContextSnapshot): ContextBudget {
  const limit = Math.max(1, snapshot.limit);
  const used = Math.max(0, snapshot.usedTokens);
  const percent = Math.min(100, Math.round((used / limit) * 100));
  const filled = Math.round(percent / 10);
  return {
    used,
    remaining: Math.max(0, limit - used),
    percent,
    bar: `${"█".repeat(filled)}${"░".repeat(10 - filled)}`,
  };
}

export interface UsageRecord {
  at: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  latencyMs: number;
}

export function usageTotals(records: readonly UsageRecord[]): UsageTotals {
  return records.reduce<UsageTotals>(
    (totals, record) => ({
      turns: totals.turns + 1,
      inputTokens: totals.inputTokens + record.inputTokens,
      outputTokens: totals.outputTokens + record.outputTokens,
      cacheReadTokens: totals.cacheReadTokens + record.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens + record.cacheWriteTokens,
      costUsd: totals.costUsd + record.costUsd,
      latencyMs: totals.latencyMs + record.latencyMs,
    }),
    {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      latencyMs: 0,
    },
  );
}

export function usageLine(record: UsageRecord): string {
  return [
    `${record.model}/${record.provider}`,
    `in=${record.inputTokens}`,
    `out=${record.outputTokens}`,
    `cache=${record.cacheReadTokens}/${record.cacheWriteTokens}`,
    `$${record.costUsd.toFixed(4)}`,
    `${record.latencyMs}ms`,
  ].join(" · ");
}

export function appendUsage(
  records: readonly UsageRecord[],
  record: UsageRecord,
  max = 200,
): UsageRecord[] {
  return [...records, record].slice(-max);
}
