/**
 * edit_file tool: replaces exact content in a file.
 *
 * Uses a search-and-replace model rather than a patch format because it's
 * simpler for LLMs to produce reliably. The old_content must match exactly
 * once in the file; ambiguous matches are rejected.
 */
import * as vscode from "vscode";
import * as fs from "fs/promises";
import type {
  Tool,
  ToolResult,
  ToolExecutionContext,
  ToolPreview,
} from "./types";
import { resolveInWorkspace } from "../utils/workspace-path";
import {
  buildEditPreview,
  findFuzzyMatch,
  formatNotFoundError,
} from "../utils/edit-match";

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

  getPreview(args: Record<string, unknown>): ToolPreview | undefined {
    return buildEditPreview(
      (args.old_content as string) ?? "",
      (args.new_content as string) ?? "",
      (args.path as string) ?? "file",
    );
  },

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
      // Staging mode: read from staging buffer (if already modified this turn)
      // or from disk. Write to staging buffer only — flush happens after turn.
      // This lets multiple edits to the same file within one turn compose
      // correctly and makes the final write atomic across all edited files.
      let text: string;
      if (context.stagedEdits?.has(resolved)) {
        text = context.stagedEdits.getCurrent(resolved)!;
      } else {
        // Prefer VS Code's live document model (reflects unsaved changes in
        // open editors); fall back to reading from disk.
        try {
          const uri = vscode.Uri.file(resolved);
          const doc = await vscode.workspace.openTextDocument(uri);
          text = doc.getText();
        } catch {
          text = await fs.readFile(resolved, "utf-8");
        }
      }

      const firstIdx = text.indexOf(oldContent);
      let matchStart = firstIdx;
      let matchEnd = firstIdx + oldContent.length;
      let fuzzyWarning: string | undefined;

      if (firstIdx === -1) {
        const fuzzyMatch = findFuzzyMatch(text, oldContent);
        if (fuzzyMatch === null) {
          return {
            success: false,
            output: formatNotFoundError(relativePath, text, oldContent),
          };
        }
        matchStart = fuzzyMatch.start;
        matchEnd = fuzzyMatch.end;
        const matchLine = text.slice(0, matchStart).split("\n").length;
        fuzzyWarning = `Note: exact match not found — applied fuzzy match at line ${matchLine}. Review carefully.`;
      } else {
        const secondIdx = text.indexOf(oldContent, firstIdx + 1);
        if (secondIdx !== -1) {
          return {
            success: false,
            output: `Ambiguous match: old_content appears multiple times in ${relativePath}. Provide a longer, unique snippet that includes more surrounding context.`,
          };
        }
      }

      const newText =
        text.slice(0, matchStart) + newContent + text.slice(matchEnd);

      if (context.stagedEdits) {
        // Staging mode: buffer the edit — do NOT write to disk yet.
        context.stagedEdits.stage(resolved, text, newText, relativePath);
      } else {
        // Immediate mode (no staging): write through VS Code's document model.
        const uri = vscode.Uri.file(resolved);
        const doc = await vscode.workspace.openTextDocument(uri);
        const startPos = doc.positionAt(matchStart);
        const endPos = doc.positionAt(matchEnd);
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.replace(uri, new vscode.Range(startPos, endPos), newContent);
        const applied = await vscode.workspace.applyEdit(wsEdit);
        if (!applied) {
          return {
            success: false,
            output: `Failed to apply edit to ${relativePath}`,
          };
        }
        // Record in tracker for diff review panel (immediate mode only;
        // staging mode records are emitted after flush).
        if (context.editReviewTracker) {
          context.editReviewTracker.record({
            path: relativePath,
            oldContent: text,
            newContent: newText,
          });
        }
      }

      const successMsg = fuzzyWarning
        ? `Staged edit for ${relativePath}\n${fuzzyWarning}`
        : context.stagedEdits
          ? `Staged edit for ${relativePath} (will write when turn completes)`
          : `Successfully edited ${relativePath}`;

      context.auditLog?.record("file_edit", `edit:${relativePath}`);
      return {
        success: true,
        output: successMsg,
        metadata: {
          filesModified: [relativePath],
          fileEditDiff: {
            path: relativePath,
            oldContent: text,
            newContent: newText,
          },
        },
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
