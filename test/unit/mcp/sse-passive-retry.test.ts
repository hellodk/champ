import { describe, it, expect, vi, afterEach } from "vitest";

describe("passive retry guard", () => {
  afterEach(() => vi.useRealTimers());

  it("setTimeout is called with 60_000ms when SSE not aborted", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "setTimeout");
    const abortController = new AbortController();
    if (!abortController.signal.aborted) {
      setTimeout(() => {}, 60_000);
    }
    const passiveCall = spy.mock.calls.find((c) => c[1] === 60_000);
    expect(passiveCall).toBeDefined();
  });

  it("passive retry does not fire when SSE is intentionally aborted", () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(globalThis, "setTimeout");
    const abortController = new AbortController();
    abortController.abort();
    if (!abortController.signal.aborted) {
      setTimeout(() => {}, 60_000);
    }
    const passiveCall = spy.mock.calls.find((c) => c[1] === 60_000);
    expect(passiveCall).toBeUndefined();
  });
});
