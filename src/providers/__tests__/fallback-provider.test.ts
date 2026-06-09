import { describe, it, expect, vi } from "vitest";
import { FallbackProvider } from "../fallback-provider";
import type {
  LLMProvider,
  LLMMessage,
  StreamDelta,
  ModelInfo,
  LLMProviderConfig,
} from "../types";

// Minimal stub provider factory
function makeProvider(
  name: string,
  deltas: StreamDelta[],
  shouldThrow?: Error,
): LLMProvider {
  const config: LLMProviderConfig = {
    provider: name,
    model: "test-model",
    maxTokens: 1024,
    temperature: 0.7,
  };
  return {
    name,
    config,
    async *chat() {
      if (shouldThrow) throw shouldThrow;
      for (const d of deltas) yield d;
    },
    async *complete() {
      if (shouldThrow) throw shouldThrow;
      for (const d of deltas) yield d;
    },
    supportsToolUse: () => true,
    supportsStreaming: () => true,
    countTokens: (text: string) => Math.ceil(text.length / 4),
    modelInfo: (): ModelInfo => ({
      id: `${name}-model`,
      name: `${name} model`,
      provider: name,
      contextWindow: 4096,
      maxOutputTokens: 1024,
      supportsToolUse: true,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: vi.fn(),
    withModel(_modelId: string) {
      return makeProvider(name, deltas, shouldThrow);
    },
  };
}

async function collectDeltas(
  provider: FallbackProvider,
  messages: LLMMessage[] = [],
): Promise<StreamDelta[]> {
  const out: StreamDelta[] = [];
  for await (const d of provider.chat(messages)) {
    out.push(d);
  }
  return out;
}

describe("FallbackProvider", () => {
  it("throws when constructed with zero providers", () => {
    expect(() => new FallbackProvider([])).toThrow(
      "FallbackProvider requires at least one provider",
    );
  });

  it("uses the primary provider when it succeeds", async () => {
    const primary = makeProvider("primary", [
      { type: "text", text: "hello" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    const fallback = makeProvider("fallback", [
      { type: "text", text: "fallback response" },
    ]);
    const fp = new FallbackProvider([primary, fallback]);
    const result = await collectDeltas(fp);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "hello" });
  });

  it("falls back to second provider when primary throws", async () => {
    const primary = makeProvider("primary", [], new Error("network error"));
    const fallback = makeProvider("fallback", [
      { type: "text", text: "from fallback" },
    ]);
    const fp = new FallbackProvider([primary, fallback]);
    const result = await collectDeltas(fp);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "text", text: "from fallback" });
  });

  it("falls back to second provider on error delta from primary", async () => {
    const primary = makeProvider("primary", [
      { type: "error", error: "upstream error" },
    ]);
    const fallback = makeProvider("fallback", [
      { type: "text", text: "recovered" },
    ]);
    const fp = new FallbackProvider([primary, fallback]);
    const result = await collectDeltas(fp);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "text", text: "recovered" });
  });

  it("throws when all providers fail", async () => {
    const p1 = makeProvider("p1", [], new Error("error 1"));
    const p2 = makeProvider("p2", [], new Error("error 2"));
    const fp = new FallbackProvider([p1, p2]);
    await expect(collectDeltas(fp)).rejects.toThrow("error 2");
  });

  it("throws with correct error when all providers emit error deltas", async () => {
    const p1 = makeProvider("p1", [{ type: "error", error: "err1" }]);
    const p2 = makeProvider("p2", [{ type: "error", error: "err2" }]);
    const fp = new FallbackProvider([p1, p2]);
    await expect(collectDeltas(fp)).rejects.toThrow("err2");
  });

  it("exposes a name listing all providers", () => {
    const p1 = makeProvider("alpha", []);
    const p2 = makeProvider("beta", []);
    const fp = new FallbackProvider([p1, p2]);
    expect(fp.name).toBe("fallback(alpha,beta)");
  });

  it("exposes config from the first provider", () => {
    const p1 = makeProvider("primary", []);
    const fp = new FallbackProvider([p1]);
    expect(fp.config.provider).toBe("primary");
  });

  it("supportsToolUse delegates to first provider", () => {
    const p1 = makeProvider("p1", []);
    const fp = new FallbackProvider([p1]);
    expect(fp.supportsToolUse()).toBe(true);
  });

  it("supportsStreaming is true only if all providers support streaming", () => {
    const p1 = makeProvider("p1", []);
    const p2: LLMProvider = {
      ...makeProvider("p2", []),
      supportsStreaming: () => false,
    };
    const fp = new FallbackProvider([p1, p2]);
    expect(fp.supportsStreaming()).toBe(false);
  });

  it("countTokens delegates to first provider", () => {
    const p1 = makeProvider("p1", []);
    const fp = new FallbackProvider([p1]);
    // makeProvider uses ceil(length/4)
    expect(fp.countTokens("hello")).toBe(Math.ceil("hello".length / 4));
  });

  it("modelInfo delegates to first provider", () => {
    const p1 = makeProvider("primary", []);
    const fp = new FallbackProvider([p1]);
    expect(fp.modelInfo().provider).toBe("primary");
  });

  it("dispose calls dispose on all providers", () => {
    const p1 = makeProvider("p1", []);
    const p2 = makeProvider("p2", []);
    const fp = new FallbackProvider([p1, p2]);
    fp.dispose();
    expect(p1.dispose).toHaveBeenCalledTimes(1);
    expect(p2.dispose).toHaveBeenCalledTimes(1);
  });

  it("retries the same provider up to maxRetries before moving on", async () => {
    let callCount = 0;
    const config: LLMProviderConfig = {
      provider: "flaky",
      model: "m",
      maxTokens: 1024,
      temperature: 0.7,
    };
    const flaky: LLMProvider = {
      name: "flaky",
      config,
      async *chat() {
        callCount++;
        throw new Error("transient");
      },
      async *complete() {
        throw new Error("transient");
      },
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      countTokens: (t) => t.length,
      modelInfo: () => ({
        id: "m",
        name: "m",
        provider: "flaky",
        contextWindow: 4096,
        maxOutputTokens: 1024,
        supportsToolUse: false,
        supportsImages: false,
        supportsStreaming: true,
      }),
      dispose: vi.fn(),
      withModel(_modelId: string) {
        return flaky;
      },
    };
    const fallback = makeProvider("fallback", [{ type: "text", text: "ok" }]);
    const fp = new FallbackProvider([flaky, fallback], 3);
    const result = await collectDeltas(fp);
    // flaky should be called 3 times (maxRetries=3) before moving on
    expect(callCount).toBe(3);
    expect(result[0]).toEqual({ type: "text", text: "ok" });
  });

  it("works with a single provider that succeeds", async () => {
    const p1 = makeProvider("solo", [
      { type: "text", text: "solo answer" },
      { type: "done", usage: { inputTokens: 5, outputTokens: 3 } },
    ]);
    const fp = new FallbackProvider([p1]);
    const result = await collectDeltas(fp);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "solo answer" });
  });

  it("chains through three providers finding the third successful", async () => {
    const p1 = makeProvider("p1", [], new Error("fail1"));
    const p2 = makeProvider("p2", [{ type: "error", error: "fail2" }]);
    const p3 = makeProvider("p3", [{ type: "text", text: "third wins" }]);
    const fp = new FallbackProvider([p1, p2, p3]);
    const result = await collectDeltas(fp);
    expect(result[0]).toEqual({ type: "text", text: "third wins" });
  });
});
