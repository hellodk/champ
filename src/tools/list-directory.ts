/**
 * list_directory tool: lists files and subdirectories at a given path.
 *
 * Returns a simple formatted listing. Read-only, no approval required.
 */
import * as vscode from "vscode";
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import { resolveInWorkspace } from "../utils/workspace-path";

export const listDirectoryTool: Tool = {
  name: "list_directory",
  description:
    "List files and subdirectories at a given path. Returns entries with type indicators.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          'Directory path relative to workspace root (use "." for root)',
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
      const entries = await vscode.workspace.fs.readDirectory(uri);

      if (entries.length === 0) {
        return {
          success: true,
          output: `${relativePath} is empty`,
        };
      }

      // vscode.FileType: File=1, Directory=2, SymbolicLink=64
      const formatted = entries
        .map(([name, type]) => {
          const isDir = (type & 2) !== 0;
          return isDir ? `${name}/` : name;
        })
        .sort()
        .join("\n");

      return {
        success: true,
        output: formatted,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Could not list ${relativePath}: ${message}`,
      };
    }
  },
};
