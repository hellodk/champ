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

    it("should include anti-hallucination directives in the system prompt", async () => {
      // The system prompt must contain specific directives that prevent
      // the model from inventing functions, file paths, or claiming
      // actions it didn't perform. See docs/HALLUCINATION_MITIGATION.md.
      const provider = createPromptBasedProvider([`ok.`]);
      const registry = createToolRegistryWithReadFile();
      const controller = new AgentController(provider, registry);

      await controller.processMessage("Hi");

      const chatCalls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
      const sentMessages = chatCalls[0][0] as LLMMessage[];
      const systemMsg = sentMessages.find((m) => m.role === "system");
      const sys =
        typeof systemMsg!.content === "string" ? systemMsg!.content : "";

      // Verify-before-claim rule
      expect(sys.toLowerCase()).toContain("verify");
      // Never invent rule
      expect(sys.toLowerCase()).toMatch(/do not invent|never invent/);
      // Read-before-edit rule
      expect(sys.toLowerCase()).toMatch(/read.*before.*edit|read_file/);
      // Few-shot examples present
      expect(sys.toLowerCase()).toMatch(/wrong response|correct response/);
    });
  });

  describe("repo map grounding", () => {
    it("should inject the repo map into the system prompt when a provider is attached", async () => {
      const provider = createMockProvider([
        [
          { type: "text", text: "hi" },
          { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);
      const registry = createMockToolRegistry();
      const controller = new AgentController(provider, registry);

      controller.setRepoMapProvider({
        getRepoMap: vi
          .fn()
          .mockResolvedValue(
            "# Workspace outline\nsrc/auth.ts:\n  class AuthService\n",
          ),
      });

      await controller.processMessage("hello");

      const chatCalls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
      const sentMessages = chatCalls[0][0] as LLMMessage[];
      const systemMsg = sentMessages.find((m) => m.role === "system");
      expect(systemMsg).toBeDefined();
      const sys =
        typeof systemMsg!.content === "string" ? systemMsg!.content : "";
      expect(sys).toContain("Workspace outline");
      expect(sys).toContain("AuthService");
    });

    it("should fetch the repo map only once per session and cache it", async () => {
      const provider = createMockProvider([
        [
          { type: "text", text: "first" },
          { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
        ],
        [
          { type: "text", text: "second" },
          { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);
      const registry = createMockToolRegistry();
      const controller = new AgentController(provider, registry);

      const getRepoMap = vi.fn().mockResolvedValue("# map\n");
      controller.setRepoMapProvider({ getRepoMap });

      await controller.processMessage("one");
      await controller.processMessage("two");

      // Cached: getRepoMap should only have been called once.
      expect(getRepoMap).toHaveBeenCalledTimes(1);
    });

    it("should re-fetch the repo map after reset()", async () => {
      const provider = createMockProvider([
        [
          { type: "text", text: "ok" },
          { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);
      const registry = createMockToolRegistry();
      const controller = new AgentController(provider, registry);

      const getRepoMap = vi.fn().mockResolvedValue("# map\n");
      controller.setRepoMapProvider({ getRepoMap });

      await controller.processMessage("one");
      controller.reset();
      await controller.processMessage("two");

      expect(getRepoMap).toHaveBeenCalledTimes(2);
    });

    it("should handle repo map provider errors gracefully", async () => {
      const provider = createMockProvider([
        [
          { type: "text", text: "ok" },
          { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);
      const registry = createMockToolRegistry();
      const controller = new AgentController(provider, registry);

      controller.setRepoMapProvider({
        getRepoMap: vi.fn().mockRejectedValue(new Error("filesystem error")),
      });

      // Should not throw, just proceed without the map.
      const result = await controller.processMessage("hi");
      expect(result.text).toBeDefined();
    });
  });

  describe("mode enforcement", () => {
    /**
     * Build a tool registry with the standard 4 read-only tools and the
     * standard 4 write/exec tools so we can verify per-mode filtering.
     */
    function createFullToolRegistry(): ToolRegistry {
      const allDefs = [
        {
          name: "read_file",
          description: "Read",
          parameters: { type: "object" as const, properties: {}, required: [] },
        },
        {
          name: "list_directory",
          description: "List",
          parameters: { type: "object" as const, properties: {}, required: [] },
        },
        {
          name: "grep_search",
          description: "Grep",
          parameters: { type: "object" as const, properties: {}, required: [] },
        },
        {
          name: "file_search",
          description: "Find",
          parameters: { type: "object" as const, properties: {}, required: [] },
        },
        {
          name: "edit_file",
          description: "Edit",
          parameters: { type: "object" as const, properties: {}, required: [] },
        },
        {
          name: "create_file",
          description: "Create",
          parameters: { type: "object" as const, properties: {}, required: [] },
        },
        {
          name: "delete_file",
          description: "Delete",
          parameters: { type: "object" as const, properties: {}, required: [] },
        },
        {
          name: "run_terminal_cmd",
          description: "Run",
          parameters: { type: "object" as const, properties: {}, required: [] },
        },
      ];
      return {
        getAll: vi.fn().mockReturnValue([]),
        getDefinitions: vi.fn().mockReturnValue(allDefs),
        get: vi.fn(),
        register: vi.fn(),
        unregister: vi.fn(),
        execute: vi.fn().mockResolvedValue({
          success: false,
          output: "tool execution blocked by mode",
        }),
      } as unknown as ToolRegistry;
    }

    it("should send all tools to the model in agent mode", async () => {
      const provider = createMockProvider([
        [
          { type: "text", text: "ok" },
          { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);
      const registry = createFullToolRegistry();
      const controller = new AgentController(provider, registry);
      controller.setMode("agent");

      await controller.processMessage("hi");

      const chatCalls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
      const options = chatCalls[0][1] as { tools?: Array<{ name: string }> };
      const toolNames = (options.tools ?? []).map((t) => t.name);
      // All 8 tools should be available in agent mode.
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("edit_file");
      expect(toolNames).toContain("run_terminal_cmd");
      expect(toolNames).toHaveLength(8);
    });

    it("should restrict to read-only tools in ask mode", async () => {
      const provider = createMockProvider([
        [
          { type: "text", text: "ok" },
          { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);
      const registry = createFullToolRegistry();
      const controller = new AgentController(provider, registry);
      controller.setMode("ask");

      await controller.processMessage("how does auth work?");

      const chatCalls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
      const options = chatCalls[0][1] as { tools?: Array<{ name: string }> };
      const toolNames = (options.tools ?? []).map((t) => t.name);
      // Read-only tools allowed
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("grep_search");
      expect(toolNames).toContain("file_search");
      expect(toolNames).toContain("list_directory");
      // Write/exec tools blocked
      expect(toolNames).not.toContain("edit_file");
      expect(toolNames).not.toContain("create_file");
      expect(toolNames).not.toContain("delete_file");
      expect(toolNames).not.toContain("run_terminal_cmd");
    });

    it("should restrict to read-only tools in plan mode", async () => {
      const provider = createMockProvider([
        [
          { type: "text", text: "Plan: ..." },
          { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);
      const registry = createFullToolRegistry();
      const controller = new AgentController(provider, registry);
      controller.setMode("plan");

      await controller.processMessage("plan a refactor");

      const chatCalls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
      const options = chatCalls[0][1] as { tools?: Array<{ name: string }> };
      const toolNames = (options.tools ?? []).map((t) => t.name);
      expect(toolNames).not.toContain("edit_file");
      expect(toolNames).not.toContain("create_file");
      expect(toolNames).not.toContain("delete_file");
      expect(toolNames).not.toContain("run_terminal_cmd");
    });

    it("should reflect the current mode in the system prompt", async () => {
      const provider = createMockProvider([
        [
          { type: "text", text: "ok" },
          { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);
      const registry = createFullToolRegistry();
      const controller = new AgentController(provider, registry);
      controller.setMode("ask");

      await controller.processMessage("hi");

      const chatCalls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
      const sentMessages = chatCalls[0][0] as LLMMessage[];
      const systemMsg = sentMessages.find((m) => m.role === "system");
      const sys =
        typeof systemMsg!.content === "string" ? systemMsg!.content : "";
      // Ask-mode system prompt should mention read-only / no edits.
      expect(sys.toLowerCase()).toMatch(
        /read[- ]only|do not (edit|modify|use edit_file)/,
      );
    });

    it("should default to agent mode when no mode is set", async () => {
      const provider = createMockProvider([
        [
          { type: "text", text: "ok" },
          { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
        ],
      ]);
      const registry = createFullToolRegistry();
      const controller = new AgentController(provider, registry);
      // No setMode() call

      await controller.processMessage("hi");

      const chatCalls = (provider.chat as ReturnType<typeof vi.fn>).mock.calls;
      const options = chatCalls[0][1] as { tools?: Array<{ name: string }> };
      const toolNames = (options.tools ?? []).map((t) => t.name);
      // All tools available by default.
      expect(toolNames).toHaveLength(8);
    });
  });

  describe("secret redaction in tool results", () => {
    /**
     * Build a registry whose execute() returns a result containing a
     * realistic-looking API key. AgentController should redact it
     * before storing it in history (so it never reaches the LLM on
     * the next turn).
     */
    function createRegistryWithSecretLeakingTool(): ToolRegistry {
      return {
        getAll: vi.fn().mockReturnValue([]),
        getDefinitions: vi.fn().mockReturnValue([
          {
            name: "read_file",
            description: "Read",
            parameters: {
              type: "object" as const,
              properties: {},
              required: [],
            },
          },
        ]),
        get: vi.fn(),
        register: vi.fn(),
        unregister: vi.fn(),
        execute: vi.fn().mockResolvedValue({
          success: true,
          output:
            "loaded .env\nANTHROPIC_API_KEY=sk-ant-api03-realleakingsecret\nDONE",
        }),
      } as unknown as ToolRegistry;
    }

    it("should redact secrets from tool output before storing in history", async () => {
      // Provider that emits one tool call, then a final text response.
      const provider = createMockProvider([
        [
          {
            type: "tool_call_start",
            toolCall: {
              id: "c1",
              name: "read_file",
              arguments: { path: ".env" },
            },
          },
          { type: "tool_call_end" },
          { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
        ],
        [
          { type: "text", text: "Done." },
          { type: "done", usage: { inputTokens: 20, outputTokens: 5 } },
        ],
      ]);
      const registry = createRegistryWithSecretLeakingTool();
      const controller = new AgentController(provider, registry);

      await controller.processMessage("read .env");

      // Inspect the conversation history: the tool result should NOT
      // contain the raw secret. It should be redacted.
      const history = controller.getHistory();
      const allContent = history
        .map((m) => {
          if (typeof m.content === "string") return m.content;
          return JSON.stringify(m.content);
        })
        .join("\n");

      expect(allContent).not.toContain("sk-ant-api03-realleakingsecret");
      expect(allContent).toContain("[REDACTED]");
    });

    it("should redact secrets in prompt-based mode tool result blocks too", async () => {
      // Non-tool-calling provider that emits a tool call as XML.
      const provider = {
        name: "mock-local",
        config: {
          provider: "mock-local",
          model: "test",
          maxTokens: 1024,
          temperature: 0.7,
        },
        chat: vi
          .fn()
          .mockImplementationOnce(async function* () {
            yield {
              type: "text",
              text: `<tool_call>
<name>read_file</name>
<arguments>{"path":".env"}</arguments>
</tool_call>`,
            };
            yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
          })
          .mockImplementationOnce(async function* () {
            yield { type: "text", text: "ok" };
            yield { type: "done", usage: { inputTokens: 5, outputTokens: 2 } };
          }),
        complete: vi.fn(),
        supportsToolUse: () => false,
        supportsStreaming: () => true,
        countTokens: () => 10,
        modelInfo: () => ({
          id: "test",
          name: "test",
          provider: "mock-local",
          contextWindow: 4096,
          maxOutputTokens: 1024,
          supportsToolUse: false,
          supportsImages: false,
          supportsStreaming: true,
        }),
        dispose: vi.fn(),
      } as unknown as LLMProvider;

      const registry = createRegistryWithSecretLeakingTool();
      const controller = new AgentController(provider, registry);

      await controller.processMessage("read .env");

      const history = controller.getHistory();
      const allContent = history
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .join("\n");

      expect(allContent).not.toContain("sk-ant-api03-realleakingsecret");
      expect(allContent).toContain("[REDACTED]");
    });
  });
});
