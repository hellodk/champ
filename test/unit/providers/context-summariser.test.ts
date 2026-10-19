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
  EMPTY_SUMMARY,
  SUMMARISER_MARKER,
} from "@/providers/context-summariser";
import type { LLMMessage, LLMProvider } from "@/providers/types";

function providerYielding(chunks: Array<{ type: "text"; text: string }>) {
  const chat = vi.fn(async function* () {
    for (const chunk of chunks) yield chunk;
    yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } };
  });
  return { chat } as unknown as LLMProvider;
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
