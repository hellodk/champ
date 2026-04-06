/**
 * file_search tool: fuzzy file name search.
 *
 * Uses vscode.workspace.findFiles with a glob pattern derived from the
 * query. Results are capped at 10 to keep LLM context small.
 */
import * as vscode from "vscode";
import * as path from "path";
import type { Tool, ToolResult, ToolExecutionContext } from "./types";

const MAX_RESULTS = 10;

export const fileSearchTool: Tool = {
  name: "file_search",
  description:
    "Search for files by name (fuzzy match). Returns up to 10 matching file paths.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Partial file name to search for",
      },
    },
    required: ["query"],
  },
  requiresApproval: false,

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const query = (args.query as string).trim();
    if (!query) {
      return { success: true, output: "No files found for empty query" };
    }

    try {
      // Use a glob that matches the query anywhere in the filename.
      const globPattern = `**/*${query}*`;
      const results = await vscode.workspace.findFiles(
        globPattern,
        "**/node_modules/**",
        MAX_RESULTS,
      );

      if (!results || results.length === 0) {
        return { success: true, output: `No files found matching "${query}"` };
      }

      const formatted = results
        .slice(0, MAX_RESULTS)
        .map((uri) => {
          // Return paths relative to workspace root.
          const full = uri.fsPath;
          if (full.startsWith(context.workspaceRoot)) {
            return full.slice(context.workspaceRoot.length + 1);
          }
          return path.basename(full);
        })
        .join("\n");

      return { success: true, output: formatted };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Search failed: ${message}`,
      };
    }
  },
};
