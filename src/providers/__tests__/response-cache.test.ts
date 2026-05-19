import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResponseCache } from "../response-cache";

describe("ResponseCache", () => {
  let cache: ResponseCache;

  beforeEach(() => {
    cache = new ResponseCache(5); // 5-minute TTL
  });

  it("returns null on cache miss", () => {
    const result = cache.get("claude", "claude-sonnet-4-6", "[]");
    expect(result).toBeNull();
  });

  it("returns cached response on hit", () => {
    const messages = JSON.stringify([{ role: "user", content: "hello" }]);
    cache.set("claude", "claude-sonnet-4-6", messages, "Hello, world!");
    const result = cache.get("claude", "claude-sonnet-4-6", messages);
    expect(result).toBe("Hello, world!");
  });

  it("differentiates by provider", () => {
    const messages = JSON.stringify([{ role: "user", content: "test" }]);
    cache.set("claude", "claude-sonnet-4-6", messages, "Claude response");
    cache.set("openai", "gpt-4o", messages, "OpenAI response");

    expect(cache.get("claude", "claude-sonnet-4-6", messages)).toBe(
      "Claude response",
    );
    expect(cache.get("openai", "gpt-4o", messages)).toBe("OpenAI response");
  });

  it("differentiates by model", () => {
    const messages = JSON.stringify([{ role: "user", content: "test" }]);
    cache.set("claude", "claude-haiku-3-5", messages, "Haiku response");
    cache.set("claude", "claude-sonnet-4-6", messages, "Sonnet response");

    expect(cache.get("claude", "claude-haiku-3-5", messages)).toBe(
      "Haiku response",
    );
    expect(cache.get("claude", "claude-sonnet-4-6", messages)).toBe(
      "Sonnet response",
    );
  });

  it("differentiates by messages content", () => {
    const msg1 = JSON.stringify([{ role: "user", content: "hello" }]);
    const msg2 = JSON.stringify([{ role: "user", content: "goodbye" }]);
    cache.set("ollama", "llama3", msg1, "Hello response");
    cache.set("ollama", "llama3", msg2, "Goodbye response");

    expect(cache.get("ollama", "llama3", msg1)).toBe("Hello response");
    expect(cache.get("ollama", "llama3", msg2)).toBe("Goodbye response");
  });

  it("evicts expired entries on read", () => {
    const cacheShortTTL = new ResponseCache(0); // 0-minute TTL (immediately expired)
    const messages = JSON.stringify([{ role: "user", content: "test" }]);
    cacheShortTTL.set("claude", "model", messages, "cached");

    // Manually expire by patching time
    vi.useFakeTimers();
    vi.advanceTimersByTime(1); // even 1ms is past 0-minute TTL
    const result = cacheShortTTL.get("claude", "model", messages);
    expect(result).toBeNull();
    vi.useRealTimers();
  });

  it("does not cache responses larger than 10KB", () => {
    const messages = JSON.stringify([{ role: "user", content: "test" }]);
    const bigResponse = "x".repeat(10_001);
    cache.set("claude", "model", messages, bigResponse);
    expect(cache.get("claude", "model", messages)).toBeNull();
  });

  it("caches responses exactly at 10KB limit (inclusive boundary)", () => {
    const messages = JSON.stringify([{ role: "user", content: "test" }]);
    const exactLimit = "x".repeat(10_000);
    cache.set("claude", "model", messages, exactLimit);
    expect(cache.get("claude", "model", messages)).toBe(exactLimit);
  });

  it("evicts oldest entry when exceeding 100 entries", () => {
    // Fill cache with 100 entries
    for (let i = 0; i < 100; i++) {
      const messages = JSON.stringify([{ role: "user", content: `msg-${i}` }]);
      cache.set("claude", "model", messages, `response-${i}`);
    }
    expect(cache.size).toBe(100);

    // Add the 101st entry — should evict the oldest
    const newMessages = JSON.stringify([{ role: "user", content: "msg-100" }]);
    cache.set("claude", "model", newMessages, "response-100");
    expect(cache.size).toBe(100);
  });

  it("clear() removes all entries", () => {
    const messages = JSON.stringify([{ role: "user", content: "test" }]);
    cache.set("claude", "model", messages, "response");
    expect(cache.size).toBe(1);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("claude", "model", messages)).toBeNull();
  });

  it("reports size correctly", () => {
    expect(cache.size).toBe(0);

    const m1 = JSON.stringify([{ role: "user", content: "msg1" }]);
    const m2 = JSON.stringify([{ role: "user", content: "msg2" }]);
    cache.set("claude", "model", m1, "r1");
    expect(cache.size).toBe(1);
    cache.set("claude", "model", m2, "r2");
    expect(cache.size).toBe(2);
  });

  it("TTL respects the configured minutes", () => {
    const cacheOnMin = new ResponseCache(1); // 1-minute TTL
    const messages = JSON.stringify([{ role: "user", content: "test" }]);

    vi.useFakeTimers();
    cacheOnMin.set("claude", "model", messages, "response");

    // Not yet expired at 59 seconds
    vi.advanceTimersByTime(59_000);
    expect(cacheOnMin.get("claude", "model", messages)).toBe("response");

    // Expired at 61 seconds
    vi.advanceTimersByTime(2_000);
    expect(cacheOnMin.get("claude", "model", messages)).toBeNull();
    vi.useRealTimers();
  });
});
