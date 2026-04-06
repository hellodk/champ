/**
 * TDD: Tests for ProviderRegistry.
 * Validates provider registration, retrieval, and listing.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ProviderRegistry } from "@/providers/registry";
import type { LLMProvider, LLMProviderConfig } from "@/providers/types";

// Helper to create a mock provider
function createMockProvider(name: string): LLMProvider {
  return {
    name,
    config: {
      provider: name,
      model: "test",
      maxTokens: 1024,
      temperature: 0.7,
    },
    chat: vi.fn(),
    complete: vi.fn(),
    supportsToolUse: () => true,
    supportsStreaming: () => true,
    countTokens: () => 0,
    modelInfo: () => ({
      id: "test",
      name: "Test",
      provider: name,
      contextWindow: 4096,
      maxOutputTokens: 1024,
      supportsToolUse: true,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: vi.fn(),
  } as unknown as LLMProvider;
}

describe("ProviderRegistry", () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it("should register a provider", () => {
    const provider = createMockProvider("claude");
    registry.register(provider);
    expect(registry.get("claude")).toBe(provider);
  });

  it("should throw when getting an unregistered provider", () => {
    expect(() => registry.get("nonexistent")).toThrow();
  });

  it("should list all registered providers", () => {
    registry.register(createMockProvider("claude"));
    registry.register(createMockProvider("ollama"));
    registry.register(createMockProvider("openai"));

    const list = registry.list();
    expect(list).toHaveLength(3);
    expect(list.map((p) => p.name)).toContain("claude");
    expect(list.map((p) => p.name)).toContain("ollama");
  });

  it("should check if a provider exists", () => {
    registry.register(createMockProvider("claude"));
    expect(registry.has("claude")).toBe(true);
    expect(registry.has("openai")).toBe(false);
  });

  it("should unregister a provider and dispose it", () => {
    const provider = createMockProvider("claude");
    registry.register(provider);
    registry.unregister("claude");
    expect(registry.has("claude")).toBe(false);
    expect(provider.dispose).toHaveBeenCalled();
  });

  it("should dispose all providers on disposeAll", () => {
    const p1 = createMockProvider("claude");
    const p2 = createMockProvider("ollama");
    registry.register(p1);
    registry.register(p2);

    registry.disposeAll();
    expect(p1.dispose).toHaveBeenCalled();
    expect(p2.dispose).toHaveBeenCalled();
  });
});
