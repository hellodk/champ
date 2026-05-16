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
import { splitIntoHunks } from "../utils/diff-utils";

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
    const oldContent = (args.old_content as string) ?? "";
    const newContent = (args.new_content as string) ?? "";
    const filePath = (args.path as string) ?? "file";
    const hunks = splitIntoHunks(oldContent, newContent);
    if (hunks.length === 0) return undefined;
    const lines: string[] = [];
    for (const hunk of hunks.slice(0, 5)) {
      for (const l of hunk.oldLines) lines.push(`-${l}`);
      for (const l of hunk.newLines) lines.push(`+${l}`);
      lines.push("");
    }
    if (hunks.length > 5)
      lines.push(`… (${hunks.length - 5} more hunk(s) not shown)`);
    return {
      type: "diff",
      content: lines.join("\n"),
      label: `Edit: ${filePath}`,
    };
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

// ---------------------------------------------------------------------------
// Fuzzy match helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a block of text by trimming each line and removing blank lines,
 * so that minor whitespace differences don't prevent a match.
 */
function normalizeBlock(text: string): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/**
 * Find the best contiguous block of lines in `fileContent` that matches the
 * lines of `oldString` with >= 85% similarity (after trimming each line).
 *
 * Returns character-offset { start, end } into `fileContent`, or null when
 * no window reaches the threshold.
 */
function findFuzzyMatch(
  fileContent: string,
  oldString: string,
): { start: number; end: number } | null {
  // Fast path: normalized exact match
  const normalizedFile = normalizeBlock(fileContent);
  const normalizedOld = normalizeBlock(oldString);
  if (normalizedOld.length === 0) return null;
  if (normalizedFile.includes(normalizedOld)) {
    // Rebuild match boundaries using a line-scan approach below
    // (fall through to LCS path which handles this correctly)
  }

  const fileLines = fileContent.split("\n");
  const targetLines = oldString
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (targetLines.length === 0) return null;

  let bestScore = 0;
  let bestStart = -1;
  let bestEnd = -1;
  const windowSize = Math.max(targetLines.length, 1);

  for (let i = 0; i <= fileLines.length - windowSize; i++) {
    const windowLines = fileLines
      .slice(i, i + windowSize)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    let matches = 0;
    const minLen = Math.min(windowLines.length, targetLines.length);
    for (let j = 0; j < minLen; j++) {
      if (windowLines[j] === targetLines[j]) matches++;
    }
    const score = matches / Math.max(targetLines.length, windowLines.length);
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
      bestEnd = i + windowSize;
    }
  }

  if (bestScore >= 0.85) {
    // Convert line indices back to character positions
    const lines = fileContent.split("\n");
    let start = 0;
    for (let i = 0; i < bestStart; i++) start += lines[i].length + 1;
    let end = start;
    for (let i = bestStart; i < bestEnd; i++) end += lines[i].length + 1;
    return { start, end: end - 1 };
  }
  return null;
}

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
