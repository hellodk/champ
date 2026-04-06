/**
 * TDD: Tests for LLM Provider type contracts.
 * These tests validate that provider implementations conform to the LLMProvider interface.
 */
import { describe, it, expect } from "vitest";

// These imports will fail until the types are implemented
import type {
  LLMProvider,
  LLMProviderConfig,
  LLMMessage,
  ContentBlock,
  ToolDefinition,
  ToolCall,
  StreamDelta,
  ModelInfo,
  ChatOptions,
  CompleteOptions,
  TokenUsage,
} from "@/providers/types";

describe("LLMProvider Types", () => {
  describe("LLMProviderConfig", () => {
    it("should define required fields: provider, model", () => {
      const config: LLMProviderConfig = {
        provider: "claude",
        model: "claude-sonnet-4-20250514",
        maxTokens: 4096,
        temperature: 0.7,
      };
      expect(config.provider).toBe("claude");
      expect(config.model).toBe("claude-sonnet-4-20250514");
      expect(config.maxTokens).toBe(4096);
      expect(config.temperature).toBe(0.7);
    });

    it("should support optional fields: apiKey, baseUrl, topP", () => {
      const config: LLMProviderConfig = {
        provider: "ollama",
        model: "llama3.1",
        maxTokens: 2048,
        temperature: 0.5,
        apiKey: undefined,
        baseUrl: "http://localhost:11434",
        topP: 0.9,
      };
      expect(config.baseUrl).toBe("http://localhost:11434");
      expect(config.apiKey).toBeUndefined();
      expect(config.topP).toBe(0.9);
    });
  });

  describe("LLMMessage", () => {
    it("should support text content with role", () => {
      const msg: LLMMessage = {
        role: "user",
        content: "Hello, world!",
      };
      expect(msg.role).toBe("user");
      expect(msg.content).toBe("Hello, world!");
    });

    it("should support array content blocks", () => {
      const msg: LLMMessage = {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          { type: "image", imageData: "base64data", mimeType: "image/png" },
        ],
      };
      expect(Array.isArray(msg.content)).toBe(true);
      expect((msg.content as ContentBlock[])[0].type).toBe("text");
      expect((msg.content as ContentBlock[])[1].type).toBe("image");
    });

    it("should support tool_use role with toolCallId", () => {
      const msg: LLMMessage = {
        role: "tool",
        content: "File contents here",
        toolCallId: "call_123",
      };
      expect(msg.role).toBe("tool");
      expect(msg.toolCallId).toBe("call_123");
    });

    it("should support assistant messages with tool calls", () => {
      const msg: LLMMessage = {
        role: "assistant",
        content: "Let me read that file.",
        toolCalls: [
          {
            id: "call_123",
            name: "read_file",
            arguments: { path: "src/main.ts" },
          },
        ],
      };
      expect(msg.toolCalls).toHaveLength(1);
      expect(msg.toolCalls![0].name).toBe("read_file");
    });
  });

  describe("StreamDelta", () => {
    it("should represent text deltas", () => {
      const delta: StreamDelta = {
        type: "text",
        text: "Hello",
      };
      expect(delta.type).toBe("text");
      expect(delta.text).toBe("Hello");
    });

    it("should represent tool call starts", () => {
      const delta: StreamDelta = {
        type: "tool_call_start",
        toolCall: { id: "call_1", name: "read_file", arguments: {} },
      };
      expect(delta.type).toBe("tool_call_start");
      expect(delta.toolCall!.name).toBe("read_file");
    });

    it("should represent done with usage", () => {
      const delta: StreamDelta = {
        type: "done",
        usage: { inputTokens: 100, outputTokens: 50 },
      };
      expect(delta.type).toBe("done");
      expect(delta.usage!.inputTokens).toBe(100);
    });

    it("should represent errors", () => {
      const delta: StreamDelta = {
        type: "error",
        error: "Rate limit exceeded",
      };
      expect(delta.type).toBe("error");
      expect(delta.error).toBe("Rate limit exceeded");
    });
  });

  describe("ToolDefinition", () => {
    it("should define name, description, and JSON Schema parameters", () => {
      const tool: ToolDefinition = {
        name: "read_file",
        description: "Read a file from the workspace",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path" },
          },
          required: ["path"],
        },
      };
      expect(tool.name).toBe("read_file");
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.required).toContain("path");
    });
  });

  describe("ModelInfo", () => {
    it("should contain model metadata", () => {
      const info: ModelInfo = {
        id: "claude-sonnet-4-20250514",
        name: "Claude Sonnet 4",
        provider: "claude",
        contextWindow: 200000,
        maxOutputTokens: 8192,
        supportsToolUse: true,
        supportsImages: true,
        supportsStreaming: true,
      };
      expect(info.contextWindow).toBe(200000);
      expect(info.supportsToolUse).toBe(true);
    });
  });

  describe("ChatOptions", () => {
    it("should support tools, abortSignal, and overrides", () => {
      const controller = new AbortController();
      const options: ChatOptions = {
        tools: [
          {
            name: "test",
            description: "test tool",
            parameters: { type: "object", properties: {}, required: [] },
          },
        ],
        abortSignal: controller.signal,
        temperature: 0.5,
        maxTokens: 1024,
      };
      expect(options.tools).toHaveLength(1);
      expect(options.abortSignal).toBeDefined();
    });
  });
});
