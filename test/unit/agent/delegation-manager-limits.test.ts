/**
 * DelegationManager must apply global limits and cancellation, not just
 * per-agent capacity.
 */
import { describe, it, expect, vi } from "vitest";
import { DelegationManager } from "@/agent/delegation/delegation-manager";
import type { DelegatedTask, SubAgent } from "@/agent/delegation/types";

function agent(id: string, onExecute: () => void): SubAgent {
  return {
    id,
    name: id,
    maxConcurrentTasks: 10,
    execute: vi.fn(async () => {
      onExecute();
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { success: true, output: `${id} done` };
    }),
  };
}

function task(id: string): DelegatedTask {
  return { id, description: id, params: {} };
}

describe("DelegationManager global safety", () => {
  it("never exceeds the configured global concurrency", async () => {
    let active = 0;
    let peak = 0;
    const manager = new DelegationManager({
      maxGlobalConcurrency: 1,
      maxRetries: 0,
    });
    manager.registerAgent(
      agent("a", () => {
        active++;
        peak = Math.max(peak, active);
        setTimeout(() => active--, 30);
      }),
    );
    await Promise.all([
      manager.delegate(task("1")),
      manager.delegate(task("2")),
    ]);
    expect(peak).toBe(1);
  });

  it("rejects work when the queue is full", async () => {
    const manager = new DelegationManager({
      maxGlobalConcurrency: 1,
      maxQueuedTasks: 0,
      maxRetries: 0,
    });
    manager.registerAgent(agent("a", () => undefined));
    const first = manager.delegate(task("1"));
    const second = await manager.delegate(task("2"));
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/backpressure|queue/i);
    await first;
  });

  it("rejects a task whose ownership conflicts with a running task", async () => {
    let releaseFirst: () => void = () => undefined;
    const manager = new DelegationManager({
      maxGlobalConcurrency: 2,
      maxQueuedTasks: 4,
      maxRetries: 0,
    });
    manager.registerAgent({
      id: "a",
      name: "a",
      maxConcurrentTasks: 10,
      execute: vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return { success: true, output: "done" };
      }),
    });
    const first = manager.delegate({
      ...task("1"),
      ownership: { paths: ["/repo/src"], mode: "exclusive" },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const conflicting = await manager.delegate({
      ...task("2"),
      ownership: { paths: ["/repo/src/file.ts"], mode: "exclusive" },
    });
    expect(conflicting.success).toBe(false);
    expect(conflicting.error).toMatch(/ownership|conflict/i);
    releaseFirst();
    await first;
  });

  it("cancels a queued task through its abort signal", async () => {
    const manager = new DelegationManager({
      maxGlobalConcurrency: 1,
      maxQueuedTasks: 4,
      maxRetries: 0,
    });
    manager.registerAgent(agent("a", () => undefined));
    const controller = new AbortController();
    const first = manager.delegate(task("1"));
    const second = manager.delegate({
      ...task("2"),
      abortSignal: controller.signal,
    });
    controller.abort();
    const result = await second;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/abort|cancel/i);
    await first;
  });
});
