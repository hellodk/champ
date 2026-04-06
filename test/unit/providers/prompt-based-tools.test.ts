/**
 * TDD: Tests for PromptBasedToolProvider.
 * Wraps non-tool-calling models with XML tool injection and parsing.
 */
import { describe, it, expect } from "vitest";
import {
  injectToolsIntoPrompt,
  parseToolCallsFromText,
} from "@/providers/prompt-based-tools";
import type { ToolDefinition, ToolCall } from "@/providers/types";

describe("PromptBasedToolProvider", () => {
  const sampleTools: ToolDefinition[] = [
    {
      name: "read_file",
      description: "Read a file from the workspace",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path" } },
        required: ["path"],
      },
    },
    {
      name: "edit_file",
      description: "Edit a file",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          old_content: { type: "string", description: "Content to replace" },
          new_content: { type: "string", description: "Replacement content" },
        },
        required: ["path", "old_content", "new_content"],
      },
    },
  ];

  describe("injectToolsIntoPrompt", () => {
    it("should inject tool definitions as XML into the system prompt", () => {
      const result = injectToolsIntoPrompt("You are helpful.", sampleTools);
      expect(result).toContain("<tools>");
      expect(result).toContain("</tools>");
      expect(result).toContain("read_file");
      expect(result).toContain("edit_file");
      expect(result).toContain("You are helpful.");
    });

    it("should include parameter schemas in the injection", () => {
      const result = injectToolsIntoPrompt("System prompt", sampleTools);
      expect(result).toContain("path");
      expect(result).toContain("<tool_call>");
    });

    it("should include usage instructions for the model", () => {
      const result = injectToolsIntoPrompt("Base", sampleTools);
      expect(result).toContain("<tool_call>");
      expect(result).toContain("<name>");
      expect(result).toContain("<arguments>");
    });
  });

  describe("parseToolCallsFromText", () => {
    it("should parse a single tool call from XML", () => {
      const text = `Let me read that file.
<tool_call>
<name>read_file</name>
<arguments>{"path": "src/main.ts"}</arguments>
</tool_call>`;

      const calls = parseToolCallsFromText(text);
      expect(calls).toHaveLength(1);
      expect(calls[0].name).toBe("read_file");
      expect(calls[0].arguments).toEqual({ path: "src/main.ts" });
      expect(calls[0].id).toBeDefined();
    });

    it("should parse multiple tool calls", () => {
      const text = `I'll read both files.
<tool_call>
<name>read_file</name>
<arguments>{"path": "src/a.ts"}</arguments>
</tool_call>
<tool_call>
<name>read_file</name>
<arguments>{"path": "src/b.ts"}</arguments>
</tool_call>`;

      const calls = parseToolCallsFromText(text);
      expect(calls).toHaveLength(2);
      expect(calls[0].arguments).toEqual({ path: "src/a.ts" });
      expect(calls[1].arguments).toEqual({ path: "src/b.ts" });
    });

    it("should return empty array when no tool calls present", () => {
      const text = "Just a regular response with no tool calls.";
      const calls = parseToolCallsFromText(text);
      expect(calls).toHaveLength(0);
    });

    it("should extract text content outside tool calls", () => {
      const text = `Let me help you.
<tool_call>
<name>read_file</name>
<arguments>{"path": "test.ts"}</arguments>
</tool_call>
I'll analyze the results.`;

      const calls = parseToolCallsFromText(text);
      expect(calls).toHaveLength(1);
    });

    it("should handle malformed JSON gracefully", () => {
      const text = `<tool_call>
<name>read_file</name>
<arguments>{invalid json}</arguments>
</tool_call>`;

      const calls = parseToolCallsFromText(text);
      // Should either skip or return with error, not crash
      expect(calls).toHaveLength(0);
    });
  });
});
