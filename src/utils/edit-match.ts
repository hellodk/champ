/**
 * VSCode-free helpers for the `edit_file` search-and-replace flow.
 *
 * Extracted from `src/tools/edit-file.ts` so the VS Code tool and the
 * headless (CLI) tool share one implementation of fuzzy matching and the
 * "old_content not found" recovery message. These functions are pure and
 * must not import `vscode`.
 */
import { splitIntoHunks } from "./diff-utils";
import type { ToolPreview } from "../tools/types";

/**
 * Normalize a block of text by trimming each line and removing blank lines,
 * so that minor whitespace differences don't prevent a match.
 */
export function normalizeBlock(text: string): string {
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
export function findFuzzyMatch(
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
export function formatNotFoundError(
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

/**
 * Build the diff preview shown before an `edit_file` approval. Returns
 * undefined when old and new content produce no hunks (i.e. identical text).
 *
 * Shared by the VS Code tool and the headless tool so approval dialogs look
 * the same in both environments.
 */
export function buildEditPreview(
  oldContent: string,
  newContent: string,
  filePath: string,
): ToolPreview | undefined {
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
}
