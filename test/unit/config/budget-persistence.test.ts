/**
 * Durable budget enforcement: daily spend survives process restarts and is
 * isolated per project/agent. Unknown pricing must never be recorded as free.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BudgetEnforcer } from "@/config/budget";
import { FileBudgetLedger } from "@/config/budget-ledger";

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "champ-budget-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const usage = {
  provider: "ollama",
  model: "local",
  inputTokens: 10,
  outputTokens: 5,
};

describe("FileBudgetLedger", () => {
  it("persists day totals across instances", () => {
    const dir = tempDir();
    const file = path.join(dir, "ledger.json");
    const first = new FileBudgetLedger(file);
    first.write("2026-01-01|default", {
      inputTokens: 10,
      outputTokens: 5,
      usd: 0,
    });
    const second = new FileBudgetLedger(file);
    expect(second.read("2026-01-01|default")).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      usd: 0,
    });
  });

  it("does not grant a second process the same budget after a restart", () => {
    const dir = tempDir();
    const ledger = new FileBudgetLedger(path.join(dir, "ledger.json"));
    const opts = { now: () => Date.UTC(2026, 0, 1), ledger };
    const first = new BudgetEnforcer({ maxTokensPerDay: 12 }, opts);
    first.record(usage);
    expect(first.snapshot().day.inputTokens).toBe(10);

    // A fresh enforcer (new CLI invocation / extension host) must see the
    // already-spent daily allowance from the shared ledger.
    const restarted = new BudgetEnforcer({ maxTokensPerDay: 12 }, opts);
    expect(
      restarted.check({ ...usage, inputTokens: 5, outputTokens: 0 }).allowed,
    ).toBe(false);
    expect(restarted.snapshot().day.inputTokens).toBe(10);
  });

  it("isolates per-project and per-agent daily caps", () => {
    const dir = tempDir();
    const ledger = new FileBudgetLedger(path.join(dir, "ledger.json"));
    const opts = { now: () => Date.UTC(2026, 0, 1), ledger };
    const alpha = new BudgetEnforcer(
      { maxTokensPerDay: 12 },
      {
        ...opts,
        project: "/work/alpha",
        agent: "coder",
      },
    );
    const beta = new BudgetEnforcer(
      { maxTokensPerDay: 12 },
      {
        ...opts,
        project: "/work/beta",
        agent: "coder",
      },
    );
    alpha.record(usage);
    expect(beta.snapshot().day.inputTokens).toBe(0);
    expect(
      beta.check({ ...usage, inputTokens: 5, outputTokens: 0 }).allowed,
    ).toBe(true);
  });

  it("fails closed when recording unknown pricing under a USD budget", () => {
    const budget = new BudgetEnforcer(
      { maxUsdPerDay: 10 },
      { now: () => Date.UTC(2026, 0, 1) },
    );
    expect(() =>
      budget.record({
        provider: "mystery",
        model: "unknown",
        inputTokens: 1,
        outputTokens: 1,
      }),
    ).toThrow(/pricing|unknown/i);
    expect(budget.snapshot().day.usd).toBe(0);
  });
});
