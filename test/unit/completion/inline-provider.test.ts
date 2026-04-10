/**
 * TDD: Tests for InlineCompletionProvider.
 * Ghost text suggestions using a small fast local model.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ChampInlineCompletionProvider } from "@/completion/inline-provider";
import type { LLMProvider, StreamDelta } from "@/providers/types";

describe("ChampInlineCompletionProvider", () => {
  let provider: ChampInlineCompletionProvider;
  let mockLLM: LLMProvider;

  beforeEach(() => {
    mockLLM = {
      name: "mock",
      config: {
        provider: "mock",
        model: "qwen-coder",
        maxTokens: 256,
        temperature: 0.2,
      },
      complete: vi
        .fn()
        .mockImplementation(async function* (): AsyncIterable<StreamDelta> {
          yield {
            type: "text",
            text: 'function hello() {\n  return "world";\n}',
          };
          yield { type: "done", usage: { inputTokens: 20, outputTokens: 15 } };
        }),
      chat: vi.fn(),
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      countTokens: () => 10,
      modelInfo: () => ({
        id: "qwen-coder",
        name: "Qwen Coder",
        provider: "ollama",
        contextWindow: 4096,
        maxOutputTokens: 256,
        supportsToolUse: false,
        supportsImages: false,
        supportsStreaming: true,
      }),
      dispose: vi.fn(),
    } as unknown as LLMProvider;

    provider = new ChampInlineCompletionProvider(mockLLM);
  });

  it("should provide completions for a given prefix", async () => {
    const completions = await provider.provideCompletions("function he", {
      filePath: "test.ts",
      language: "typescript",
      lineNumber: 1,
    });

    expect(completions).toBeDefined();
    expect(completions.length).toBeGreaterThan(0);
    expect(completions[0].text).toContain("hello");
  });

  it("should use the complete() method, not chat()", async () => {
    await provider.provideCompletions("const x = ", {
      filePath: "test.ts",
      language: "typescript",
      lineNumber: 5,
    });

    expect(mockLLM.complete).toHaveBeenCalled();
    expect(mockLLM.chat).not.toHaveBeenCalled();
  });

  it("should handle empty completions", async () => {
    (mockLLM.complete as ReturnType<typeof vi.fn>).mockImplementation(
      async function* () {
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 0 } };
      },
    );

    const completions = await provider.provideCompletions("x", {
      filePath: "test.ts",
      language: "typescript",
      lineNumber: 1,
    });

    expect(completions).toHaveLength(0);
  });

  it("should handle provider errors gracefully", async () => {
    (mockLLM.complete as ReturnType<typeof vi.fn>).mockImplementation(
      async function* () {
        yield { type: "error", error: "Connection refused" };
      },
    );

    const completions = await provider.provideCompletions("const", {
      filePath: "test.ts",
      language: "typescript",
      lineNumber: 1,
    });

    expect(completions).toHaveLength(0);
  });

  it("should respect abort signal for cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const completions = await provider.provideCompletions(
      "function",
      { filePath: "test.ts", language: "typescript", lineNumber: 1 },
      controller.signal,
    );

    expect(completions).toHaveLength(0);
  });

  it("should debounce rapid calls", async () => {
    // Fire multiple requests rapidly
    const p1 = provider.provideCompletions("a", {
      filePath: "test.ts",
      language: "typescript",
      lineNumber: 1,
    });
    const p2 = provider.provideCompletions("ab", {
      filePath: "test.ts",
      language: "typescript",
      lineNumber: 1,
    });
    const p3 = provider.provideCompletions("abc", {
      filePath: "test.ts",
      language: "typescript",
      lineNumber: 1,
    });

    await Promise.all([p1, p2, p3]);

    // Only the last call should have actually invoked the LLM
    // (or at most 1-2 due to debouncing)
    const callCount = (mockLLM.complete as ReturnType<typeof vi.fn>).mock.calls
      .length;
    expect(callCount).toBeLessThanOrEqual(2);
  });
});
