import { describe, it, expect } from "vitest";
import {
  parseToolCallsFromText,
  extractPreToolText,
  extractTextContent,
  hasFabricatedNarration,
} from "../prompt-based-tools";

describe("parseToolCallsFromText", () => {
  it("parses a single XML tool call", () => {
    const text = `I'll read the file.

<tool_call>
<name>read_file</name>
<arguments>{"path": "src/main.ts"}</arguments>
</tool_call>`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
    expect(calls[0].arguments).toEqual({ path: "src/main.ts" });
  });

  it("parses multiple XML tool calls", () => {
    const text = `
<tool_call>
<name>read_file</name>
<arguments>{"path": "a.ts"}</arguments>
</tool_call>

<tool_call>
<name>read_file</name>
<arguments>{"path": "b.ts"}</arguments>
</tool_call>`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toHaveLength(2);
  });

  it("parses Qwen special token format", () => {
    const text = `<｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file
\`\`\`json
{"path": "test.ts"}
\`\`\`
<｜tool▁call▁end｜>`;
    const calls = parseToolCallsFromText(text);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("read_file");
  });

  it("returns empty array for plain text", () => {
    expect(parseToolCallsFromText("Hello world")).toHaveLength(0);
  });

  it("returns empty array for narration without tool calls", () => {
    const text = `> Reading auth.ts to understand the token flow...
> Found the issue.`;
    expect(parseToolCallsFromText(text)).toHaveLength(0);
  });
});

describe("extractPreToolText", () => {
  it("returns text before first tool call", () => {
    const text = `Let me check.

<tool_call>
<name>read_file</name>
<arguments>{"path": "a.ts"}</arguments>
</tool_call>`;
    expect(extractPreToolText(text)).toBe("Let me check.");
  });

  it("returns full text when no tool call", () => {
    expect(extractPreToolText("Hello world")).toBe("Hello world");
  });
});

describe("extractTextContent", () => {
  it("strips tool call blocks", () => {
    const text = `Hello

<tool_call>
<name>read_file</name>
<arguments>{"path": "a.ts"}</arguments>
</tool_call>`;
    expect(extractTextContent(text)).toBe("Hello");
  });

  it("strips Qwen special token blocks", () => {
    const text = `Hello
<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>read_file
\`\`\`json
{}
\`\`\`
<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    expect(extractTextContent(text)).toBe("Hello");
  });
});

describe("hasFabricatedNarration", () => {
  it("detects '---Result of reading documentation:'", () => {
    expect(hasFabricatedNarration("---Result of reading documentation:")).toBe(
      true,
    );
  });

  it("detects '---Results of searching'", () => {
    expect(hasFabricatedNarration("---Results of searching for X")).toBe(true);
  });

  it("detects '> Reading auth.ts...' blockquote narration", () => {
    const text = `> Reading auth.ts to understand the token validation flow...
> Found the issue.`;
    expect(hasFabricatedNarration(text)).toBe(true);
  });

  it("detects '# Result of' heading", () => {
    expect(hasFabricatedNarration("# Result of reading the file")).toBe(true);
  });

  it("detects 'Output of running' pattern", () => {
    expect(hasFabricatedNarration("---Output of running the tests")).toBe(true);
  });

  it("returns false for normal assistant text", () => {
    expect(hasFabricatedNarration("Let me read the file.")).toBe(false);
  });

  it("returns false for text with tool call", () => {
    const text = `I'll read the file.

<tool_call>
<name>read_file</name>
<arguments>{"path": "a.ts"}</arguments>
</tool_call>`;
    expect(hasFabricatedNarration(text)).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasFabricatedNarration("")).toBe(false);
  });
});
