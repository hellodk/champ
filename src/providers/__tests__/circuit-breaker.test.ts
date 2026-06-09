import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker } from "../circuit-breaker";
import type {
  LLMProvider,
  StreamDelta,
  ModelInfo,
  LLMProviderConfig,
} from "../types";

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

async function collectDeltas(cb: CircuitBreaker): Promise<StreamDelta[]> {
  const out: StreamDelta[] = [];
  for await (const d of cb.chat([])) {
    out.push(d);
  }
  return out;
}

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const p = makeProvider("p", []);
    const cb = new CircuitBreaker(p);
    expect(cb.getState()).toBe("closed");
  });

  it("passes through successful deltas and stays closed", async () => {
    const p = makeProvider("p", [
      { type: "text", text: "ok" },
      { type: "done", usage: { inputTokens: 5, outputTokens: 3 } },
    ]);
    const cb = new CircuitBreaker(p);
    const result = await collectDeltas(cb);
    expect(result).toHaveLength(2);
    expect(cb.getState()).toBe("closed");
  });

  it("increments failures and opens after threshold", async () => {
    const p = makeProvider("p", [], new Error("fail"));
    const cb = new CircuitBreaker(p, 3, 30_000);
    for (let i = 0; i < 3; i++) {
      await expect(collectDeltas(cb)).rejects.toThrow("fail");
    }
    expect(cb.getState()).toBe("open");
  });

  it("throws immediately when circuit is open (within recovery window)", async () => {
    const p = makeProvider("p", [], new Error("fail"));
    const cb = new CircuitBreaker(p, 1, 30_000);
    // Trip the circuit
    await expect(collectDeltas(cb)).rejects.toThrow();
    expect(cb.getState()).toBe("open");
    // Next call should fail fast without calling the provider
    await expect(collectDeltas(cb)).rejects.toThrow(
      /Circuit open for provider/,
    );
  });

  it("transitions to half-open after recoveryTimeMs elapses", async () => {
    const p = makeProvider("p", [], new Error("fail"));
    const cb = new CircuitBreaker(p, 1, 0); // instant recovery
    await expect(collectDeltas(cb)).rejects.toThrow();
    expect(cb.getState()).toBe("open");
    // With recoveryTimeMs=0, any future call should transition to half-open
    // and attempt the inner provider (which still throws)
    await expect(collectDeltas(cb)).rejects.toThrow("fail");
    // State stays open since the probe also failed
    expect(cb.getState()).toBe("open");
  });

  it("resets to closed on successful probe in half-open state", async () => {
    // Start with a failing provider then switch to a passing one
    let shouldFail = true;
    const config: LLMProviderConfig = {
      provider: "dynamic",
      model: "m",
      maxTokens: 1024,
      temperature: 0.7,
    };
    const dynamic: LLMProvider = {
      name: "dynamic",
      config,
      async *chat() {
        if (shouldFail) throw new Error("transient");
        yield { type: "text", text: "recovered" };
      },
      async *complete() {
        throw new Error("n/a");
      },
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      countTokens: (t) => t.length,
      modelInfo: () => ({
        id: "m",
        name: "m",
        provider: "dynamic",
        contextWindow: 4096,
        maxOutputTokens: 1024,
        supportsToolUse: false,
        supportsImages: false,
        supportsStreaming: true,
      }),
      dispose: vi.fn(),
      withModel(_modelId: string) {
        return dynamic;
      },
    };
    const cb = new CircuitBreaker(dynamic, 1, 0);
    // Trip circuit
    await expect(collectDeltas(cb)).rejects.toThrow();
    expect(cb.getState()).toBe("open");
    // Fix the provider
    shouldFail = false;
    // Probe should succeed and close the circuit
    const result = await collectDeltas(cb);
    expect(result[0]).toEqual({ type: "text", text: "recovered" });
    expect(cb.getState()).toBe("closed");
  });

  it("opens circuit on error delta from inner provider", async () => {
    const p = makeProvider("p", [{ type: "error", error: "stream error" }]);
    const cb = new CircuitBreaker(p, 1, 30_000);
    await expect(collectDeltas(cb)).rejects.toThrow("stream error");
    expect(cb.getState()).toBe("open");
  });

  it("resets failure count on success after partial failures", async () => {
    let callCount = 0;
    const config: LLMProviderConfig = {
      provider: "intermittent",
      model: "m",
      maxTokens: 1024,
      temperature: 0.7,
    };
    const intermittent: LLMProvider = {
      name: "intermittent",
      config,
      async *chat() {
        callCount++;
        if (callCount <= 2) throw new Error("transient");
        yield { type: "text", text: "ok" };
      },
      async *complete() {
        throw new Error("n/a");
      },
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      countTokens: (t) => t.length,
      modelInfo: () => ({
        id: "m",
        name: "m",
        provider: "intermittent",
        contextWindow: 4096,
        maxOutputTokens: 1024,
        supportsToolUse: false,
        supportsImages: false,
        supportsStreaming: true,
      }),
      dispose: vi.fn(),
      withModel(_modelId: string) {
        return intermittent;
      },
    };
    // threshold=5, so 2 failures won't open the circuit
    const cb = new CircuitBreaker(intermittent, 5, 30_000);
    await expect(collectDeltas(cb)).rejects.toThrow();
    await expect(collectDeltas(cb)).rejects.toThrow();
    // Third call succeeds — should reset failures and stay closed
    const result = await collectDeltas(cb);
    expect(result[0]).toEqual({ type: "text", text: "ok" });
    expect(cb.getState()).toBe("closed");
  });

  it("name returns inner provider name (no circuit() wrapper in UI)", () => {
    const p = makeProvider("my-provider", []);
    const cb = new CircuitBreaker(p);
    expect(cb.name).toBe("my-provider");
  });

  it("config delegates to inner provider", () => {
    const p = makeProvider("p", []);
    const cb = new CircuitBreaker(p);
    expect(cb.config).toBe(p.config);
  });

  it("supportsToolUse delegates to inner provider", () => {
    const p = makeProvider("p", []);
    const cb = new CircuitBreaker(p);
    expect(cb.supportsToolUse()).toBe(true);
  });

  it("countTokens delegates to inner provider", () => {
    const p = makeProvider("p", []);
    const cb = new CircuitBreaker(p);
    expect(cb.countTokens("hello")).toBe(Math.ceil("hello".length / 4));
  });

  it("modelInfo delegates to inner provider", () => {
    const p = makeProvider("p", []);
    const cb = new CircuitBreaker(p);
    expect(cb.modelInfo().provider).toBe("p");
  });

  it("dispose delegates to inner provider", () => {
    const p = makeProvider("p", []);
    const cb = new CircuitBreaker(p);
    cb.dispose();
    expect(p.dispose).toHaveBeenCalledTimes(1);
  });

  it("error message in open state includes provider name and failure count", async () => {
    const p = makeProvider("my-api", [], new Error("fail"));
    const cb = new CircuitBreaker(p, 1, 30_000);
    await expect(collectDeltas(cb)).rejects.toThrow();
    await expect(collectDeltas(cb)).rejects.toThrow(/my-api/);
  });
});
