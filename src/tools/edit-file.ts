/**
 * edit_file tool: replaces exact content in a file.
 *
 * Uses a search-and-replace model rather than a patch format because it's
 * simpler for LLMs to produce reliably. The old_content must match exactly
 * once in the file; ambiguous matches are rejected.
 */
import * as vscode from "vscode";
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import { resolveInWorkspace } from "../utils/workspace-path";

export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Edit a file by replacing specific content. Provide the exact old content to find and the new content to replace it with.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "File path relative to workspace root",
      },
      old_content: {
        type: "string",
        description: "Exact content to find and replace",
      },
      new_content: {
        type: "string",
        description: "New content to replace with",
      },
    },
    required: ["path", "old_content", "new_content"],
  },
  requiresApproval: true,

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const relativePath = args.path as string;
    const oldContent = args.old_content as string;
    const newContent = args.new_content as string;

    const resolved = resolveInWorkspace(context.workspaceRoot, relativePath);
    if (!resolved) {
      return {
        success: false,
        output: `Refused: "${relativePath}" is outside workspace`,
      };
    }

    try {
      const uri = vscode.Uri.file(resolved);
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();

      const firstIdx = text.indexOf(oldContent);
      if (firstIdx === -1) {
        // Verbose error: include the actual file content (capped) so the
        // model can self-correct on the next turn rather than retrying
        // with the same wrong snippet. See HALLUCINATION_MITIGATION.md.
        return {
          success: false,
          output: formatNotFoundError(relativePath, text, oldContent),
        };
      }

      // Warn if the match is ambiguous.
      const secondIdx = text.indexOf(oldContent, firstIdx + 1);
      if (secondIdx !== -1) {
        return {
          success: false,
          output: `Ambiguous match: old_content appears multiple times in ${relativePath}. Provide a longer, unique snippet that includes more surrounding context (e.g. the full enclosing function).`,
        };
      }

      const startPos = doc.positionAt(firstIdx);
      const endPos = doc.positionAt(firstIdx + oldContent.length);
      const range = new vscode.Range(startPos, endPos);

      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, range, newContent);
      const applied = await vscode.workspace.applyEdit(edit);

      if (!applied) {
        return {
          success: false,
          output: `Failed to apply edit to ${relativePath}`,
        };
      }

      return {
        success: true,
        output: `Successfully edited ${relativePath}`,
        metadata: { filesModified: [relativePath] },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        output: `Error editing ${relativePath}: ${message}`,
      };
    }
  },
};

/**
 * Format the "old_content not found" error with the actual file content
 * (capped) so the model can self-correct without burning another turn.
 * See docs/HALLUCINATION_MITIGATION.md for the rationale.
 */
function formatNotFoundError(
  relativePath: string,
  fileText: string,
  oldContent: string,
): string {
  const lines = fileText.split("\n");
  const MAX_LINES = 80;
  const truncated = lines.length > MAX_LINES;
  const shown = truncated ? lines.slice(0, MAX_LINES) : lines;
  const numbered = shown.map((line, i) => `  ${i + 1}: ${line}`).join("\n");

  const oldPreview =
    oldContent.length > 200 ? oldContent.slice(0, 200) + "…" : oldContent;

  const tail = truncated
    ? `\n  [... ${lines.length - MAX_LINES} more lines]`
    : "";

  return `Could not find the specified old_content in ${relativePath}.

The old_content you provided:
${oldPreview}

The actual current content of ${relativePath}:
${numbered}${tail}

Suggested fix: re-read the file with read_file, then construct your edit using the actual content shown above. Make sure your old_content matches the file character-for-character (including whitespace and indentation).`;
}
