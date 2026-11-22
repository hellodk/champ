/**
 * Budgets and versioned pricing.
 *
 * All costs are computed from actual provider usage (never from token
 * estimates) and a versioned rate table. Providers without a published rate
 * are NOT free: their quote is unknown and budgets fail closed.
 */
export const PRICING_TABLE_VERSION = "2026-11-01";

export interface PriceQuote {
  usd: number | null;
  known: boolean;
  pricingVersion: string;
  source: "local" | "table" | "unknown";
}

type Rates = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

const TABLE: Record<string, Array<{ pattern: RegExp; rates: Rates }>> = {
  anthropic: [
    { pattern: /haiku/i, rates: { input: 0.25, output: 1.25 } },
    { pattern: /opus/i, rates: { input: 15, output: 75 } },
    { pattern: /.*/, rates: { input: 3, output: 15 } },
  ],
  openai: [
    { pattern: /4o-mini|gpt-4\.1-mini/i, rates: { input: 0.15, output: 0.6 } },
    { pattern: /o[134]/i, rates: { input: 15, output: 60 } },
    { pattern: /.*/, rates: { input: 5, output: 15 } },
  ],
  gemini: [
    { pattern: /flash/i, rates: { input: 0.075, output: 0.3 } },
    { pattern: /.*/, rates: { input: 1.25, output: 5 } },
  ],
};

const LOCAL_PROVIDERS = new Set([
  "ollama",
  "llamacpp",
  "llama.cpp",
  "vllm",
  "openai-compatible",
  "custom",
  "local",
]);

export interface UsageRecord {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function quoteCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0,
): PriceQuote {
  const key = provider.toLowerCase();
  if (key === "claude")
    return quoteFromTable(
      "anthropic",
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    );
  const table = TABLE[key];
  if (table)
    return quoteFromTable(
      key,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    );
  if (LOCAL_PROVIDERS.has(key)) {
    return {
      usd: 0,
      known: true,
      pricingVersion: PRICING_TABLE_VERSION,
      source: "local",
    };
  }
  return {
    usd: null,
    known: false,
    pricingVersion: PRICING_TABLE_VERSION,
    source: "unknown",
  };
}

function quoteFromTable(
  provider: string,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): PriceQuote {
  const entry = TABLE[provider]?.find((candidate) =>
    candidate.pattern.test(model),
  );
  const rates = entry?.rates;
  if (!rates) {
    return {
      usd: null,
      known: false,
      pricingVersion: PRICING_TABLE_VERSION,
      source: "unknown",
    };
  }
  const usd =
    (input / 1_000_000) * rates.input +
    (output / 1_000_000) * rates.output +
    (cacheRead / 1_000_000) * (rates.cacheRead ?? rates.input) +
    (cacheWrite / 1_000_000) * (rates.cacheWrite ?? rates.input);
  return {
    usd,
    known: true,
    pricingVersion: PRICING_TABLE_VERSION,
    source: "table",
  };
}

export interface BudgetLimits {
  maxTokensPerRun?: number;
  maxInputTokensPerRun?: number;
  maxOutputTokensPerRun?: number;
  maxUsdPerRun?: number;
  maxTokensPerDay?: number;
  maxUsdPerDay?: number;
}

export interface BudgetDecision {
  allowed: boolean;
  reason?: string;
}

interface Totals {
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

function emptyTotals(): Totals {
  return { inputTokens: 0, outputTokens: 0, usd: 0 };
}

export interface BudgetSnapshot {
  run: Totals;
  day: Totals;
  dayKey: string;
  pricingVersion: string;
}

export class BudgetEnforcer {
  private run = emptyTotals();
  private day = emptyTotals();
  private dayKey: string;

  constructor(
    private readonly limits: BudgetLimits,
    private readonly opts: { now?: () => number } = {},
  ) {
    this.dayKey = this.todayKey();
  }

  private todayKey(): string {
    const now = this.opts.now?.() ?? Date.now();
    return new Date(now).toISOString().slice(0, 10);
  }

  private rollDay(): void {
    const key = this.todayKey();
    if (key === this.dayKey) return;
    this.dayKey = key;
    this.day = emptyTotals();
  }

  private price(usage: UsageRecord): PriceQuote {
    return quoteCost(
      usage.provider,
      usage.model,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWriteTokens,
    );
  }

  /**
   * Whether the next call may start, based only on usage already recorded.
   * No future output is predicted: a model's maxTokens is a ceiling, not an
   * expectation, so treating it as spend would block legitimate work.
   */
  checkCurrent(): BudgetDecision {
    this.rollDay();
    const runTokens = this.run.inputTokens + this.run.outputTokens;
    const dayTokens = this.day.inputTokens + this.day.outputTokens;
    if (
      this.limits.maxInputTokensPerRun !== undefined &&
      this.run.inputTokens > this.limits.maxInputTokensPerRun
    ) {
      return { allowed: false, reason: "per-run input token budget exhausted" };
    }
    if (
      this.limits.maxOutputTokensPerRun !== undefined &&
      this.run.outputTokens > this.limits.maxOutputTokensPerRun
    ) {
      return {
        allowed: false,
        reason: "per-run output token budget exhausted",
      };
    }
    if (
      this.limits.maxTokensPerRun !== undefined &&
      runTokens >= this.limits.maxTokensPerRun
    ) {
      return { allowed: false, reason: "per-run token budget exhausted" };
    }
    if (
      this.limits.maxTokensPerDay !== undefined &&
      dayTokens >= this.limits.maxTokensPerDay
    ) {
      return { allowed: false, reason: "daily token budget exhausted" };
    }
    if (
      this.limits.maxUsdPerRun !== undefined &&
      this.run.usd >= this.limits.maxUsdPerRun
    ) {
      return { allowed: false, reason: "per-run USD budget exhausted" };
    }
    if (
      this.limits.maxUsdPerDay !== undefined &&
      this.day.usd >= this.limits.maxUsdPerDay
    ) {
      return { allowed: false, reason: "daily USD budget exhausted" };
    }
    return { allowed: true };
  }

  check(usage: UsageRecord): BudgetDecision {
    this.rollDay();
    const quote = this.price(usage);
    if (!quote.known || quote.usd === null) {
      return {
        allowed: false,
        reason: `no pricing entry for ${usage.provider}/${usage.model} (${PRICING_TABLE_VERSION})`,
      };
    }
    const runTokens =
      this.run.inputTokens +
      this.run.outputTokens +
      usage.inputTokens +
      usage.outputTokens;
    const dayTokens =
      this.day.inputTokens +
      this.day.outputTokens +
      usage.inputTokens +
      usage.outputTokens;
    const runUsd = this.run.usd + quote.usd;
    const dayUsd = this.day.usd + quote.usd;

    if (
      this.limits.maxInputTokensPerRun !== undefined &&
      this.run.inputTokens + usage.inputTokens >
        this.limits.maxInputTokensPerRun
    ) {
      return { allowed: false, reason: "per-run input token budget exceeded" };
    }
    if (
      this.limits.maxOutputTokensPerRun !== undefined &&
      this.run.outputTokens + usage.outputTokens >
        this.limits.maxOutputTokensPerRun
    ) {
      return { allowed: false, reason: "per-run output token budget exceeded" };
    }
    if (
      this.limits.maxTokensPerRun !== undefined &&
      runTokens > this.limits.maxTokensPerRun
    ) {
      return { allowed: false, reason: "per-run token budget exceeded" };
    }
    if (
      this.limits.maxTokensPerDay !== undefined &&
      dayTokens > this.limits.maxTokensPerDay
    ) {
      return { allowed: false, reason: "daily token budget exceeded" };
    }
    if (
      this.limits.maxUsdPerRun !== undefined &&
      runUsd > this.limits.maxUsdPerRun
    ) {
      return { allowed: false, reason: "per-run USD budget exceeded" };
    }
    if (
      this.limits.maxUsdPerDay !== undefined &&
      dayUsd > this.limits.maxUsdPerDay
    ) {
      return { allowed: false, reason: "daily USD budget exceeded" };
    }
    return { allowed: true };
  }

  /** Record usage actually reported by the provider after a completed call. */
  record(usage: UsageRecord): void {
    this.rollDay();
    const quote = this.price(usage);
    const usd = quote.usd ?? 0;
    this.run.inputTokens += usage.inputTokens;
    this.run.outputTokens += usage.outputTokens;
    this.run.usd += usd;
    this.day.inputTokens += usage.inputTokens;
    this.day.outputTokens += usage.outputTokens;
    this.day.usd += usd;
  }

  snapshot(): BudgetSnapshot {
    this.rollDay();
    return {
      run: { ...this.run },
      day: { ...this.day },
      dayKey: this.dayKey,
      pricingVersion: PRICING_TABLE_VERSION,
    };
  }
}
