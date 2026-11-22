/**
 * Cost control regression tests.
 * Budgets use actual provider usage and versioned pricing; an unknown price
 * is never treated as free.
 */
import { describe, it, expect } from "vitest";
import {
  BudgetEnforcer,
  PRICING_TABLE_VERSION,
  quoteCost,
} from "@/config/budget";

describe("versioned pricing", () => {
  it("exposes a pricing version and quotes known models", () => {
    expect(PRICING_TABLE_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const quote = quoteCost("openai", "gpt-4o", 1_000_000, 1_000_000);
    expect(quote.known).toBe(true);
    expect(quote.usd).toBeCloseTo(20);
    expect(quote.pricingVersion).toBe(PRICING_TABLE_VERSION);
  });

  it("returns null for unknown priced providers instead of zero", () => {
    const quote = quoteCost("mystery-provider", "unknown-model", 100, 100);
    expect(quote.known).toBe(false);
    expect(quote.usd).toBeNull();
  });

  it("treats local providers as known and free", () => {
    const quote = quoteCost("ollama", "qwen2.5", 1_000_000, 1_000_000);
    expect(quote.known).toBe(true);
    expect(quote.usd).toBe(0);
  });
});

describe("BudgetEnforcer", () => {
  it("blocks a run that would exceed the token budget", () => {
    const budget = new BudgetEnforcer(
      { maxTokensPerRun: 100 },
      { now: () => Date.UTC(2026, 0, 1) },
    );
    expect(
      budget.check({
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 60,
        outputTokens: 20,
      }).allowed,
    ).toBe(true);
    budget.record({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 60,
      outputTokens: 20,
    });
    const denied = budget.check({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 30,
      outputTokens: 30,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toMatch(/budget/i);
  });

  it("enforces USD budgets from actual usage", () => {
    const budget = new BudgetEnforcer(
      { maxUsdPerRun: 0.02 },
      { now: () => Date.UTC(2026, 0, 1) },
    );
    budget.record({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(
      budget.check({
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 1,
        outputTokens: 1,
      }).allowed,
    ).toBe(false);
  });

  it("resets daily counters on a new UTC day but keeps run counters", () => {
    let now = Date.UTC(2026, 0, 1, 23, 59);
    const budget = new BudgetEnforcer(
      { maxTokensPerDay: 100, maxTokensPerRun: 1_000 },
      { now: () => now },
    );
    budget.record({
      provider: "ollama",
      model: "local",
      inputTokens: 100,
      outputTokens: 0,
    });
    expect(
      budget.check({
        provider: "ollama",
        model: "local",
        inputTokens: 1,
        outputTokens: 0,
      }).allowed,
    ).toBe(false);
    now = Date.UTC(2026, 0, 2, 0, 1);
    expect(
      budget.check({
        provider: "ollama",
        model: "local",
        inputTokens: 1,
        outputTokens: 0,
      }).allowed,
    ).toBe(true);
    expect(budget.snapshot().run.inputTokens).toBe(100);
  });

  it("fails closed on unknown prices", () => {
    const budget = new BudgetEnforcer(
      { maxUsdPerRun: 10 },
      { now: () => Date.UTC(2026, 0, 1) },
    );
    const decision = budget.check({
      provider: "unknown",
      model: "unknown",
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/pricing|unknown/i);
  });
});
