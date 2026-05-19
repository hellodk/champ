import { describe, it, expect, beforeEach } from "vitest";
import { SmartRouter } from "../smart-router";
import type { LLMProvider, ModelInfo } from "../types";

/** Minimal stub provider for testing — no real network calls. */
function makeProvider(name: string): LLMProvider {
  return {
    name,
    config: {
      provider: name,
      model: "stub",
      baseUrl: "",
      maxTokens: 1024,
      temperature: 0,
    },
    modelInfo(): ModelInfo {
      return {
        id: "stub",
        name,
        provider: name,
        contextWindow: 8192,
        maxOutputTokens: 1024,
        supportsToolUse: false,
        supportsImages: false,
        supportsStreaming: true,
      };
    },
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    countTokens: () => 0,
    dispose: () => {},
    chat: async function* () {
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    complete: async function* () {
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  };
}

function makeFakeModel(id: string, providerName: string) {
  return {
    id,
    providerName,
    providerType: providerName,
    capabilities: ["general" as const],
    speed: "medium" as const,
    contextWindow: 8192,
    sizeHint: "7B",
    quantizationLevel: "",
  };
}

describe("SmartRouter user-defined routing rules", () => {
  let router: SmartRouter;
  let ollamaProvider: LLMProvider;
  let claudeProvider: LLMProvider;

  beforeEach(() => {
    router = new SmartRouter();
    ollamaProvider = makeProvider("ollama");
    claudeProvider = makeProvider("claude");

    // Register providers
    router.registerProvider(
      "ollama",
      ollamaProvider,
      "ollama",
      "http://localhost:11434",
    );
    router.registerProvider("claude", claudeProvider, "claude");

    // Register some discovered models
    router.registerStaticModels([
      makeFakeModel("llama3:8b", "ollama"),
      makeFakeModel("claude-sonnet-4-6", "claude"),
    ]);
  });

  it("returns null by default with no rules and no models discovered", () => {
    const freshRouter = new SmartRouter();
    freshRouter.setRoutingRules([]);
    const result = freshRouter.select("coding");
    expect(result).toBeNull();
  });

  it("matches a rule by task type and returns the specified provider/model", () => {
    router.setRoutingRules([
      { match: "coding", provider: "ollama", model: "llama3:8b" },
    ]);
    const result = router.select("coding");
    expect(result).not.toBeNull();
    expect(result!.provider).toBe(ollamaProvider);
    expect(result!.reason).toContain("user rule");
    expect(result!.model.id).toBe("llama3:8b");
  });

  it("matches a rule by file extension glob", () => {
    router.setRoutingRules([
      { match: "*.py", provider: "ollama", model: "llama3:8b" },
    ]);
    const result = router.select("coding", "/workspace/app/main.py");
    expect(result).not.toBeNull();
    expect(result!.reason).toContain("user rule");
    expect(result!.model.id).toBe("llama3:8b");
  });

  it("does not match a glob rule when file extension differs", () => {
    router.setRoutingRules([
      { match: "*.py", provider: "ollama", model: "llama3:8b" },
    ]);
    // .ts file should NOT match *.py rule → falls through to auto-routing
    const result = router.select("coding", "/workspace/app/main.ts");
    // Auto-routing will pick from registered static models
    if (result) {
      expect(result.reason).not.toContain("user rule");
    }
  });

  it("first matching rule wins", () => {
    router.setRoutingRules([
      { match: "coding", provider: "ollama", model: "llama3:8b" },
      { match: "coding", provider: "claude", model: "claude-sonnet-4-6" },
    ]);
    const result = router.select("coding");
    expect(result).not.toBeNull();
    // Should match the first rule — ollama/llama3:8b
    expect(result!.model.id).toBe("llama3:8b");
    expect(result!.provider).toBe(ollamaProvider);
  });

  it("falls back to auto-routing when rule provider is not registered", () => {
    router.setRoutingRules([
      { match: "coding", provider: "vllm-not-registered", model: "some-model" },
    ]);
    // Should warn and fall through to auto-routing
    const result = router.select("coding");
    // Auto-routing picks from available models — may or may not find one
    if (result) {
      expect(result.reason).not.toContain("user rule");
    }
  });

  it("setRoutingRules replaces previous rules", () => {
    router.setRoutingRules([
      { match: "chat", provider: "ollama", model: "llama3:8b" },
    ]);
    let result = router.select("chat");
    expect(result?.reason).toContain("user rule");

    // Replace with no rules
    router.setRoutingRules([]);
    result = router.select("chat");
    // No user rule — auto-routing or null
    if (result) {
      expect(result.reason).not.toContain("user rule");
    }
  });

  it("setRoutingRules clears the route cache", () => {
    // First select with no rules
    router.select("coding");

    // Add a rule — should not see stale cache
    router.setRoutingRules([
      { match: "coding", provider: "claude", model: "claude-sonnet-4-6" },
    ]);
    const result = router.select("coding");
    expect(result).not.toBeNull();
    expect(result!.model.id).toBe("claude-sonnet-4-6");
  });

  it("matchGlob: *.ts matches TypeScript files", () => {
    router.setRoutingRules([
      { match: "*.ts", provider: "claude", model: "claude-sonnet-4-6" },
    ]);
    const result = router.select("chat", "src/providers/smart-router.ts");
    expect(result?.reason).toContain("user rule");
  });

  it("matchGlob: exact pattern matches only exact filenames", () => {
    router.setRoutingRules([
      { match: "Makefile", provider: "ollama", model: "llama3:8b" },
    ]);
    const matchResult = router.select("coding", "Makefile");
    expect(matchResult?.reason).toContain("user rule");

    const noMatchResult = router.select("coding", "NotMakefile");
    if (noMatchResult) {
      expect(noMatchResult.reason).not.toContain("user rule");
    }
  });

  it("uses rich discovered model metadata when the model exists in registry", () => {
    // The model llama3:8b is in static models — rule should return its metadata
    router.setRoutingRules([
      { match: "coding", provider: "ollama", model: "llama3:8b" },
    ]);
    const result = router.select("coding");
    expect(result).not.toBeNull();
    // The providerName should come from the registered static model
    expect(result!.model.providerName).toBe("ollama");
  });

  it("null rules argument is treated as empty array (no crash)", () => {
    // @ts-expect-error testing runtime null handling
    expect(() => router.setRoutingRules(null)).not.toThrow();
    const result = router.select("coding");
    // Should auto-route or return null — no crash
    expect(result === null || typeof result === "object").toBe(true);
  });
});
