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

  // Put tool-use instructions at the TOP of the system prompt so coding
  // models don't default to dumping markdown code blocks. Include
  // concrete worked examples for file creation / editing — this is the
  // single most effective lever for prompt-based tool calling with
  // coding-focused models (DeepSeek-Coder, Qwen2.5-Coder, etc.)
  return `# MANDATORY tool-use protocol — read before responding

You are an autonomous coding agent with tool access. The user cannot
run code blocks for you — you must call tools to do anything.

## Available tools

<tools>
${toolXml}
</tools>

## Tool call format

To call a tool, output EXACTLY this XML (no backticks, no code fence):

<tool_call>
<name>TOOL_NAME_HERE</name>
<arguments>{"KEY": "VALUE"}</arguments>
</tool_call>

## Critical rules (read carefully)

1. **NEVER output bare code blocks when the user asks you to create or
   edit a file.** Bare markdown \`\`\`code\`\`\` blocks do NOT create
   files. You MUST use <tool_call> with the create_file tool.
2. **ALWAYS verify before claiming.** Use read_file / grep_search
   before referencing specific lines or functions. Do not invent
   file paths, line numbers, or function names.
3. **One tool call per action.** After a tool call, wait for the
   <tool_result> in the next user turn before calling more tools.

## Worked examples

### Example 1 — User asks: "create a hello world file in Rust"

INCORRECT (bare code block, no file created):
\`\`\`rust
fn main() {
    println!("Hello, world!");
}
\`\`\`

CORRECT (tool call — actually creates the file):
I'll create hello_world.rs now.

<tool_call>
<name>create_file</name>
<arguments>{"path": "hello_world.rs", "content": "fn main() {\\n    println!(\\"Hello, world!\\");\\n}\\n"}</arguments>
</tool_call>

### Example 2 — User asks: "what does validateToken do?"

INCORRECT (hallucinated — never saw the code):
The validateToken function verifies JWT signatures.

CORRECT (verify first, then answer):
Let me check.

<tool_call>
<name>grep_search</name>
<arguments>{"query": "validateToken", "include_pattern": "**/*.ts"}</arguments>
</tool_call>

### Example 3 — User asks: "add a comment to main.ts line 10"

CORRECT (read → edit in separate turns):
<tool_call>
<name>read_file</name>
<arguments>{"path": "main.ts"}</arguments>
</tool_call>

(wait for <tool_result>, then next turn)

<tool_call>
<name>edit_file</name>
<arguments>{"path": "main.ts", "old_content": "...", "new_content": "..."}</arguments>
</tool_call>

${basePrompt}`;
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

  // Fallback: if no tool calls were found but the response contains a
  // fenced code block with a clear filename hint, synthesize a
  // create_file call. This handles coding-focused models (DeepSeek,
  // Qwen-Coder) that ignore tool-use instructions and just dump code.
  //
  // Patterns we detect (any one triggers the fallback):
  //   "create hello_world.rs" or "hello_world.rs:" followed by ```lang...```
  //   "file: hello.py" followed by code block
  //   "save as main.go" followed by code block
  //   Filename mentioned just before a code block within 120 chars
  if (results.length === 0) {
    const fallbackCalls = parsePlainCodeBlockFallback(text);
    results.push(...fallbackCalls);
  }

  return results;
}

/**
 * Fallback parser: scan for fenced code blocks and try to associate
 * each with a filename mentioned in the preceding 120 chars. Produces
 * create_file tool calls as a last resort.
 */
function parsePlainCodeBlockFallback(text: string): ToolCall[] {
  const results: ToolCall[] = [];
  // Match fenced code blocks capturing the language and content.
  const codeBlockRegex = /```([\w+.-]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const lang = match[1].trim();
    const code = match[2];
    const blockStart = match.index;
    // Look at the 120 characters BEFORE the code block for a filename.
    const contextStart = Math.max(0, blockStart - 120);
    const context = text.slice(contextStart, blockStart);
    const filename = extractFilename(context, lang);
    if (!filename) continue;
    results.push({
      id: `call_${Math.random().toString(36).slice(2, 11)}`,
      name: "create_file",
      arguments: { path: filename, content: code },
    });
  }
  return results;
}

/**
 * Try to find a filename in the given text. Recognizes:
 *   - Explicit filename syntax: `file: foo.rs`, `filename: foo.py`, `save as foo.go`
 *   - Bare filenames with extensions: `foo.rs`, `src/main.py`, `hello.ts`
 *   - If none found but lang is known, synthesize a default: `main.rs`, `main.py`, etc.
 */
function extractFilename(context: string, lang: string): string | null {
  // Explicit "file:" / "filename:" / "save as" patterns.
  const explicitMatch = context.match(
    /(?:file(?:name)?|save(?:\s+as)?|create|write)[:\s]+(`?)([\w./-]+\.\w+)\1/i,
  );
  if (explicitMatch) return explicitMatch[2];
  // Backticked filename: `hello.rs`
  const backtickMatch = context.match(/`([\w./-]+\.\w+)`/);
  if (backtickMatch) return backtickMatch[1];
  // Bare filename near the end of context: "... hello_world.rs ..."
  const bareMatch = context.match(
    /(?:^|[\s("'])([\w][\w.-]*\.\w+)(?=[\s)"'.]|$)/,
  );
  if (
    bareMatch &&
    /\.(rs|py|js|ts|tsx|jsx|go|java|cpp|c|h|hpp|rb|php|swift|kt|md|json|yaml|yml|toml|sh|sql|html|css|scss|xml)$/i.test(
      bareMatch[1],
    )
  ) {
    return bareMatch[1];
  }
  // Fallback: if we know the language, use a default filename.
  const defaultByLang: Record<string, string> = {
    rust: "main.rs",
    rs: "main.rs",
    python: "main.py",
    py: "main.py",
    javascript: "main.js",
    js: "main.js",
    typescript: "main.ts",
    ts: "main.ts",
    go: "main.go",
    java: "Main.java",
    cpp: "main.cpp",
    c: "main.c",
    ruby: "main.rb",
    rb: "main.rb",
    php: "main.php",
    swift: "main.swift",
    kotlin: "main.kt",
    kt: "main.kt",
  };
  return defaultByLang[lang.toLowerCase()] ?? null;
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
