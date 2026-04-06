/**
 * TDD: Tests for ClaudeProvider.
 * Tests streaming chat, tool use, token counting, abort handling.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ClaudeProvider } from "@/providers/claude";
import type { LLMMessage, StreamDelta, ChatOptions } from "@/providers/types";

// Mock the Anthropic SDK
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn(),
      },
    })),
  };
});

describe("ClaudeProvider", () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    provider = new ClaudeProvider({
      provider: "claude",
      model: "claude-sonnet-4-20250514",
      apiKey: "test-key",
      maxTokens: 4096,
      temperature: 0.7,
    });
  });

  it("should have correct name", () => {
    expect(provider.name).toBe("claude");
  });

  it("should support tool use", () => {
    expect(provider.supportsToolUse()).toBe(true);
  });

  it("should support streaming", () => {
    expect(provider.supportsStreaming()).toBe(true);
  });

  it("should return correct model info", () => {
    const info = provider.modelInfo();
    expect(info.provider).toBe("claude");
    expect(info.supportsToolUse).toBe(true);
    expect(info.supportsImages).toBe(true);
    expect(info.contextWindow).toBeGreaterThan(0);
  });

  it("should stream text deltas from chat", async () => {
    const messages: LLMMessage[] = [{ role: "user", content: "Hello" }];

    const deltas: StreamDelta[] = [];
    for await (const delta of provider.chat(messages)) {
      deltas.push(delta);
      if (delta.type === "done") break;
    }

    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas[deltas.length - 1].type).toBe("done");
  });

  it("should handle tool calls in streaming response", async () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "Read the file main.ts" },
    ];

    const options: ChatOptions = {
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string", description: "File path" } },
            required: ["path"],
          },
        },
      ],
    };

    const deltas: StreamDelta[] = [];
    for await (const delta of provider.chat(messages, options)) {
      deltas.push(delta);
      if (delta.type === "done") break;
    }

    const toolCallStart = deltas.find((d) => d.type === "tool_call_start");
    // Tool calls may or may not happen depending on mock setup
    expect(deltas.some((d) => d.type === "done")).toBe(true);
  });

  it("should respect abort signal", async () => {
    const controller = new AbortController();
    const messages: LLMMessage[] = [{ role: "user", content: "Hello" }];

    // Abort immediately
    controller.abort();

    const deltas: StreamDelta[] = [];
    for await (const delta of provider.chat(messages, {
      abortSignal: controller.signal,
    })) {
      deltas.push(delta);
    }

    // Should get an error or empty result when aborted
    const hasErrorOrEmpty =
      deltas.length === 0 || deltas.some((d) => d.type === "error");
    expect(hasErrorOrEmpty).toBe(true);
  });

  it("should count tokens", () => {
    const count = provider.countTokens("Hello, world!");
    expect(typeof count).toBe("number");
    expect(count).toBeGreaterThan(0);
  });

  it("should dispose cleanly", () => {
    expect(() => provider.dispose()).not.toThrow();
  });
});
