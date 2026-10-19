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
import { formatNumberedLines } from "../utils/line-numbering";
import {
  MAX_READ_FILE_BYTES,
  countLines,
  prefixReadNote,
  prefixReadRangeError,
  readFilePrefix,
} from "../utils/bounded-read";

const MAX_LINES = 2000;

/** The file's byte size, or 0 when the filesystem cannot report one. */
async function byteSize(uri: vscode.Uri): Promise<number> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return typeof stat?.size === "number" ? stat.size : 0;
  } catch {
    return 0;
  }
}

/** A bounded prefix read, or undefined when node fs cannot reach the file. */
async function readPrefixOrUndefined(
  file: string,
): Promise<string | undefined> {
  try {
    return await readFilePrefix(file);
  } catch {
    return undefined;
  }
}

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
      // Check staging buffer first: if the agent already modified this file
      // in the current turn, the staged content is the ground truth.
      let content: string;
      let note = "";
      if (context.stagedEdits?.has(resolved)) {
        content = context.stagedEdits.getCurrent(resolved)!;
      } else {
        const uri = vscode.Uri.file(resolved);
        const size = await byteSize(uri);
        const prefix =
          size > MAX_READ_FILE_BYTES
            ? await readPrefixOrUndefined(resolved)
            : undefined;
        if (prefix === undefined) {
          // Small, or a filesystem node fs cannot reach (virtual workspace):
          // read it through the VS Code API.
          const data = await vscode.workspace.fs.readFile(uri);
          content = new TextDecoder().decode(data);
        } else {
          // A huge file is only read up to the cap: the formatter emits at
          // most MAX_LINES lines anyway (external review 4b, pass 2).
          content = prefix;
          const linesRead = countLines(content);
          const startLine = args.startLine as number | undefined;
          if (typeof startLine === "number" && startLine > linesRead) {
            return {
              success: false,
              output: prefixReadRangeError(
                relativePath,
                size,
                linesRead,
                startLine,
              ),
            };
          }
          note = prefixReadNote(relativePath, size, linesRead);
        }
      }
      const numbered =
        formatNumberedLines(
          content,
          args.startLine as number | undefined,
          args.endLine as number | undefined,
          MAX_LINES,
        ) + note;

      return { success: true, output: numbered };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `File not found or unreadable: ${relativePath} (${message})`,
      };
    }
  },
};
