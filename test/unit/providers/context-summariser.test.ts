import { describe, it, expect, vi } from "vitest";
import { ContextWindowManager } from "@/providers/context-manager";
import type { LLMMessage, LLMProvider } from "@/providers/types";

function makeProvider(contextWindow: number): LLMProvider {
  return {
    modelInfo: () => ({
      id: "test",
      name: "test",
      contextWindow,
      supportsImages: false,
    }),
    countTokens: (s: string) => Math.ceil(s.length / 4),
    chat: vi.fn(),
    supportsToolUse: () => false,
    withModel: undefined,
  } as unknown as LLMProvider;
}

function makeMessages(count: number): LLMMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
    content: `message number ${i} with some content to fill up tokens here and there`,
  }));
}

describe("ContextWindowManager.fitWithSummary", () => {
  it("returns messages unchanged when they fit", async () => {
    const provider = makeProvider(100_000);
    const manager = new ContextWindowManager(provider);
    const messages = makeMessages(3);
    const summarize = vi.fn();
    const result = await manager.fitWithSummary(messages, summarize);
    expect(result).toEqual(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("calls summarize with dropped turns and inserts summary as system message", async () => {
    const provider = makeProvider(300);
    const manager = new ContextWindowManager(provider);
    const messages = makeMessages(10);
    const summarize = vi
      .fn()
      .mockResolvedValue("Summary of earlier discussion about topic X");
    const result = await manager.fitWithSummary(messages, summarize);
    expect(summarize).toHaveBeenCalled();
    const summaryMsg = result.find(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        (m.content as string).includes("Earlier conversation summary"),
    );
    expect(summaryMsg).toBeDefined();
    expect(manager.estimateTokens(result)).toBeLessThanOrEqual(
      manager.availableTokens(messages) * 1.1,
    );
  });

  it("falls back to drop behaviour when summarize throws", async () => {
    const provider = makeProvider(300);
    const manager = new ContextWindowManager(provider);
    const messages = makeMessages(10);
    const summarize = vi.fn().mockRejectedValue(new Error("LLM unavailable"));
    const result = await manager.fitWithSummary(messages, summarize);
    expect(result.length).toBeGreaterThan(0);
  });
});
