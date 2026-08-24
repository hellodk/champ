/**
 * TDD: rescan must not hang on unreachable providers (#104 follow-up).
 *
 * Contract: discoverFromProvider's AbortController cancels provider
 * listModels() calls. Previously the signal was never passed through, so a
 * resilientFetch-wrapped listModels on an unreachable server retried with a
 * 120s per-attempt timeout — discover() stalled for minutes and the model
 * picker never refreshed.
 */
import { describe, it, expect, vi } from "vitest";
import { SmartRouter } from "@/providers/smart-router";

function hangingListModelsProvider(name: string) {
  return {
    name,
    config: { provider: name, model: "m", maxTokens: 100, temperature: 0 },
    async *chat() {},
    complete: async () => "",
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    countTokens: () => 1,
    modelInfo: () => ({
      id: "m",
      name: "m",
      provider: name,
      contextWindow: 8192,
      maxOutputTokens: 100,
      supportsToolUse: false,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: () => {},
    // Hangs until aborted — mimics resilientFetch against a black-holed host.
    listModels: (signal?: AbortSignal) =>
      new Promise<Array<{ id: string; name: string }>>((_resolve, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        );
      }),
  };
}

describe("SmartRouter.discover cancellation", () => {
  it("aborts a hung listModels within the discovery timeout", async () => {
    vi.useFakeTimers();
    const router = new SmartRouter();
    const provider = hangingListModelsProvider("dead-host");
    const spy = vi.spyOn(provider, "listModels");
    router.registerProvider(
      "dead-host",
      provider as never,
      "ollama",
      "http://10.255.255.1:1",
    );

    const p = router.discover();
    // Advance past DISCOVERY_TIMEOUT_MS (5s) — must settle, not hang.
    await vi.advanceTimersByTimeAsync(5_100);
    await p;

    expect(spy).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(spy.mock.calls[0][0].aborted).toBe(true);
    vi.useRealTimers();
  });
});
