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
  /** Null when pricing for this provider/model is unknown (fail closed). */
  costUsd: number | null;
  costKnown?: boolean;
  costSource?: "local" | "table" | "unknown";
  latencyMs: number;
}

export interface UsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  costKnown: boolean;
  latencyMs: number;
}

export function usageTotals(records: readonly UsageRecord[]): UsageTotals {
  return records.reduce<UsageTotals>(
    (totals, record) => {
      const known = record.costUsd !== null && record.costKnown !== false;
      return {
        turns: totals.turns + 1,
        inputTokens: totals.inputTokens + record.inputTokens,
        outputTokens: totals.outputTokens + record.outputTokens,
        cacheReadTokens: totals.cacheReadTokens + record.cacheReadTokens,
        cacheWriteTokens: totals.cacheWriteTokens + record.cacheWriteTokens,
        costUsd:
          totals.costUsd +
          (known && record.costUsd !== null ? record.costUsd : 0),
        costKnown: totals.costKnown && known,
        latencyMs: totals.latencyMs + record.latencyMs,
      };
    },
    {
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      costKnown: true,
      latencyMs: 0,
    },
  );
}

export function formatIstTimestamp(value: string | number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })} IST`;
}

export function usageLine(record: UsageRecord): string {
  const costLabel =
    record.costUsd === null || record.costKnown === false
      ? "cost=unknown"
      : record.costSource === "local"
        ? "local"
        : `$${record.costUsd.toFixed(4)}`;
  return [
    `${record.model}/${record.provider}`,
    `in=${record.inputTokens}`,
    `out=${record.outputTokens}`,
    `cache=${record.cacheReadTokens}/${record.cacheWriteTokens}`,
    costLabel,
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
