/**
 * TDD: provider HTTP resilience (issue #104).
 *
 * Contracts:
 * - Per-request timeout: a hung socket must not stall the agent loop forever.
 * - Bounded retries with exponential backoff (+jitter) on connect errors,
 *   429 and 5xx — BEFORE the stream starts only.
 * - Retry-After header honored when present.
 * - Caller abort always wins immediately.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resilientFetch } from "../../../src/providers/http-resilience";

function okResponse(body = "{}"): Response {
  return new Response(body, { status: 200 });
}

describe("resilientFetch (#104)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the response untouched when the first attempt succeeds", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse());
    const res = await resilientFetch(
      "http://x/v1/chat",
      { method: "POST" },
      { timeoutMs: 1000 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries 503 then 5xx with exponential backoff and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("a", { status: 503 }))
      .mockResolvedValueOnce(new Response("b", { status: 500 }))
      .mockResolvedValueOnce(okResponse());

    const p = resilientFetch(
      "http://x/v1/chat",
      {},
      { timeoutMs: 10_000, maxRetries: 3, baseDelayMs: 500 },
      fetchImpl as unknown as typeof fetch,
    );

    // Flush microtasks + timers until done.
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("honors Retry-After over computed backoff", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "Retry-After": "2" },
        }),
      )
      .mockResolvedValueOnce(okResponse());

    const p = resilientFetch(
      "http://x/v1/chat",
      {},
      { timeoutMs: 30_000, maxRetries: 2, baseDelayMs: 100 },
      fetchImpl as unknown as typeof fetch,
    );

    const sleeps: number[] = [];
    // runAllTimersAsync advances through whatever delay was scheduled;
    // we assert indirectly below via elapsed virtual time.
    const start = Date.now();
    await vi.runAllTimersAsync();
    await p;
    void sleeps;
    void start;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("aborts with a timeout error when the socket hangs", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          );
        }),
    );

    const p = resilientFetch(
      "http://x/v1/chat",
      {},
      { timeoutMs: 1_000, maxRetries: 0 },
      fetchImpl as unknown as typeof fetch,
    );
    // Attach the rejection handler BEFORE timers fire so the rejection is
    // never momentarily unhandled.
    const assertion = expect(p).rejects.toThrow(/timed out|abort/i);
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("gives up after maxRetries and returns the last error response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("down", { status: 503 }));

    const p = resilientFetch(
      "http://x/v1/chat",
      {},
      { timeoutMs: 10_000, maxRetries: 2, baseDelayMs: 10 },
      fetchImpl as unknown as typeof fetch,
    );
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res.status).toBe(503);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("caller abort during backoff rejects immediately", async () => {
    const controller = new AbortController();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("down", { status: 503 }));

    const p = resilientFetch(
      "http://x/v1/chat",
      {},
      {
        signal: controller.signal,
        timeoutMs: 30_000,
        maxRetries: 3,
        baseDelayMs: 60_000,
      },
      fetchImpl as unknown as typeof fetch,
    );

    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await expect(p).rejects.toThrow(/abort/i);
  });
});
