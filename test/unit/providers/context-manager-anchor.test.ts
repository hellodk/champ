/**
 * TDD (#137): provider-anchored token accounting.
 *
 * The provider reports authoritative prompt_tokens for the exact prefix it
 * received. ContextWindowManager should treat that as ground truth for the
 * measured prefix and only estimate the messages appended since — instead of
 * re-tokenizing the whole history from scratch every turn.
 */
import { describe, it, expect, vi } from "vitest";
import { ContextWindowManager } from "@/providers/context-manager";
import type { LLMProvider, LLMMessage } from "@/providers/types";

function makeProvider(contextWindow: number) {
  const countTokens = vi.fn(
    (text: string) => text.split(/\s+/).filter(Boolean).length,
  );
  const provider = {
    name: "mock",
    config: { provider: "mock", model: "test" },
    countTokens,
    modelInfo: () => ({
      id: "test",
      name: "Test",
      provider: "mock",
      contextWindow,
      maxOutputTokens: 512,
      supportsToolUse: true,
      supportsImages: false,
      supportsStreaming: true,
    }),
    chat: vi.fn(),
    complete: vi.fn(),
    supportsToolUse: () => true,
    supportsStreaming: () => true,
    dispose: vi.fn(),
  } as unknown as LLMProvider;
  return { provider, countTokens };
}

const msg = (role: LLMMessage["role"], content: string): LLMMessage => ({
  role,
  content,
});

/** Naive full-history estimate, matching the pre-#137 behaviour. */
function fullEstimate(
  countTokens: (t: string) => number,
  messages: LLMMessage[],
): number {
  return messages.reduce((sum, m) => {
    const text = typeof m.content === "string" ? m.content : "";
    return sum + countTokens(text) + 4;
  }, 0);
}

describe("ContextWindowManager — provider-anchored accounting (#137)", () => {
  it("uses the provider-reported prompt tokens as the ground-truth prefix size", () => {
    const { provider } = makeProvider(100_000);
    const manager = new ContextWindowManager(provider);
    const messages = [msg("system", "be helpful"), msg("user", "hi")];

    // Provider reports 9000; the cheap estimator would say far fewer.
    manager.recordUsage(messages, 9000);

    expect(manager.estimateTokens(messages)).toBe(9000);
  });

  it("estimates only the messages appended after a measured response", () => {
    const { provider, countTokens } = makeProvider(100_000);
    const manager = new ContextWindowManager(provider);
    const base = [msg("system", "be helpful"), msg("user", "first question")];

    manager.recordUsage(base, 5000);
    countTokens.mockClear();

    const extended = [
      ...base,
      msg("assistant", "one two three"),
      msg("user", "another question"),
    ];
    const total = manager.estimateTokens(extended);

    // Only the two appended messages were tokenized (2 + 2 + 4 overhead each).
    expect(countTokens).toHaveBeenCalledTimes(2);
    expect(total).toBe(5000 + (3 + 4) + (2 + 4));
  });

  it("falls back to a full estimate when the provider reports no usage", () => {
    const { provider, countTokens } = makeProvider(100_000);
    const manager = new ContextWindowManager(provider);
    const messages = [msg("system", "be helpful"), msg("user", "hello there")];

    manager.recordUsage(messages, 0); // e.g. Ollama without usage

    expect(manager.estimateTokens(messages)).toBe(
      fullEstimate(countTokens, messages),
    );
  });

  it("ignores a stale anchor when the measured prefix changes", () => {
    const { provider, countTokens } = makeProvider(100_000);
    const manager = new ContextWindowManager(provider);
    manager.recordUsage([msg("system", "be helpful"), msg("user", "hi")], 9000);

    const changed = [msg("system", "COMPLETELY DIFFERENT"), msg("user", "hi")];

    expect(manager.estimateTokens(changed)).toBe(
      fullEstimate(countTokens, changed),
    );
  });

  it("compacts when the measured prefix exceeds the budget even if the cheap estimate would fit", () => {
    const { provider } = makeProvider(1000); // budget = 1000 - 500 = 500
    const manager = new ContextWindowManager(provider);
    const messages = [
      msg("system", "sys"),
      msg("user", "u1"),
      msg("assistant", "a1"),
      msg("user", "u2"),
      msg("assistant", "a2"),
      msg("user", "latest"),
    ];

    // Measured prefix says 900 > 500 budget, though tokens are tiny.
    manager.recordUsage(messages, 900);

    const fitted = manager.fitMessages(messages);
    expect(fitted.length).toBeLessThan(messages.length);
    expect(fitted[0].role).toBe("system");
    expect(fitted[fitted.length - 1].content).toBe("latest");
  });

  it("clearUsage() drops the anchor and restores full estimation", () => {
    const { provider, countTokens } = makeProvider(100_000);
    const manager = new ContextWindowManager(provider);
    const messages = [msg("system", "be helpful"), msg("user", "hi")];

    manager.recordUsage(messages, 9000);
    manager.clearUsage();

    expect(manager.estimateTokens(messages)).toBe(
      fullEstimate(countTokens, messages),
    );
  });
});
