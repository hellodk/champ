/**
 * Bounded file reads for the `read_file` tools (external review 4b and its
 * follow-up in review pass 2).
 *
 * The formatter emits at most `DEFAULT_READ_MAX_LINES` lines, so reading a
 * multi-hundred-MB file whole — and splitting it into every line — is a memory
 * spike for output nobody sees. Files over `MAX_READ_FILE_BYTES` are read as a
 * prefix instead, and the callers report that cap the same way, because the
 * VS Code tool (`src/tools/read-file.ts`) and the headless CLI tool
 * (`src/tools/headless/fs-tools.ts`) share this module.
 *
 * Must not import `vscode`: the CLI bundle has no extension host.
 */
import * as fsp from "fs/promises";

/** Files larger than this are read as a bounded prefix, not whole. */
export const MAX_READ_FILE_BYTES = 2_000_000;

/** Read at most `maxBytes` from the start of `file`, cutting on a line boundary. */
export async function readFilePrefix(
  file: string,
  maxBytes: number = MAX_READ_FILE_BYTES,
): Promise<string> {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf-8");
    // Drop the last (possibly partial) line so no half line — or half UTF-8
    // sequence — is reported as file content.
    const lastNewline = text.lastIndexOf("\n");
    return lastNewline > 0 ? text.slice(0, lastNewline) : text;
  } finally {
    await handle.close();
  }
}

/** Lines in `content`, matching how `formatNumberedLines` splits it. */
export function countLines(content: string): number {
  return content.split("\n").length;
}

/** Explains that only the head of a large file was read. */
export function prefixReadNote(
  relativePath: string,
  fileSize: number,
  linesRead: number,
): string {
  const plural = linesRead === 1 ? "" : "s";
  return `\n\n[${relativePath}: file is ${fileSize} bytes; showing the first ${linesRead} line${plural}]`;
}

/**
 * Explains that a requested range starts past the read cap. Returning the
 * prefix's empty slice instead would let the model conclude the range holds
 * nothing, rather than that it was never read.
 */
export function prefixReadRangeError(
  relativePath: string,
  fileSize: number,
  linesRead: number,
  startLine: number,
): string {
  return (
    `Requested startLine ${startLine} is past the read limit for "${relativePath}": ` +
    `the file is ${fileSize} bytes and only the first ${MAX_READ_FILE_BYTES} bytes ` +
    `(${linesRead} line${linesRead === 1 ? "" : "s"}) are read. ` +
    `Use grep_search to find what you need.`
  );
}
