import { describe, it, expect } from "vitest";
import { TeamAgent } from "@/agent/team-agent";
import { SharedMemory } from "@/agent/shared-memory";
import type { LLMMessage } from "@/providers/types";

const agentDef = {
  id: "test-agent",
  name: "Test",
  role: "Tester",
  systemPrompt: "You are a test agent.",
  dependsOn: [] as string[],
  condition: "",
  tools: [] as string[],
  model: "",
  maxTokens: 100,
  outputKey: "test",
  outputFormat: "text" as const,
  selfCritique: false,
};

describe("TeamAgent — context overflow", () => {
  it("trims contextText when total messages exceed model context window", async () => {
    let capturedMessages: LLMMessage[] = [];

    const fakeProvider = {
      name: "tiny",
      config: { provider: "tiny" as const, model: "tiny" },
      chat: async function* (msgs: LLMMessage[]) {
        capturedMessages = msgs;
        yield { type: "text" as const, text: "<output>ok</output>" };
        yield {
          type: "done" as const,
          usage: { inputTokens: 5, outputTokens: 2 },
        };
      },
      complete: async function* () {},
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      // 1 token = 4 chars approximation
      countTokens: (text: string) => Math.ceil(text.length / 4),
      // Tiny context: 50 tokens total
      modelInfo: () => ({
        contextWindow: 50,
        name: "tiny",
        provider: "tiny" as const,
      }),
      dispose: () => {},
    };

    const agent = new TeamAgent(agentDef, fakeProvider as any);
    const memory = new SharedMemory();

    // Large context that exceeds the window
    // "You are test-agent: Tester\n..." system prompt is ~60 chars (~15 tokens)
    // "You are a test agent." resolved prompt ~22 chars (~6 tokens)
    // Together with user msg, a 1000-char context (~250 tokens) vastly exceeds budget of 50
    const largeContextItem = {
      filePath: "big.ts",
      startLine: 1,
      endLine: 500,
      text: "X".repeat(800), // ~200 tokens — far over budget
    };

    await agent.execute(
      { userRequest: "summarize", context: [largeContextItem] },
      memory,
    );

    // The user message should be trimmed
    const userMsg = capturedMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    // Original: "summarize" + "\n\n# Workspace context\n\n// big.ts:1-500\n" + "X"*800
    // ≈ 860 chars ≈ 215 tokens — way over 50-token budget
    // After trim: must be under ~200 chars to fit in 50 tokens
    expect((userMsg!.content as string).length).toBeLessThan(250);
  });

  it("does not trim when messages fit within context window", async () => {
    let capturedMessages: LLMMessage[] = [];

    const fakeProvider = {
      name: "big",
      config: { provider: "big" as const, model: "big" },
      chat: async function* (msgs: LLMMessage[]) {
        capturedMessages = msgs;
        yield { type: "text" as const, text: "<output>ok</output>" };
        yield {
          type: "done" as const,
          usage: { inputTokens: 5, outputTokens: 2 },
        };
      },
      complete: async function* () {},
      supportsToolUse: () => false,
      supportsStreaming: () => true,
      countTokens: (text: string) => Math.ceil(text.length / 4),
      // Large context: 100K tokens
      modelInfo: () => ({
        contextWindow: 100_000,
        name: "big",
        provider: "big" as const,
      }),
      dispose: () => {},
    };

    const agent = new TeamAgent(agentDef, fakeProvider as any);
    const memory = new SharedMemory();

    const originalRequest = "summarize this";
    await agent.execute({ userRequest: originalRequest, context: [] }, memory);

    const userMsg = capturedMessages.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    // No context, no trim — user message should start with the original request
    expect((userMsg!.content as string).startsWith(originalRequest)).toBe(true);
  });
});
