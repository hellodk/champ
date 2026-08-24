/**
 * TDD: DelegationManager resilience (issue #104).
 *
 * Contracts:
 * 1. Timeout timers are always cleared — no dangling timer after settle.
 * 2. Timed-out executions receive an abort signal so cooperative agents
 *    can stop (zombie executions previously ran forever).
 * 3. Per-task logs are bounded.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DelegationManager } from "../../../src/agent/delegation/delegation-manager";
import type { SubAgent } from "../../../src/agent/delegation/types";

function makeAgent(overrides: Partial<SubAgent> = {}): SubAgent {
  return {
    id: "a1",
    name: "agent-1",
    maxConcurrentTasks: 1,
    execute: async () => ({ success: true, output: "done" }),
    ...overrides,
  };
}

describe("DelegationManager resilience (#104)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("clears the timeout timer when the task succeeds", async () => {
    const mgr = new DelegationManager({ defaultTimeoutMs: 5_000 });
    mgr.registerAgent(makeAgent());

    const p = mgr.delegate({ description: "fast task", params: {} });
    await vi.advanceTimersByTimeAsync(10);
    const result = await p;

    expect(result.success).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    mgr.dispose();
  });

  it("aborts the underlying execution on timeout", async () => {
    const mgr = new DelegationManager({
      defaultTimeoutMs: 100,
      maxRetries: 0,
    });
    const signalsSeen: AbortSignal[] = [];
    mgr.registerAgent(
      makeAgent({
        execute: async (_params, signal?: AbortSignal) => {
          signalsSeen.push(signal as AbortSignal);
          // Simulate a cooperative long-running execution.
          await new Promise((resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          });
          return { success: true, output: "never" };
        },
      }),
    );

    const p = mgr.delegate({ description: "hangs", params: {} });
    await vi.advanceTimersByTimeAsync(150);
    const result = await p;

    expect(result.success).toBe(false);
    expect(signalsSeen[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    mgr.dispose();
  });

  it("bounds per-task log entries", async () => {
    const mgr = new DelegationManager({ defaultTimeoutMs: 100, maxRetries: 0 });
    const logsSpy = vi.spyOn(
      mgr as unknown as { taskLog: (t: string, l: string, m: string) => void },
      "taskLog",
    );
    mgr.registerAgent(makeAgent());

    const p = mgr.delegate({ description: "x", params: {} });
    await vi.advanceTimersByTimeAsync(200);
    await p;

    // Flood synthetic log entries and verify the cap holds.
    for (let i = 0; i < 500; i++) {
      (
        mgr as unknown as {
          taskLog: (t: string, l: string, m: string) => void;
        }
      ).taskLog("flood", "info", `entry ${i}`);
    }
    const logs = (
      mgr as unknown as {
        logs: Map<string, Array<unknown>>;
      }
    ).logs.get("flood");
    expect(logs?.length ?? 0).toBeLessThanOrEqual(200);
    void logsSpy;
    mgr.dispose();
  });
});
