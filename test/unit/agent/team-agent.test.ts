import { describe, it, expect, vi } from "vitest";
import { TeamAgent } from "@/agent/team-agent";
import { SharedMemory } from "@/agent/shared-memory";
import { ToolRegistry } from "@/tools/registry";
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

// --- Shared provider factory for approval tests ---
function makeToolProvider(
  toolCallName: string,
  toolCallArgs: Record<string, unknown>,
) {
  let callCount = 0;
  return {
    name: "tool-provider",
    config: { provider: "tool-provider" as const, model: "tool-provider" },
    chat: async function* (_msgs: LLMMessage[], _opts?: { tools?: unknown[] }) {
      callCount++;
      if (callCount === 1) {
        // First call: emit tool_call_start (empty args) + tool_call_end to flush
        yield {
          type: "tool_call_start" as const,
          toolCall: {
            id: "call-1",
            name: toolCallName,
            arguments: {},
          },
        };
        // tool_call_delta with JSON-serialized args
        yield {
          type: "tool_call_delta" as const,
          argumentsDelta: JSON.stringify(toolCallArgs),
        };
        yield { type: "tool_call_end" as const };
        yield {
          type: "done" as const,
          usage: { inputTokens: 10, outputTokens: 5 },
        };
      } else {
        // Second call (after tool result): return final text
        yield { type: "text" as const, text: "done" };
        yield {
          type: "done" as const,
          usage: { inputTokens: 5, outputTokens: 2 },
        };
      }
    },
    complete: async function* () {},
    supportsToolUse: () => true,
    supportsStreaming: () => true,
    countTokens: (text: string) => Math.ceil(text.length / 4),
    modelInfo: () => ({
      contextWindow: 100_000,
      name: "tool-provider",
      provider: "tool-provider" as const,
    }),
    dispose: () => {},
  };
}

const toolAgentDef = {
  id: "tool-agent",
  name: "Tool Agent",
  role: "Tool Runner",
  systemPrompt: "You are a tool agent.",
  dependsOn: [] as string[],
  condition: "",
  tools: ["noop_tool"],
  model: "",
  maxTokens: 100,
  outputKey: "tool_output",
  outputFormat: "text" as const,
  selfCritique: false,
  subscribes: [] as string[],
};

describe("TeamAgent — requestApproval callback", () => {
  function makeToolRegistry(requiresApproval = true): ToolRegistry {
    const registry = new ToolRegistry();
    registry.register({
      name: "noop_tool",
      description: "A noop tool for testing",
      parameters: {
        type: "object" as const,
        properties: {},
        required: [],
      },
      requiresApproval,
      execute: vi.fn(async () => ({ success: true, output: "noop result" })),
    });
    return registry;
  }

  it("calls the approval callback when one is provided", async () => {
    const approvalCallback = vi.fn(async (_description: string) => true);

    const fakeProvider = makeToolProvider("noop_tool", {});
    const registry = makeToolRegistry(true);

    const agent = new TeamAgent(
      toolAgentDef,
      fakeProvider as any,
      undefined,
      registry,
      undefined,
      approvalCallback,
    );

    const memory = new SharedMemory();
    await agent.execute({ userRequest: "run the tool", context: [] }, memory);

    // The approval callback must have been invoked because the tool requiresApproval
    expect(approvalCallback).toHaveBeenCalled();
    // The description arg must be a non-empty string
    const firstCall = approvalCallback.mock.calls[0];
    expect(typeof firstCall[0]).toBe("string");
    expect(firstCall[0].length).toBeGreaterThan(0);
  });

  it("auto-approves when no callback provided (backward compat)", async () => {
    const fakeProvider = makeToolProvider("noop_tool", {});
    const registry = makeToolRegistry(true);

    // No 6th argument — backward compat path
    const agent = new TeamAgent(
      toolAgentDef,
      fakeProvider as any,
      undefined,
      registry,
      undefined,
      // no requestApprovalCallback
    );

    const memory = new SharedMemory();
    // Should not throw — tool should execute, auto-approved via async () => true
    const output = await agent.execute(
      { userRequest: "run the tool", context: [] },
      memory,
    );
    expect(output.success).toBe(true);
  });
});
