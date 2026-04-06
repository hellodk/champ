/**
 * create_file tool: creates a new file with given content.
 *
 * Requires approval since it's a destructive operation. Intermediate
 * directories are created automatically.
 */
import * as vscode from "vscode";
import * as path from "path";
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import { resolveInWorkspace } from "../utils/workspace-path";

export const createFileTool: Tool = {
  name: "create_file",
  description:
    "Create a new file with the given content. Parent directories are created if needed.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to workspace root",
      },
      content: {
        type: "string",
        description: "Content to write to the new file",
      },
    },
    required: ["path", "content"],
  },
  requiresApproval: true,

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const relativePath = args.path as string;
    const content = args.content as string;

    const resolved = resolveInWorkspace(context.workspaceRoot, relativePath);
    if (!resolved) {
      return {
        success: false,
        output: `Refused: "${relativePath}" is outside workspace`,
      };
    }

    try {
      const uri = vscode.Uri.file(resolved);
      // Ensure parent directory exists.
      const parent = path.dirname(resolved);
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(parent));
      } catch {
        // Directory might already exist; ignore.
      }

      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(content),
      );

      return {
        success: true,
        output: `Created ${relativePath}`,
        metadata: { filesCreated: [relativePath] },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Failed to create ${relativePath}: ${message}`,
      };
    }
  },
};
