/**
 * TDD: Tests for ContextWindowManager.
 * Validates token counting, message truncation, and context fitting.
 */
import { describe, it, expect, beforeEach } from "vitest";
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
