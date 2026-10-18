/**
 * VSCode-free formatting of file content into numbered lines for the
 * `read_file` tool. Extracted so the VS Code tool and the headless (CLI)
 * tool produce identical output. Pure; must not import `vscode`.
 */

export const DEFAULT_READ_MAX_LINES = 2000;

/**
 * Split `content` into numbered lines (1-based, inclusive range), capping the
 * number of emitted lines at `maxLines` and appending a truncation footer.
 *
 * Mirrors the behaviour of `src/tools/read-file.ts`: `startLine` is clamped to
 * at least 1, `endLine` to the last line, and a `[truncated at line X of Y]`
 * footer is added when the range exceeds `maxLines`.
 */
export function formatNumberedLines(
  content: string,
  startLine?: number,
  endLine?: number,
  maxLines: number = DEFAULT_READ_MAX_LINES,
): string {
  const lines = content.split("\n");

  const start = Math.max(1, startLine ?? 1);
  const endRaw = endLine ?? lines.length;
  const end = Math.min(lines.length, endRaw);

  let truncated = false;
  let actualEnd = end;
  if (end - start + 1 > maxLines) {
    actualEnd = start + maxLines - 1;
    truncated = true;
  }

  const slice = lines.slice(start - 1, actualEnd);
  const numbered = slice.map((line, i) => `${start + i}: ${line}`).join("\n");

  const footer = truncated
    ? `\n\n[truncated at line ${actualEnd} of ${lines.length}]`
    : "";

  return numbered + footer;
}
