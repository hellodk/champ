/**
 * TDD: Tests for ModelRouter.
 * Routes tasks to appropriate models: small for autocomplete, large for agents.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ModelRouter } from "@/providers/model-router";
import type { LLMProvider } from "@/providers/types";

describe("ModelRouter", () => {
  let router: ModelRouter;

  beforeEach(() => {
    const mockSmall = {
      name: "ollama-small",
      config: {
        provider: "ollama",
        model: "qwen2.5-coder:1.5b",
        maxTokens: 256,
        temperature: 0.2,
      },
      modelInfo: () => ({
        id: "qwen2.5-coder:1.5b",
        name: "Qwen Coder",
        provider: "ollama",
        contextWindow: 4096,
        maxOutputTokens: 256,
        supportsToolUse: false,
        supportsImages: false,
        supportsStreaming: true,
      }),
    } as unknown as LLMProvider;

    const mockLarge = {
      name: "claude",
      config: {
        provider: "claude",
        model: "claude-sonnet-4-20250514",
        maxTokens: 8192,
        temperature: 0.7,
      },
      modelInfo: () => ({
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        provider: "claude",
        contextWindow: 200000,
        maxOutputTokens: 8192,
        supportsToolUse: true,
        supportsImages: true,
        supportsStreaming: true,
      }),
    } as unknown as LLMProvider;

    const mockEmbedding = {
      name: "ollama-embed",
      config: {
        provider: "ollama",
        model: "nomic-embed-text",
        maxTokens: 0,
        temperature: 0,
      },
    } as unknown as LLMProvider;

    router = new ModelRouter({
      completion: mockSmall,
      chat: mockLarge,
      embedding: mockEmbedding,
    });
  });

  it("should return small model for completion tasks", () => {
    const provider = router.getProvider("completion");
    expect(provider.name).toBe("ollama-small");
  });

  it("should return large model for chat tasks", () => {
    const provider = router.getProvider("chat");
    expect(provider.name).toBe("claude");
  });

  it("should return embedding model for indexing", () => {
    const provider = router.getProvider("embedding");
    expect(provider.name).toBe("ollama-embed");
  });

  it("should allow updating the chat model", () => {
    const newProvider = {
      name: "openai",
      config: {
        provider: "openai",
        model: "gpt-4o",
        maxTokens: 4096,
        temperature: 0.7,
      },
    } as unknown as LLMProvider;

    router.setProvider("chat", newProvider);
    expect(router.getProvider("chat").name).toBe("openai");
  });

  it("should throw for unknown task type", () => {
    expect(() => router.getProvider("unknown" as any)).toThrow();
  });

  it("should return model info for the active chat model", () => {
    const info = router.getActiveModelInfo("chat");
    expect(info.supportsToolUse).toBe(true);
    expect(info.contextWindow).toBe(200000);
  });
});
