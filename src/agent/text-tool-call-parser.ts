/**
 * TextToolCallParser: detects and parses tool calls embedded in LLM text output.
 *
 * Supports two formats:
 *
 * 1. JSON code block:
 *    ```json
 *    {"tool": "tool_name", "parameters": {"key": "value"}}
 *    ```
 *
 * 2. XML tag:
 *    <tool_call>{"name": "tool_name", "parameters": {"key": "value"}}</tool_call>
 *
 * Returns parsed tool calls and the text with those blocks removed.
 */

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ParseResult {
  toolCalls: ParsedToolCall[];
  /** Text with all detected tool-call blocks removed */
  cleanText: string;
}

// Matches ```json\n{...}\n``` blocks
const JSON_BLOCK_RE = /```json\s*\n([\s\S]*?)\n\s*```/g;

// Matches <tool_call>{...}</tool_call>
const XML_TOOL_CALL_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

function tryParseToolCallJson(raw: string): ParsedToolCall | null {
  try {
    const obj = JSON.parse(raw.trim()) as Record<string, unknown>;
    // Support both {tool, parameters} and {name, parameters} shapes
    const name = (obj["tool"] ?? obj["name"]) as string | undefined;
    const args = (obj["parameters"] ??
      obj["arguments"] ??
      obj["args"] ??
      {}) as Record<string, unknown>;
    if (typeof name === "string" && name.length > 0) {
      return { name, args };
    }
    return null;
  } catch {
    return null;
  }
}

export class TextToolCallParser {
  /**
   * Parse tool calls from LLM text output.
   * Returns parsed calls and the text with tool-call blocks removed.
   */
  parse(text: string): ParseResult {
    const toolCalls: ParsedToolCall[] = [];
    let cleanText = text;

    // First pass: JSON code blocks
    for (const match of text.matchAll(JSON_BLOCK_RE)) {
      const parsed = tryParseToolCallJson(match[1]);
      if (parsed) {
        toolCalls.push(parsed);
        // Remove this block from cleanText
        cleanText = cleanText.replace(match[0], "");
      }
    }

    // Second pass: XML tool_call tags
    for (const match of text.matchAll(XML_TOOL_CALL_RE)) {
      const parsed = tryParseToolCallJson(match[1]);
      if (parsed) {
        toolCalls.push(parsed);
        cleanText = cleanText.replace(match[0], "");
      }
    }

    return {
      toolCalls,
      cleanText: cleanText.trim(),
    };
  }

  /**
   * Build a tool description block to inject into the system prompt.
   * Instructs the model to emit tool calls as JSON code blocks.
   */
  static buildToolPrompt(
    toolDefs: Array<{
      name: string;
      description: string;
      parameters?: unknown;
    }>,
  ): string {
    if (toolDefs.length === 0) return "";
    const lines = [
      "You have access to the following tools. To use a tool, output a JSON code block in this exact format and nothing else for that tool call:",
      "```json",
      '{"tool": "<tool_name>", "parameters": {<key>: <value>, ...}}',
      "```",
      "",
      "Available tools:",
    ];
    for (const def of toolDefs) {
      lines.push(`- ${def.name}: ${def.description}`);
    }
    lines.push(
      "",
      "After the tool result is returned, continue your response.",
    );
    return lines.join("\n");
  }
}
