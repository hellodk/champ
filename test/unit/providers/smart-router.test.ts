/**
 * TDD: Tests for SmartRouter — auto-discover + task-based model selection.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SmartRouter,
  type DiscoveredModel,
  type TaskType,
} from "@/providers/smart-router";

function mockModel(overrides: Partial<DiscoveredModel> = {}): DiscoveredModel {
  return {
    id: "test-model",
    providerName: "ollama",
    providerType: "ollama",
    capabilities: ["general"],
    speed: "fast",
    contextWindow: 8192,
    sizeHint: "7B",
    ...overrides,
  };
}

function stubProvider(name = "test") {
  return {
    name,
    config: { provider: name, model: "m", maxTokens: 100, temperature: 0 },
    async *chat() {
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    async *complete() {
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    countTokens: () => 0,
    modelInfo: () => ({
      id: "m",
      name: "m",
      provider: name,
      contextWindow: 8192,
      maxOutputTokens: 1024,
      supportsToolUse: false,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: () => {},
  };
}

describe("SmartRouter", () => {
  let router: SmartRouter;

  beforeEach(() => {
    router = new SmartRouter();
  });

  it("returns null when no models are discovered", () => {
    expect(router.select("coding")).toBeNull();
  });

  it("prefers coding models for coding tasks", () => {
    // Manually push models to bypass discovery (which needs network).
    (router as unknown as { models: DiscoveredModel[] }).models = [
      mockModel({
        id: "llama3.1:8b",
        capabilities: ["general"],
        speed: "fast",
        sizeHint: "8B",
      }),
      mockModel({
        id: "qwen-coder:7b",
        capabilities: ["coding", "instruct"],
        speed: "fast",
        sizeHint: "7B",
      }),
    ];
    const provider = stubProvider("ollama");
    router.registerProvider("ollama", provider as never, "ollama");

    const result = router.select("coding");
    expect(result).not.toBeNull();
    expect(result!.model.id).toBe("qwen-coder:7b");
  });

  it("prefers fast models for completion tasks", () => {
    (router as unknown as { models: DiscoveredModel[] }).models = [
      mockModel({
        id: "codestral:22b",
        capabilities: ["coding"],
        speed: "slow",
        sizeHint: "22B",
      }),
      mockModel({
        id: "qwen-coder:3b",
        capabilities: ["coding"],
        speed: "fast",
        sizeHint: "3B",
      }),
    ];
    router.registerProvider(
      "ollama",
      stubProvider("ollama") as never,
      "ollama",
    );

    const result = router.select("completion");
    expect(result).not.toBeNull();
    expect(result!.model.id).toBe("qwen-coder:3b");
  });

  it("prefers embedding models for embedding tasks", () => {
    (router as unknown as { models: DiscoveredModel[] }).models = [
      mockModel({
        id: "llama3.1:8b",
        capabilities: ["general"],
        speed: "fast",
      }),
      mockModel({
        id: "nomic-embed",
        capabilities: ["embedding"],
        speed: "fast",
      }),
    ];
    router.registerProvider(
      "ollama",
      stubProvider("ollama") as never,
      "ollama",
    );

    const result = router.select("embedding");
    expect(result).not.toBeNull();
    expect(result!.model.id).toBe("nomic-embed");
  });

  it("prefers general + fast models for chat tasks", () => {
    (router as unknown as { models: DiscoveredModel[] }).models = [
      mockModel({
        id: "codestral:22b",
        capabilities: ["coding"],
        speed: "slow",
        sizeHint: "22B",
      }),
      mockModel({
        id: "llama3.1:8b",
        capabilities: ["general", "instruct"],
        speed: "fast",
        sizeHint: "8B",
      }),
    ];
    router.registerProvider(
      "ollama",
      stubProvider("ollama") as never,
      "ollama",
    );

    const result = router.select("chat");
    expect(result).not.toBeNull();
    expect(result!.model.id).toBe("llama3.1:8b");
  });

  it("manual mode returns the locked model regardless of task", () => {
    (router as unknown as { models: DiscoveredModel[] }).models = [
      mockModel({
        id: "llama3.1:8b",
        capabilities: ["general"],
        speed: "fast",
      }),
      mockModel({
        id: "qwen-coder:7b",
        capabilities: ["coding"],
        speed: "fast",
      }),
    ];
    router.registerProvider(
      "ollama",
      stubProvider("ollama") as never,
      "ollama",
    );
    router.setManualModel("llama3.1:8b");

    const result = router.select("coding");
    expect(result!.model.id).toBe("llama3.1:8b");
    expect(result!.reason).toBe("manual selection");
  });

  it("onChange fires after discovery", async () => {
    const listener = vi.fn();
    router.onChange(listener);
    // Empty discover (no providers registered with reachable URLs).
    await router.discover();
    expect(listener).toHaveBeenCalled();
  });

  it("prefers larger coding models over smaller ones for coding tasks", () => {
    (router as unknown as { models: DiscoveredModel[] }).models = [
      mockModel({
        id: "qwen-coder:7b",
        capabilities: ["coding", "instruct"],
        speed: "fast",
        sizeHint: "7B",
      }),
      mockModel({
        id: "deepseek-v2:16b",
        capabilities: ["coding", "instruct"],
        speed: "medium",
        sizeHint: "16B",
      }),
    ];
    router.registerProvider(
      "ollama",
      stubProvider("ollama") as never,
      "ollama",
    );

    const result = router.select("coding");
    expect(result!.model.id).toBe("deepseek-v2:16b");
  });

  it("hard-excludes embedding models from chat and coding tasks", () => {
    (router as unknown as { models: DiscoveredModel[] }).models = [
      mockModel({
        id: "nomic-embed",
        capabilities: ["embedding"],
        speed: "fast",
      }),
    ];
    router.registerProvider(
      "ollama",
      stubProvider("ollama") as never,
      "ollama",
    );

    // When only embedding models are available, coding and chat must return
    // null — never route a user message to an embedding endpoint.
    expect(router.select("coding")).toBeNull();
    expect(router.select("chat")).toBeNull();

    // The embedding model IS returned for the embedding task type.
    expect(router.select("embedding")!.model.id).toBe("nomic-embed");
  });
});
