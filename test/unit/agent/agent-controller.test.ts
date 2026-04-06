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

  describe("prompt-based tool calling fallback", () => {
    /**
     * Build a provider that mimics a non-tool-calling local model:
     * - supportsToolUse() returns false
     * - chat() yields text containing <tool_call> XML blocks
     * The agent loop should parse those blocks, execute the tools, and
     * feed results back as <tool_result> messages on the next turn.
     */
    function createPromptBasedProvider(textChunks: string[]): LLMProvider {
      let callIdx = 0;
      return {
        name: "mock-local",
        config: {
          provider: "mock-local",
          model: "test",
          maxTokens: 1024,
          temperature: 0.7,
        },
        chat: vi.fn().mockImplementation(async function* () {
          const text = textChunks[callIdx] ?? textChunks[textChunks.length - 1];
          callIdx++;
          yield { type: "text", text };
          yield {
            type: "done",
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }),
        complete: vi.fn(),
        supportsToolUse: () => false,
        supportsStreaming: () => true,
        countTokens: () => 10,
        modelInfo: () => ({
          id: "test",
          name: "Test",
          provider: "mock-local",
          contextWindow: 4096,
          maxOutputTokens: 1024,
          supportsToolUse: false,
          supportsImages: false,
          supportsStreaming: true,
        }),
        dispose: vi.fn(),
      } as unknown as LLMProvider;
    }

    function createToolRegistryWithReadFile(): ToolRegistry {
      return {
        getAll: vi.fn().mockReturnValue([]),
        getDefinitions: vi.fn().mockReturnValue([
          {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: { path: { type: "string", description: "Path" } },
              required: ["path"],
            },
          },
        ]),
        get: vi.fn(),
        register: vi.fn(),
        unregister: vi.fn(),
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "file contents: hello world",
        }),
      } as unknown as ToolRegistry;
    }

    it("should parse <tool_call> XML blocks from non-tool-calling provider", async () => {
      const provider = createPromptBasedProvider([
        // First response: a tool_call wrapped in some prose.
        `Sure, I'll read that file.
<tool_call>
<name>read_file</name>
<arguments>{"path":"main.ts"}</arguments>
</tool_call>`,
        // Second response: final text after the tool result is fed back.
        `The file says hello world.`,
      ]);
      const registry = createToolRegistryWithReadFile();
      const controller = new AgentController(provider, registry);

      const result = await controller.processMessage("Read main.ts");

      // The tool was actually executed.
      expect(registry.execute).toHaveBeenCalledWith(
        "read_file",
        { path: "main.ts" },
        expect.any(Object),
      );
      expect(result.toolCalls.length).toBe(1);
      expect(result.toolCalls[0].call.name).toBe("read_file");
      // The XML noise was stripped from the user-visible text.
      expect(result.text).not.toContain("<tool_call>");
      expect(result.text).toContain("hello world");
    });

    it("should send tool result back as user <tool_result> on next turn", async () => {
      const provider = createPromptBasedProvider([
        `<tool_call>
<name>read_file</name>
<arguments>{"path":"a.ts"}</arguments>
</tool_call>`,
        `Done.`,
      ]);
      const registry = createToolRegistryWithReadFile();
      const controller = new AgentController(provider, registry);

      await controller.processMessage("Read a.ts");

      // The history should now contain: user → assistant(with tool_call)
      // → user(with <tool_result>) → assistant(final text).
      const history = controller.getHistory();
      const toolResultUser = history.find(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("<tool_result"),
      );
      expect(toolResultUser).toBeDefined();
    });

    it("should inject tool definitions into a system message", async () => {
      const provider = createPromptBasedProvider([`No tool needed.`]);
      const registry = createToolRegistryWithReadFile();
      const controller = new AgentController(provider, registry);

      await controller.processMessage("Hi");

      // Inspect what was sent to provider.chat() — first arg is messages.
      const chatCalls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
      expect(chatCalls.length).toBeGreaterThan(0);
      const sentMessages = chatCalls[0][0] as LLMMessage[];
      const systemMsg = sentMessages.find((m) => m.role === "system");
      expect(systemMsg).toBeDefined();
      const sysContent =
        typeof systemMsg!.content === "string" ? systemMsg!.content : "";
      // The base instructions should be present.
      expect(sysContent).toContain("AIDev");
      // The tool catalog should be in there.
      expect(sysContent).toContain("read_file");
      // The XML format spec should be there.
      expect(sysContent).toContain("<tool_call>");
    });

    it("should fall through cleanly when the model does not call any tools", async () => {
      const provider = createPromptBasedProvider([
        `Hello! How can I help you today?`,
      ]);
      const registry = createToolRegistryWithReadFile();
      const controller = new AgentController(provider, registry);

      const result = await controller.processMessage("Hi");
      expect(result.toolCalls).toHaveLength(0);
      expect(result.text).toContain("Hello");
      expect(registry.execute).not.toHaveBeenCalled();
    });
  });
});
