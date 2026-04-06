/**
 * read_file tool: reads a file from the workspace with line numbers.
 *
 * Supports partial range reads (startLine/endLine) and truncates very
 * large files to keep LLM context usage reasonable. All paths are
 * validated against the workspace boundary.
 */
import * as vscode from "vscode";
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import { resolveInWorkspace } from "../utils/workspace-path";

const MAX_LINES = 2000;

export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read the contents of a file at a given path. Returns the file content with line numbers prefixed.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to the file from workspace root",
      },
      startLine: {
        type: "number",
        description: "Optional start line (1-based, inclusive)",
      },
      endLine: {
        type: "number",
        description: "Optional end line (1-based, inclusive)",
      },
    },
    required: ["path"],
  },
  requiresApproval: false,

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const relativePath = args.path as string;
    const resolved = resolveInWorkspace(context.workspaceRoot, relativePath);
    if (!resolved) {
      return {
        success: false,
        output: `Refused: "${relativePath}" is outside workspace`,
      };
    }

    try {
      const uri = vscode.Uri.file(resolved);
      const data = await vscode.workspace.fs.readFile(uri);
      const content = new TextDecoder().decode(data);
      const lines = content.split("\n");

      const startLine = Math.max(
        1,
        (args.startLine as number | undefined) ?? 1,
      );
      const endLineRaw = (args.endLine as number | undefined) ?? lines.length;
      const endLine = Math.min(lines.length, endLineRaw);

      let truncated = false;
      let actualEnd = endLine;
      if (endLine - startLine + 1 > MAX_LINES) {
        actualEnd = startLine + MAX_LINES - 1;
        truncated = true;
      }

      const slice = lines.slice(startLine - 1, actualEnd);
      const numbered = slice
        .map((line, i) => `${startLine + i}: ${line}`)
        .join("\n");

      const footer = truncated
        ? `\n\n[truncated at line ${actualEnd} of ${lines.length}]`
        : "";

      return { success: true, output: numbered + footer };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `File not found or unreadable: ${relativePath} (${message})`,
      };
    }
  },
};
