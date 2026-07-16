/**
 * TDD: Tests for ContextWindowManager.
 * Validates token counting, message truncation, and context fitting.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContextWindowManager } from "@/providers/context-manager";
import type { LLMProvider, LLMMessage } from "@/providers/types";

function createMockProvider(contextWindow: number): LLMProvider {
  return {
    name: "mock",
    config: {
      provider: "mock",
      model: "test",
      maxTokens: 1024,
      temperature: 0.7,
    },
    countTokens: (text: string) => text.split(/\s+/).length, // rough word count
    modelInfo: () => ({
      id: "test",
      name: "Test",
      provider: "mock",
      contextWindow,
      maxOutputTokens: 1024,
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
}

describe("ContextWindowManager", () => {
  let manager: ContextWindowManager;
  let provider: LLMProvider;

  beforeEach(() => {
    provider = createMockProvider(100); // 100 token context window
    manager = new ContextWindowManager(provider);
  });

  it("should return all messages when within context window", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const result = manager.fitMessages(messages);
    expect(result).toHaveLength(2);
  });

  it("should truncate old messages when over context window", () => {
    const messages: LLMMessage[] = [
      {
        role: "system",
        content:
          "System prompt with many words to take up tokens in the context window",
      },
      { role: "user", content: "First message with a lot of words" },
      { role: "assistant", content: "First response with a lot of words" },
      { role: "user", content: "Second message with words" },
      { role: "assistant", content: "Second response with words" },
      { role: "user", content: "Third message" },
      { role: "assistant", content: "Third response" },
      { role: "user", content: "Latest question" },
    ];
    const result = manager.fitMessages(messages);
    // Should preserve system message and most recent messages
    expect(result[0].role).toBe("system");
    expect(result[result.length - 1].content).toBe("Latest question");
    expect(result.length).toBeLessThan(messages.length);
  });

  it("should always preserve the system message", () => {
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: "Important system instructions that must always be present",
      },
      ...Array.from({ length: 50 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `Message number ${i} with some content`,
      })),
    ];
    const result = manager.fitMessages(messages);
    expect(result[0].role).toBe("system");
  });

  it("should always preserve the last user message", () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "System" },
      ...Array.from({ length: 20 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: `Message ${i}`,
      })),
      { role: "user", content: "This must be kept" },
    ];
    const result = manager.fitMessages(messages);
    expect(result[result.length - 1].content).toBe("This must be kept");
  });

  it("should estimate total tokens for messages", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "Hello world" },
      { role: "assistant", content: "Hi there friend" },
    ];
    const count = manager.estimateTokens(messages);
    expect(count).toBeGreaterThan(0);
  });

  it("should report available token budget", () => {
    const budget = manager.availableTokens([]);
    expect(budget).toBeGreaterThan(0);
    expect(budget).toBeLessThanOrEqual(100); // context window minus reserved for output
  });
});

describe("ContextWindowManager.fitWithSummary — context compaction", () => {
  let manager: ContextWindowManager;
  let provider: LLMProvider;

  beforeEach(() => {
    provider = createMockProvider(100); // 100 token context window
    manager = new ContextWindowManager(provider);
  });

  it("should return original messages when within budget", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const summarize = vi.fn();

    const result = await manager.fitWithSummary(messages, summarize);

    expect(result).toHaveLength(3);
    expect(result).toEqual(messages);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("should call summarize when messages exceed budget", async () => {
    const messages: LLMMessage[] = [
      {
        role: "system",
        content: "System prompt with many words to take up tokens",
      },
      { role: "user", content: "First message with a lot of words" },
      { role: "assistant", content: "First response with a lot of words" },
      { role: "user", content: "Second message with many words" },
      { role: "assistant", content: "Second response with many words" },
      { role: "user", content: "Third message" },
      { role: "assistant", content: "Third response" },
      { role: "user", content: "Latest" },
    ];
    const summarize = vi.fn(async () => "Summary of previous conversation");

    const result = await manager.fitWithSummary(messages, summarize);

    expect(summarize).toHaveBeenCalled();
    expect(result.length).toBeLessThan(messages.length);
  });

  it("should preserve system message and last message", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "Important system instructions" },
      { role: "user", content: "Old message" },
      { role: "assistant", content: "Old response" },
      { role: "user", content: "Latest message" },
    ];
    const summarize = vi.fn(async () => "Summary");

    const result = await manager.fitWithSummary(messages, summarize);

    expect(result[0].role).toBe("system");
    expect(result[result.length - 1].content).toBe("Latest message");
  });

  it("should include summary as system message", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "word ".repeat(20) },
      { role: "assistant", content: "word ".repeat(20) },
      { role: "user", content: "word ".repeat(20) },
      { role: "assistant", content: "word ".repeat(20) },
      { role: "user", content: "Latest" },
    ];
    const summaryText = "Previous discussion summary";
    const summarize = vi.fn(async () => summaryText);

    const result = await manager.fitWithSummary(messages, summarize);

    // Should have a system message containing the summary
    const summaryMsg = result.find(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.includes(summaryText),
    );
    expect(summaryMsg).toBeDefined();
  });

  it("should fall back to plain drop when summarizer throws", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "a".repeat(80) },
      { role: "assistant", content: "b".repeat(80) },
      { role: "user", content: "c".repeat(80) },
      { role: "assistant", content: "d".repeat(80) },
      { role: "user", content: "Latest" },
    ];
    const summarize = vi.fn(async () => {
      throw new Error("Summarizer failed");
    });

    const result = await manager.fitWithSummary(messages, summarize);

    // Should return a valid result without the summary
    expect(result[0].role).toBe("system");
    expect(result[result.length - 1].content).toBe("Latest");
    // Should not include any "[Earlier conversation summary: ...]" message
    const hasSummary = result.some(
      (m) =>
        typeof m.content === "string" &&
        m.content.includes("Earlier conversation summary"),
    );
    expect(hasSummary).toBe(false);
  });

  it("should fall back to plain drop when summary is too large to fit", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "a".repeat(80) },
      { role: "assistant", content: "b".repeat(80) },
      { role: "user", content: "c".repeat(80) },
      { role: "assistant", content: "d".repeat(80) },
      { role: "user", content: "Latest" },
    ];
    // Return a summary that is too large to fit
    const summarize = vi.fn(async () => "x".repeat(500));

    const result = await manager.fitWithSummary(messages, summarize);

    // Should return a valid result
    expect(result[0].role).toBe("system");
    expect(result[result.length - 1].content).toBe("Latest");
  });

  it("should preserve only middle messages that fit with summary", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "Message 1 with content" },
      { role: "assistant", content: "Response 1 with content" },
      { role: "user", content: "Message 2 with content" },
      { role: "assistant", content: "Response 2 with content" },
      { role: "user", content: "Latest question" },
    ];
    const summarize = vi.fn(async () => "Earlier summary");

    const result = await manager.fitWithSummary(messages, summarize);

    // Result should have fewer messages than input
    expect(result.length).toBeLessThanOrEqual(messages.length);
    // Last message should be preserved
    expect(result[result.length - 1].content).toBe("Latest question");
  });

  it("should pass dropped messages to summarizer", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "word ".repeat(20) },
      { role: "assistant", content: "word ".repeat(20) },
      { role: "user", content: "word ".repeat(20) },
      { role: "assistant", content: "word ".repeat(20) },
      { role: "user", content: "Latest" },
    ];
    const summarize = vi.fn(async (dropped) => {
      // Verify we received the dropped messages
      expect(dropped.length).toBeGreaterThan(0);
      return "Summary";
    });

    await manager.fitWithSummary(messages, summarize);

    expect(summarize).toHaveBeenCalled();
    const droppedArg = summarize.mock.calls[0][0];
    expect(Array.isArray(droppedArg)).toBe(true);
  });

  it("should not call summarizer if no messages need to be dropped", async () => {
    const messages: LLMMessage[] = [
      { role: "system", content: "System" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const summarize = vi.fn(async () => "Summary");

    const result = await manager.fitWithSummary(messages, summarize);

    expect(summarize).not.toHaveBeenCalled();
    expect(result).toEqual(messages);
  });
});
