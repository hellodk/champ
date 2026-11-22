/**
 * Multi-agent safety regression tests: global/provider limits, backpressure,
 * cancellation, ownership contracts and detached worktree isolation.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ConcurrencyLimiter,
  OwnershipRegistry,
  WorktreeManager,
} from "@/agent/delegation/safety";

describe("ConcurrencyLimiter", () => {
  it("enforces a global limit", async () => {
    const limiter = new ConcurrencyLimiter({ maxGlobal: 1 });
    const first = await limiter.acquire("a");
    let started = false;
    const queued = limiter.acquire("b").then((release) => {
      started = true;
      release();
    });
    await Promise.resolve();
    expect(started).toBe(false);
    first();
    await queued;
    expect(started).toBe(true);
  });

  it("enforces a per-provider limit independently of the global limit", async () => {
    const limiter = new ConcurrencyLimiter({ maxGlobal: 4, maxPerProvider: 1 });
    const releaseA = await limiter.acquire("openai");
    const second = limiter.acquire("openai");
    const releaseB = await limiter.acquire("anthropic");
    let secondStarted = false;
    void second.then(() => {
      secondStarted = true;
    });
    await Promise.resolve();
    expect(secondStarted).toBe(false);
    releaseA();
    await second;
    releaseB();
  });

  it("applies backpressure when the queue is full", async () => {
    const limiter = new ConcurrencyLimiter({ maxGlobal: 1, maxQueued: 1 });
    const release = await limiter.acquire("a");
    const queued = limiter.acquire("b").then((r) => r());
    await expect(limiter.acquire("c")).rejects.toThrow(/backpressure|queue/i);
    release();
    await queued;
  });

  it("rejects queued requests on cancellation", async () => {
    const limiter = new ConcurrencyLimiter({ maxGlobal: 1 });
    const release = await limiter.acquire("a");
    const controller = new AbortController();
    const queued = limiter.acquire("b", controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow(/abort/i);
    release();
  });
});

describe("OwnershipRegistry", () => {
  it("rejects overlapping exclusive claims and allows disjoint ones", () => {
    const registry = new OwnershipRegistry();
    registry.claim("agent-a", ["/repo/src"], "exclusive");
    expect(() =>
      registry.claim("agent-b", ["/repo/src/file.ts"], "exclusive"),
    ).toThrow(/ownership|conflict/i);
    expect(() =>
      registry.claim("agent-b", ["/repo/docs"], "exclusive"),
    ).not.toThrow();
    registry.release("agent-a");
    expect(() =>
      registry.claim("agent-b", ["/repo/src/file.ts"], "exclusive"),
    ).not.toThrow();
  });

  it("allows shared claims on the same path", () => {
    const registry = new OwnershipRegistry();
    registry.claim("a", ["/repo/README.md"], "shared");
    expect(() =>
      registry.claim("b", ["/repo/README.md"], "shared"),
    ).not.toThrow();
  });
});

describe("WorktreeManager", () => {
  it("creates detached worktrees and cleans them up without merging", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const runner = vi.fn(async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return "";
    });
    const manager = new WorktreeManager({
      run: runner as never,
      baseDir: "/tmp/champ-wt-test",
    });
    const worktree = await manager.create("/repo", "task-1");
    expect(worktree.path).toMatch(/\/tmp\/champ-wt-test/);
    expect(calls[0].args).toContain("--detach");
    const diffCalls = calls.length;
    await worktree.cleanup();
    expect(calls.slice(diffCalls).some((c) => c.args.includes("remove"))).toBe(
      true,
    );
    // No automatic merge is ever issued.
    expect(calls.some((c) => c.args.includes("merge"))).toBe(false);
  });

  it("rejects task ids that could escape the worktree root", async () => {
    const manager = new WorktreeManager({
      run: vi.fn(async () => "") as never,
      baseDir: "/tmp/champ-wt-test",
    });
    await expect(manager.create("/repo", "../escape")).rejects.toThrow(/id/i);
  });
});
