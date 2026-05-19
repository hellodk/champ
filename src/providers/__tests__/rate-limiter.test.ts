import { describe, it, expect, vi } from "vitest";
import { RateLimiter, RateLimitError } from "../rate-limiter";
import { RateLimitedProvider } from "../rate-limited-provider";
import type {
  LLMProvider,
  StreamDelta,
  ModelInfo,
  LLMProviderConfig,
} from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(deltas: StreamDelta[] = []): LLMProvider {
  const config: LLMProviderConfig = {
    provider: "test",
    model: "test-model",
    maxTokens: 1024,
    temperature: 0.7,
  };
  return {
    name: "test",
    config,
    async *chat() {
      for (const d of deltas) yield d;
    },
    async *complete() {
      for (const d of deltas) yield d;
    },
    supportsToolUse: () => true,
    supportsStreaming: () => true,
    countTokens: (text: string) => Math.ceil(text.length / 4),
    modelInfo: (): ModelInfo => ({
      id: "test-model",
      name: "Test Model",
      provider: "test",
      contextWindow: 4096,
      maxOutputTokens: 1024,
      supportsToolUse: true,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: vi.fn(),
  };
}

async function collectDeltas(
  provider: LLMProvider,
  useComplete = false,
): Promise<StreamDelta[]> {
  const out: StreamDelta[] = [];
  const iter = useComplete
    ? provider.complete("test prompt")
    : provider.chat([]);
  for await (const d of iter) {
    out.push(d);
  }
  return out;
}

// ---------------------------------------------------------------------------
// RateLimiter unit tests
// ---------------------------------------------------------------------------

describe("RateLimiter", () => {
  it("allows requests when no limit is configured (unlimited)", async () => {
    const limiter = new RateLimiter();
    // Should resolve without throwing for any number of calls
    for (let i = 0; i < 100; i++) {
      await expect(limiter.acquire()).resolves.toBeUndefined();
    }
  });

  it("allows requests within the limit", async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 5 });
    for (let i = 0; i < 5; i++) {
      await expect(limiter.acquire()).resolves.toBeUndefined();
    }
  });

  it("throws RateLimitError when the limit is exceeded", async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 3 });
    for (let i = 0; i < 3; i++) {
      await limiter.acquire();
    }
    await expect(limiter.acquire()).rejects.toBeInstanceOf(RateLimitError);
  });

  it("RateLimitError message contains used/limit counts", async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 2 });
    await limiter.acquire();
    await limiter.acquire();
    await expect(limiter.acquire()).rejects.toThrow(/2\/2/);
  });

  it("RateLimitError includes a positive waitMs", async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 1 });
    await limiter.acquire();
    try {
      await limiter.acquire();
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).waitMs).toBeGreaterThan(0);
    }
  });

  it("evicts expired timestamps so window slides correctly", async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ requestsPerMinute: 2 });

    // Fill the window
    await limiter.acquire();
    await limiter.acquire();

    // Advance time past the 60s window
    vi.advanceTimersByTime(61_000);

    // Window has slid — should allow new requests
    await expect(limiter.acquire()).resolves.toBeUndefined();

    vi.useRealTimers();
  });

  it("fires onWarning when approaching the limit (default 80%)", async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 10 });
    const warnSpy = vi.fn();
    limiter.onWarning = warnSpy;

    // floor(10 * 0.8) = 8, so warning fires when newUsed >= 8
    for (let i = 0; i < 7; i++) {
      await limiter.acquire();
    }
    expect(warnSpy).not.toHaveBeenCalled();

    // 8th request crosses the threshold
    await limiter.acquire();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(8, 10);
  });

  it("fires onWarning with custom warningAt fraction", async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 10, warningAt: 0.5 });
    const warnSpy = vi.fn();
    limiter.onWarning = warnSpy;

    // floor(10 * 0.5) = 5, so warning fires when newUsed >= 5
    for (let i = 0; i < 4; i++) {
      await limiter.acquire();
    }
    expect(warnSpy).not.toHaveBeenCalled();

    await limiter.acquire();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(5, 10);
  });

  it("getStats() returns correct used/limit/resetsIn", async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ requestsPerMinute: 5 });

    let stats = limiter.getStats();
    expect(stats.used).toBe(0);
    expect(stats.limit).toBe(5);
    expect(stats.resetsIn).toBe(0);

    await limiter.acquire();
    await limiter.acquire();

    stats = limiter.getStats();
    expect(stats.used).toBe(2);
    expect(stats.limit).toBe(5);
    expect(stats.resetsIn).toBeGreaterThan(0);
    expect(stats.resetsIn).toBeLessThanOrEqual(60_000);

    vi.useRealTimers();
  });

  it("getStats() returns Infinity limit when unconfigured", () => {
    const limiter = new RateLimiter();
    const stats = limiter.getStats();
    expect(stats.limit).toBe(Infinity);
    expect(stats.used).toBe(0);
  });

  it("reset() clears all recorded timestamps", async () => {
    const limiter = new RateLimiter({ requestsPerMinute: 2 });
    await limiter.acquire();
    await limiter.acquire();
    // At limit
    await expect(limiter.acquire()).rejects.toBeInstanceOf(RateLimitError);

    limiter.reset();

    // After reset, window is clear
    await expect(limiter.acquire()).resolves.toBeUndefined();
    expect(limiter.getStats().used).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RateLimitedProvider tests
// ---------------------------------------------------------------------------

describe("RateLimitedProvider", () => {
  it("passes through chat deltas when within limit", async () => {
    const inner = makeProvider([
      { type: "text", text: "hello" },
      { type: "done", usage: { inputTokens: 5, outputTokens: 3 } },
    ]);
    const provider = new RateLimitedProvider(inner, { requestsPerMinute: 10 });
    const deltas = await collectDeltas(provider);
    expect(deltas).toHaveLength(2);
    expect(deltas[0]).toEqual({ type: "text", text: "hello" });
  });

  it("passes through complete deltas when within limit", async () => {
    const inner = makeProvider([{ type: "text", text: "completion" }]);
    const provider = new RateLimitedProvider(inner, { requestsPerMinute: 10 });
    const deltas = await collectDeltas(provider, true);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toEqual({ type: "text", text: "completion" });
  });

  it("emits error delta on rate limit exceeded for chat()", async () => {
    const inner = makeProvider([{ type: "text", text: "should not reach" }]);
    const provider = new RateLimitedProvider(inner, { requestsPerMinute: 1 });

    // Use the one allowed request
    await collectDeltas(provider);

    // Second request should yield an error delta
    const deltas = await collectDeltas(provider);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].type).toBe("error");
    expect((deltas[0] as { type: "error"; error: string }).error).toMatch(
      /Rate limit reached/,
    );
  });

  it("emits error delta on rate limit exceeded for complete()", async () => {
    const inner = makeProvider([{ type: "text", text: "completion" }]);
    const provider = new RateLimitedProvider(inner, { requestsPerMinute: 1 });

    await collectDeltas(provider, true);

    const deltas = await collectDeltas(provider, true);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].type).toBe("error");
    expect((deltas[0] as { type: "error"; error: string }).error).toMatch(
      /Rate limit reached/,
    );
  });

  it("unlimited config allows any number of requests", async () => {
    const inner = makeProvider([{ type: "text", text: "ok" }]);
    const provider = new RateLimitedProvider(inner, {});
    for (let i = 0; i < 50; i++) {
      const deltas = await collectDeltas(provider);
      expect(deltas[0]).toEqual({ type: "text", text: "ok" });
    }
  });

  it("setWarningCallback is triggered when approaching limit", async () => {
    const inner = makeProvider([{ type: "text", text: "ok" }]);
    const provider = new RateLimitedProvider(inner, {
      requestsPerMinute: 5,
      warningAt: 0.8,
    });
    const warnSpy = vi.fn();
    provider.setWarningCallback(warnSpy);

    // floor(5 * 0.8) = 4 — warning fires at 4th request
    for (let i = 0; i < 3; i++) {
      await collectDeltas(provider);
    }
    expect(warnSpy).not.toHaveBeenCalled();

    await collectDeltas(provider);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(4, 5);
  });

  it("delegates name, config, supportsToolUse, supportsStreaming, countTokens, modelInfo, dispose to inner", () => {
    const inner = makeProvider();
    const provider = new RateLimitedProvider(inner, { requestsPerMinute: 10 });

    expect(provider.name).toBe(inner.name);
    expect(provider.config).toBe(inner.config);
    expect(provider.supportsToolUse()).toBe(inner.supportsToolUse());
    expect(provider.supportsStreaming()).toBe(inner.supportsStreaming());
    expect(provider.countTokens("hello")).toBe(inner.countTokens("hello"));
    expect(provider.modelInfo()).toEqual(inner.modelInfo());

    provider.dispose();
    expect(inner.dispose).toHaveBeenCalledTimes(1);
  });

  it("getStats() reflects current usage", async () => {
    const inner = makeProvider([{ type: "text", text: "ok" }]);
    const provider = new RateLimitedProvider(inner, { requestsPerMinute: 10 });

    expect(provider.getStats().used).toBe(0);
    await collectDeltas(provider);
    expect(provider.getStats().used).toBe(1);
    await collectDeltas(provider);
    expect(provider.getStats().used).toBe(2);
  });
});
