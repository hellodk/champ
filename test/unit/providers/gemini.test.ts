/**
 * TDD: Tests for GeminiProvider.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { GeminiProvider } from "@/providers/gemini";
import type { LLMMessage, StreamDelta } from "@/providers/types";

// Mock the Google Gemini SDK
vi.mock("@google/generative-ai", () => {
  return {
    GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContentStream: vi.fn(),
      }),
    })),
  };
});

describe("GeminiProvider", () => {
  let provider: GeminiProvider;

  beforeEach(() => {
    provider = new GeminiProvider({
      provider: "gemini",
      model: "gemini-2.0-flash",
      apiKey: "test-key",
      maxTokens: 4096,
      temperature: 0.7,
    });
  });

  it("should have correct name", () => {
    expect(provider.name).toBe("gemini");
  });

  it("should support tool use", () => {
    expect(provider.supportsToolUse()).toBe(true);
  });

  it("should support streaming", () => {
    expect(provider.supportsStreaming()).toBe(true);
  });

  it("should return correct model info", () => {
    const info = provider.modelInfo();
    expect(info.provider).toBe("gemini");
    expect(info.contextWindow).toBeGreaterThan(0);
  });

  it("should stream chat responses", async () => {
    const messages: LLMMessage[] = [{ role: "user", content: "Hello" }];

    const deltas: StreamDelta[] = [];
    for await (const delta of provider.chat(messages)) {
      deltas.push(delta);
      if (delta.type === "done") break;
    }

    expect(deltas.some((d) => d.type === "done")).toBe(true);
  });

  it("should respect abort signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const deltas: StreamDelta[] = [];
    for await (const delta of provider.chat(
      [{ role: "user", content: "Hello" }],
      { abortSignal: controller.signal },
    )) {
      deltas.push(delta);
    }

    expect(deltas.length === 0 || deltas.some((d) => d.type === "error")).toBe(
      true,
    );
  });

  it("should count tokens", () => {
    const count = provider.countTokens("Hello, world!");
    expect(count).toBeGreaterThan(0);
  });

  it("should dispose cleanly", () => {
    expect(() => provider.dispose()).not.toThrow();
  });
});
