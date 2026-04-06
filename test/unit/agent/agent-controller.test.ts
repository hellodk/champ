/**
 * TDD: Tests for AgentController.
 * The single-agent loop: receives message, calls LLM, executes tools, loops.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentController } from "@/agent/agent-controller";
import type { LLMProvider, StreamDelta, LLMMessage } from "@/providers/types";
import type { ToolRegistry } from "@/tools/registry";

function createMockProvider(responses: StreamDelta[][]): LLMProvider {
  let callIdx = 0;
  return {
    name: "mock",
    config: {
      provider: "mock",
      model: "test",
      maxTokens: 1024,
      temperature: 0.7,
    },
    chat: vi.fn().mockImplementation(async function* () {
      const deltas = responses[callIdx] || responses[responses.length - 1];
      callIdx++;
      for (const delta of deltas) {
        yield delta;
      }
    }),
    complete: vi.fn(),
    supportsToolUse: () => true,
    supportsStreaming: () => true,
    countTokens: () => 10,
    modelInfo: () => ({
      id: "test",
      name: "Test",
      provider: "mock",
      contextWindow: 4096,
      maxOutputTokens: 1024,
      supportsToolUse: true,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: vi.fn(),
  } as unknown as LLMProvider;
}

function createMockToolRegistry(): ToolRegistry {
  return {
    getAll: vi.fn().mockReturnValue([]),
    getDefinitions: vi.fn().mockReturnValue([]),
    get: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    execute: vi
      .fn()
      .mockResolvedValue({ success: true, output: "tool result" }),
  } as unknown as ToolRegistry;
}

describe("AgentController", () => {
  let controller: AgentController;
  let mockProvider: LLMProvider;
  let mockToolRegistry: ToolRegistry;

  it("should process a simple text response (no tool calls)", async () => {
    mockProvider = createMockProvider([
      [
        { type: "text", text: "Hello! " },
        { type: "text", text: "How can I help?" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ]);
    mockToolRegistry = createMockToolRegistry();
    controller = new AgentController(mockProvider, mockToolRegistry);

    const result = await controller.processMessage("Hello");
    expect(result.text).toContain("Hello!");
    expect(result.text).toContain("How can I help?");
    expect(result.toolCalls).toHaveLength(0);
  });

  it("should execute tool calls and loop back to LLM", async () => {
    mockProvider = createMockProvider([
      // First response: tool call
      [
        { type: "text", text: "Let me read that." },
        {
          type: "tool_call_start",
          toolCall: {
            id: "c1",
            name: "read_file",
            arguments: { path: "test.ts" },
          },
        },
        { type: "tool_call_end" },
        { type: "done", usage: { inputTokens: 20, outputTokens: 10 } },
      ],
      // Second response: final text
      [
        { type: "text", text: "The file contains a test." },
        { type: "done", usage: { inputTokens: 30, outputTokens: 15 } },
      ],
    ]);
    mockToolRegistry = createMockToolRegistry();
    controller = new AgentController(mockProvider, mockToolRegistry);

    const result = await controller.processMessage("Read test.ts");
    expect(mockToolRegistry.execute).toHaveBeenCalledWith(
      "read_file",
      { path: "test.ts" },
      expect.anything(),
    );
    expect(result.text).toContain("file contains a test");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("should limit tool call iterations to prevent infinite loops", async () => {
    // Provider always returns tool calls
    const toolCallResponse: StreamDelta[] = [
      {
        type: "tool_call_start",
        toolCall: { id: "c1", name: "read_file", arguments: { path: "x" } },
      },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
    ];
    mockProvider = createMockProvider(Array(50).fill(toolCallResponse));
    mockToolRegistry = createMockToolRegistry();
    controller = new AgentController(mockProvider, mockToolRegistry);

    const result = await controller.processMessage("Do something");
    // Should stop after max iterations (default 25)
    const executeCalls = (mockToolRegistry.execute as ReturnType<typeof vi.fn>)
      .mock.calls;
    expect(executeCalls.length).toBeLessThanOrEqual(25);
  });

  it("should handle abort signal", async () => {
    const abortController = new AbortController();
    mockProvider = createMockProvider([
      [
        { type: "text", text: "Starting..." },
        { type: "text", text: " working..." },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ]);
    mockToolRegistry = createMockToolRegistry();
    controller = new AgentController(mockProvider, mockToolRegistry);

    abortController.abort();
    const result = await controller.processMessage("Hello", {
      abortSignal: abortController.signal,
    });
    // Should handle gracefully when aborted
    expect(result).toBeDefined();
  });

  it("should maintain conversation history", async () => {
    mockProvider = createMockProvider([
      [
        { type: "text", text: "First response" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 3 } },
      ],
      [
        { type: "text", text: "Second response" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ]);
    mockToolRegistry = createMockToolRegistry();
    controller = new AgentController(mockProvider, mockToolRegistry);

    await controller.processMessage("First");
    await controller.processMessage("Second");

    const history = controller.getHistory();
    expect(history.length).toBeGreaterThanOrEqual(4); // 2 user + 2 assistant
  });

  it("should clear conversation history on reset", async () => {
    mockProvider = createMockProvider([
      [
        { type: "text", text: "Response" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 3 } },
      ],
    ]);
    mockToolRegistry = createMockToolRegistry();
    controller = new AgentController(mockProvider, mockToolRegistry);

    await controller.processMessage("Hello");
    controller.reset();
    expect(controller.getHistory()).toHaveLength(0);
  });

  it("should emit events for streaming text", async () => {
    mockProvider = createMockProvider([
      [
        { type: "text", text: "Hello" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
      ],
    ]);
    mockToolRegistry = createMockToolRegistry();
    controller = new AgentController(mockProvider, mockToolRegistry);

    const textChunks: string[] = [];
    controller.onStreamDelta((delta) => {
      if (delta.type === "text" && delta.text) textChunks.push(delta.text);
    });

    await controller.processMessage("Hi");
    expect(textChunks).toContain("Hello");
  });
});
