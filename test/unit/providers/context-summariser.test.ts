/**
 * TDD (#138 / #114): the shared summariser used by both the interactive
 * controller and the team tool loop.
 *
 * The request it builds has to fit the same small window it is compacting for,
 * so a long dropped prefix is quoted only where it is newest and the rest is
 * counted rather than pasted.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createContextSummariser,
  summariserPrompt,
  summariserPromptBudget,
  EMPTY_SUMMARY,
  SUMMARISER_MARKER,
} from "@/providers/context-summariser";
import type { LLMMessage, LLMProvider } from "@/providers/types";

type Chunk =
  | { type: "text"; text: string }
  | { type: "error"; error?: string }
  | { type: "done" };

function providerYielding(chunks: Chunk[], contextWindow = 8192): LLMProvider {
  const chat = vi.fn(async function* () {
    for (const chunk of chunks) yield chunk;
    yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } };
  });
  const provider = {
    chat,
    modelInfo: () => ({
      id: "test",
      name: "Test",
      provider: "test",
      contextWindow,
      maxOutputTokens: 1024,
      supportsToolUse: true,
      supportsImages: false,
      supportsStreaming: true,
    }),
  };
  return provider as unknown as LLMProvider;
}

describe("summariserPrompt (#138)", () => {
  it("renders dropped turns as role-prefixed lines", () => {
    const prompt = summariserPrompt([
      { role: "user", content: "what is the build command" },
      { role: "assistant", content: "pnpm build" },
    ]);
    expect(prompt).toContain(SUMMARISER_MARKER);
    expect(prompt).toContain("user: what is the build command");
    expect(prompt).toContain("assistant: pnpm build");
  });

  it("includes tool results so the summary covers what tools returned", () => {
    const message: LLMMessage = {
      role: "tool",
      toolCallId: "c1",
      content: [
        {
          type: "tool_result",
          toolUseId: "c1",
          content: "src/cli.ts:12: export const x = 1",
        },
      ],
    };
    expect(summariserPrompt([message])).toContain("src/cli.ts:12");
  });

  it("caps each turn so one huge tool result cannot dominate", () => {
    const prompt = summariserPrompt([
      { role: "tool", content: "x".repeat(50_000) },
    ]);
    // Marker + prefix + one 300-char turn.
    expect(prompt.length).toBeLessThan(400);
  });

  it("drops the oldest turns and says how many it omitted", () => {
    const dropped: LLMMessage[] = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i} ${"y".repeat(400)}`,
    }));
    const prompt = summariserPrompt(dropped);
    expect(prompt).toMatch(/… \[\d+ earlier message\(s\) omitted\]/);
    // The newest turns survive, the oldest are counted instead.
    expect(prompt).toContain("message 99");
    expect(prompt).not.toContain("message 0 ");
    expect(prompt.length).toBeLessThan(9000);
  });
});

describe("createContextSummariser (#138)", () => {
  it("returns the provider's text", async () => {
    const provider = providerYielding([
      { type: "text", text: "  read files " },
    ]);
    const summarise = createContextSummariser(provider);
    expect(await summarise([{ role: "user", content: "hi" }])).toBe(
      "read files",
    );
  });

  it("falls back to a fixed string when the provider says nothing", async () => {
    const summarise = createContextSummariser(providerYielding([]));
    expect(await summarise([{ role: "user", content: "hi" }])).toBe(
      EMPTY_SUMMARY,
    );
  });
});

/**
 * Review 4 (2026-10-19): the summariser request has to fit the window it is
 * compacting for, so its budget comes from the model — not a fixed constant —
 * and a failed summarise must surface instead of passing as a summary.
 */
describe("summariser budget (external review 4)", () => {
  it("derives the prompt budget from the model window", () => {
    const small = summariserPromptBudget(providerYielding([], 2048));
    const large = summariserPromptBudget(providerYielding([], 64_000));

    // 20% of the window in characters: 2048 * .2 = 409 tokens → 1636 chars.
    expect(small).toBe(1636);
    // A huge window is still capped so a long dropped prefix is not pasted.
    expect(large).toBe(8000);
    expect(small).toBeLessThan(large);
  });

  it("keeps a long prompt inside the window's input budget", () => {
    const provider = providerYielding([], 2048); // reserved 1024 → budget 1024
    const budgetChars = summariserPromptBudget(provider);
    const dropped: LLMMessage[] = Array.from({ length: 200 }, (_, i) => ({
      role: "user" as const,
      content: `message ${i} ${"z".repeat(400)}`,
    }));

    const prompt = summariserPrompt(dropped, budgetChars);

    expect(prompt.length).toBeLessThanOrEqual(budgetChars);
    expect(Math.ceil(prompt.length / 4)).toBeLessThanOrEqual(1024);
    expect(prompt).toContain("message ");
  });

  it("fails loudly on a provider error instead of returning a placeholder", async () => {
    const summarise = createContextSummariser(
      providerYielding([{ type: "error", error: "model overloaded" }]),
    );

    await expect(summarise([{ role: "user", content: "hi" }])).rejects.toThrow(
      /model overloaded/,
    );
  });
});
