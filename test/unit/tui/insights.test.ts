import { describe, expect, it } from "vitest";
import {
  appendUsage,
  contextBudget,
  usageLine,
  usageTotals,
  type UsageRecord,
} from "@/tui/insights";

const snapshot = {
  usedTokens: 6000,
  limit: 10000,
  model: "m",
  messages: 12,
  compactions: [
    { at: "2026-01-01T00:00:00.000Z", label: "checkpoint 1", elided: 8 },
  ],
};

const record: UsageRecord = {
  at: "2026-01-01T00:00:00.000Z",
  model: "m",
  provider: "ollama",
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 20,
  cacheWriteTokens: 5,
  costUsd: 0.0012,
  latencyMs: 430,
};

describe("context and usage", () => {
  it("computes remaining tokens and a bounded bar", () => {
    const budget = contextBudget(snapshot);
    expect(budget).toMatchObject({ used: 6000, remaining: 4000, percent: 60 });
    expect(budget.bar).toHaveLength(10);
  });

  it("caps percent at 100 and preserves compaction history", () => {
    expect(contextBudget({ ...snapshot, usedTokens: 12000 }).percent).toBe(100);
    expect(snapshot.compactions[0].elided).toBe(8);
  });

  it("aggregates totals across turns", () => {
    const totals = usageTotals([record, { ...record, inputTokens: 200 }]);
    expect(totals).toMatchObject({
      inputTokens: 300,
      outputTokens: 100,
      cacheReadTokens: 40,
      turns: 2,
    });
    expect(totals.costUsd).toBeCloseTo(0.0024);
  });

  it("formats a usage line and caps the history", () => {
    expect(usageLine(record)).toContain("m/ollama");
    const recent = appendUsage([], record, 2);
    expect(
      appendUsage(recent, { ...record, at: "later" }, 2).map((item) => item.at),
    ).toEqual(["2026-01-01T00:00:00.000Z", "later"]);
  });
});
