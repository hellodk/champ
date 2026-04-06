/**
 * delete_file tool: deletes a file from the workspace.
 *
 * Always requires approval. Only deletes files (not directories) to
 * keep the blast radius small.
 */
import * as vscode from "vscode";
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import { resolveInWorkspace } from "../utils/workspace-path";

export const deleteFileTool: Tool = {
  name: "delete_file",
  description: "Delete a file from the workspace.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to workspace root",
      },
    },
    required: ["path"],
  },
  requiresApproval: true,

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
      await vscode.workspace.fs.delete(uri, { useTrash: false });
      return {
        success: true,
        output: `Deleted ${relativePath}`,
        metadata: { filesDeleted: [relativePath] },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Failed to delete ${relativePath}: ${message}`,
      };
    }
  },
};
