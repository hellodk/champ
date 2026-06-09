/**
 * TDD: Tests for TextToolCallParser.
 */
import { describe, it, expect } from "vitest";
import { TextToolCallParser } from "@/agent/text-tool-call-parser";

describe("TextToolCallParser", () => {
  const parser = new TextToolCallParser();

  describe("JSON code block format", () => {
    it("parses a single tool call from a JSON code block", () => {
      const text = `I'll use the read_file tool.
\`\`\`json
{"tool": "read_file", "parameters": {"path": "/tmp/test.txt"}}
\`\`\`
Let me check the result.`;

      const result = parser.parse(text);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("read_file");
      expect(result.toolCalls[0].args).toEqual({ path: "/tmp/test.txt" });
      expect(result.cleanText).not.toContain("```json");
      expect(result.cleanText).toContain("I'll use the read_file tool.");
    });

    it("parses using 'name' key instead of 'tool'", () => {
      const text = `\`\`\`json
{"name": "list_files", "parameters": {"dir": "."}}
\`\`\``;

      const result = parser.parse(text);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("list_files");
    });

    it("parses using 'arguments' key instead of 'parameters'", () => {
      const text = `\`\`\`json
{"tool": "write_file", "arguments": {"path": "out.txt", "content": "hello"}}
\`\`\``;

      const result = parser.parse(text);

      expect(result.toolCalls[0].args).toEqual({
        path: "out.txt",
        content: "hello",
      });
    });

    it("parses multiple tool calls", () => {
      const text = `First:
\`\`\`json
{"tool": "read_file", "parameters": {"path": "a.txt"}}
\`\`\`
Then:
\`\`\`json
{"tool": "read_file", "parameters": {"path": "b.txt"}}
\`\`\``;

      const result = parser.parse(text);

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls[0].args.path).toBe("a.txt");
      expect(result.toolCalls[1].args.path).toBe("b.txt");
    });

    it("ignores JSON blocks that are not tool calls", () => {
      const text = `\`\`\`json
{"some": "data", "without": "tool_key"}
\`\`\``;

      const result = parser.parse(text);

      expect(result.toolCalls).toHaveLength(0);
      // Block should remain in cleanText since it's not a tool call
    });

    it("ignores malformed JSON", () => {
      const text = `\`\`\`json
{this is not valid json}
\`\`\``;

      const result = parser.parse(text);

      expect(result.toolCalls).toHaveLength(0);
    });
  });

  describe("XML tool_call format", () => {
    it("parses a tool call from XML tags", () => {
      const text = `<tool_call>{"name": "edit_file", "parameters": {"path": "src/main.ts", "content": "hello"}}</tool_call>`;

      const result = parser.parse(text);

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0].name).toBe("edit_file");
      expect(result.toolCalls[0].args.path).toBe("src/main.ts");
    });

    it("removes XML tool_call block from cleanText", () => {
      const text = `Some preamble\n<tool_call>{"name": "list", "parameters": {}}</tool_call>\nSome postamble`;

      const result = parser.parse(text);

      expect(result.cleanText).toContain("Some preamble");
      expect(result.cleanText).toContain("Some postamble");
      expect(result.cleanText).not.toContain("<tool_call>");
    });
  });

  describe("edge cases", () => {
    it("returns empty tool calls and original text when no tool calls found", () => {
      const text = "This is just a normal response with no tool calls.";

      const result = parser.parse(text);

      expect(result.toolCalls).toHaveLength(0);
      expect(result.cleanText).toBe(text);
    });

    it("handles empty string", () => {
      const result = parser.parse("");
      expect(result.toolCalls).toHaveLength(0);
      expect(result.cleanText).toBe("");
    });
  });

  describe("buildToolPrompt", () => {
    it("returns empty string for empty tool list", () => {
      expect(TextToolCallParser.buildToolPrompt([])).toBe("");
    });

    it("includes all tool names and descriptions", () => {
      const prompt = TextToolCallParser.buildToolPrompt([
        { name: "read_file", description: "Read a file from disk" },
        { name: "write_file", description: "Write content to a file" },
      ]);

      expect(prompt).toContain("read_file");
      expect(prompt).toContain("write_file");
      expect(prompt).toContain("Read a file from disk");
      expect(prompt).toContain("```json");
    });
  });
});
