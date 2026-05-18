/**
 * Tests for ChampInlineCompletionProvider.
 *
 * Covers:
 *  - Suffix extraction and passing via CompletionContext
 *  - FIM prompt construction (suffix used in <|fim_suffix|> token)
 *  - Coalescing behaviour (rapid calls resolve to [])
 *  - External abort signal honoured before LLM call
 */

import { describe, it, expect, vi } from "vitest";
import {
  ChampInlineCompletionProvider,
  type CompletionContext,
} from "../inline-provider";
import type { LLMProvider, StreamDelta } from "../../providers/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(chunks: StreamDelta[]): LLMProvider {
  return {
    name: "fake",
    config: {
      provider: "fake",
      model: "test",
      maxTokens: 256,
      temperature: 0.2,
    },
    complete: vi.fn(async function* () {
      for (const c of chunks) yield c;
    }),
    chat: vi.fn(async function* () {}),
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    countTokens: (t: string) => t.length,
    modelInfo: () => ({
      id: "test",
      name: "Test",
      provider: "fake",
      contextWindow: 4096,
      maxOutputTokens: 256,
      supportsToolUse: false,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: () => {},
  };
}

const baseContext: CompletionContext = {
  filePath: "src/foo.ts",
  language: "typescript",
  lineNumber: 10,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChampInlineCompletionProvider", () => {
  describe("suffix context (FIM)", () => {
    it("passes suffix from CompletionContext into the prompt", async () => {
      const provider = makeProvider([
        { type: "text", text: "hello" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 1 } },
      ]);
      const champ = new ChampInlineCompletionProvider(provider);

      const completions = await champ.provideCompletions("const x = ", {
        ...baseContext,
        suffix: ";\nconsole.log(x);",
      });

      expect(completions).toHaveLength(1);
      expect(completions[0].text).toBe("hello");

      // Verify complete() was called with a prompt that embeds the suffix
      const completeFn = provider.complete as ReturnType<typeof vi.fn>;
      expect(completeFn).toHaveBeenCalledOnce();
      const promptArg: string = completeFn.mock.calls[0][0];
      expect(promptArg).toContain("<|fim_suffix|>");
      expect(promptArg).toContain(";\nconsole.log(x);");
      expect(promptArg).toContain("<|fim_middle|>");
    });

    it("uses empty suffix when none is provided", async () => {
      const provider = makeProvider([
        { type: "text", text: "world" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 1 } },
      ]);
      const champ = new ChampInlineCompletionProvider(provider);

      const completions = await champ.provideCompletions(
        "const y = ",
        baseContext,
      );

      expect(completions).toHaveLength(1);
      const completeFn = provider.complete as ReturnType<typeof vi.fn>;
      const promptArg: string = completeFn.mock.calls[0][0];
      // Suffix token should still appear, just with empty content
      expect(promptArg).toContain("<|fim_suffix|><|fim_middle|>");
    });

    it("suffix cap at 500 chars — provider contract accepts long suffix in context", async () => {
      const provider = makeProvider([
        { type: "text", text: "ok" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 1 } },
      ]);
      const champ = new ChampInlineCompletionProvider(provider);
      // Supply exactly 500 chars — all should appear in the prompt
      const suffix = "x".repeat(500);

      await champ.provideCompletions("prefix", { ...baseContext, suffix });

      const completeFn = provider.complete as ReturnType<typeof vi.fn>;
      const promptArg: string = completeFn.mock.calls[0][0];
      expect(promptArg).toContain(suffix);
    });
  });

  describe("coalescing / abort", () => {
    it("resolves to [] immediately when external abort is already triggered", async () => {
      const provider = makeProvider([
        { type: "text", text: "never" },
        { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
      ]);
      const champ = new ChampInlineCompletionProvider(provider);
      const controller = new AbortController();
      controller.abort();

      const result = await champ.provideCompletions(
        "some prefix",
        baseContext,
        controller.signal,
      );
      expect(result).toEqual([]);
    });

    it("superseded calls resolve to []", async () => {
      const provider = makeProvider([
        { type: "text", text: "result" },
        { type: "done", usage: { inputTokens: 3, outputTokens: 1 } },
      ]);
      const champ = new ChampInlineCompletionProvider(provider);

      // Fire two calls synchronously so the first is superseded
      const p1 = champ.provideCompletions("prefix a", baseContext);
      const p2 = champ.provideCompletions("prefix b", baseContext);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toEqual([]); // superseded
      expect(r2).toHaveLength(1); // last call wins
    });
  });

  describe("cleanSuggestion", () => {
    it("strips FIM end tokens from output", async () => {
      const provider = makeProvider([
        { type: "text", text: "result<|fim_suffix|>extra stuff" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 1 } },
      ]);
      const champ = new ChampInlineCompletionProvider(provider);
      const completions = await champ.provideCompletions("fn(", baseContext);
      expect(completions[0].text).toBe("result");
    });

    it("returns [] when output is only whitespace after cleaning", async () => {
      const provider = makeProvider([
        { type: "text", text: "   <|endoftext|>  " },
        { type: "done", usage: { inputTokens: 5, outputTokens: 1 } },
      ]);
      const champ = new ChampInlineCompletionProvider(provider);
      const completions = await champ.provideCompletions("fn(", baseContext);
      expect(completions).toEqual([]);
    });
  });

  describe("error handling", () => {
    it("returns [] when provider emits error delta", async () => {
      const provider = makeProvider([{ type: "error", error: "oops" }]);
      const champ = new ChampInlineCompletionProvider(provider);
      const result = await champ.provideCompletions("x", baseContext);
      expect(result).toEqual([]);
    });
  });
});
