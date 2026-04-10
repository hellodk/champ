/**
 * Prompt-based tool calling for models without native tool_use support.
 *
 * When wrapping a provider whose model can't emit structured tool calls
 * (many small local models), we inject tool definitions into the system
 * prompt as XML and parse the model's text output for <tool_call> blocks.
 */
import type { ToolDefinition, ToolCall } from "./types";

/**
 * Injects tool definitions into a system prompt using an XML format that
 * small local models tend to follow reliably.
 */
export function injectToolsIntoPrompt(
  basePrompt: string,
  tools: ToolDefinition[],
): string {
  if (tools.length === 0) return basePrompt;

  const toolXml = tools
    .map(
      (t) => `<tool name="${escapeXml(t.name)}">
  <description>${escapeXml(t.description)}</description>
  <parameters>${JSON.stringify(t.parameters)}</parameters>
</tool>`,
    )
    .join("\n");

  return `${basePrompt}

You have access to the following tools:

<tools>
${toolXml}
</tools>

To call a tool, respond with this exact XML format:

<tool_call>
<name>tool_name</name>
<arguments>{"param": "value"}</arguments>
</tool_call>

You may make multiple tool calls in one response. After each tool call, you
will receive the result in a <tool_result> block on the next turn. Continue
calling tools until you have enough information, then provide your final
response as plain text.`;
}

/**
 * Parses tool calls from a model response. Supports two formats:
 *
 * 1. XML format (used by our prompt injection):
 *    <tool_call><name>...</name><arguments>{...}</arguments></tool_call>
 *
 * 2. Qwen/DeepSeek token format:
 *    <｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>name
 *    ```json
 *    {"key": "value"}
 *    ```<｜tool▁call▁end｜><｜tool▁calls▁end｜>
 *
 * Non-tool-call text is ignored; the caller is responsible for
 * rendering text content separately.
 */
export function parseToolCallsFromText(text: string): ToolCall[] {
  const results: ToolCall[] = [];

  // Format 1: XML <tool_call> blocks.
  const xmlRegex =
    /<tool_call>\s*<name>([\s\S]*?)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = xmlRegex.exec(text)) !== null) {
    const name = match[1].trim();
    const argsText = match[2].trim();
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsText) as Record<string, unknown>;
    } catch {
      continue;
    }
    results.push({
      id: `call_${Math.random().toString(36).slice(2, 11)}`,
      name,
      arguments: args,
    });
  }

  // Format 2: Qwen/DeepSeek special tokens.
  // Pattern: <｜tool▁call▁begin｜>function<｜tool▁sep｜>TOOL_NAME\n```json\n{...}\n```<｜tool▁call▁end｜>
  const qwenRegex =
    /<｜tool▁call▁begin｜>[^<]*<｜tool▁sep｜>(\S+)\s*```(?:json)?\s*([\s\S]*?)```\s*<｜tool▁call▁end｜>/g;
  while ((match = qwenRegex.exec(text)) !== null) {
    const name = match[1].trim();
    const argsText = match[2].trim();
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsText) as Record<string, unknown>;
    } catch {
      continue;
    }
    results.push({
      id: `call_${Math.random().toString(36).slice(2, 11)}`,
      name,
      arguments: args,
    });
  }

  return results;
}

/**
 * Extracts the non-tool-call text from a model response, so the caller can
 * render it to the user separately from tool invocations.
 *
 * Strips both XML <tool_call> blocks and Qwen-style special token blocks,
 * plus any <tool_result>/<tool_output> blocks that shouldn't be shown.
 */
export function extractTextContent(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<｜tool▁calls▁begin｜>[\s\S]*?<｜tool▁calls▁end｜>/g, "")
    .replace(/<｜tool▁call▁begin｜>[\s\S]*?<｜tool▁call▁end｜>/g, "")
    .replace(/<｜tool▁outputs▁begin｜>[\s\S]*?<｜tool▁outputs▁end｜>/g, "")
    .trim();
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
