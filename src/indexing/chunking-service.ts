/**
 * ChunkingService: splits source files into semantically meaningful chunks.
 *
 * For TypeScript/JavaScript files it extracts top-level functions and
 * classes by regex + brace counting. This is a pragmatic alternative to
 * tree-sitter — simpler, zero native deps, and fast enough for
 * incremental indexing. When we need broader language coverage or more
 * accurate parsing, this module can be swapped for a tree-sitter backend
 * behind the same ChunkingService interface.
 *
 * For unsupported languages, it falls back to a sliding window chunker
 * that splits the file into overlapping blocks of fixed line count.
 */

export interface CodeChunk {
  filePath: string;
  text: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  chunkType: "function" | "class" | "method" | "block";
}

/** Languages handled by the regex-based AST extractor. */
const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/** Max lines per chunk. Functions longer than this are split. */
const MAX_CHUNK_LINES = 150;

/** Sliding window size for unsupported languages. */
const SLIDING_WINDOW_LINES = 100;
/** Overlap between consecutive sliding windows. */
const SLIDING_WINDOW_OVERLAP = 20;

export class ChunkingService {
  async chunkFile(filePath: string, content: string): Promise<CodeChunk[]> {
    if (!content || !content.trim()) return [];

    const ext = this.getExtension(filePath);
    if (SUPPORTED_EXTENSIONS.has(ext)) {
      const chunks = this.extractTsJsChunks(filePath, content);
      if (chunks.length > 0) return chunks;
      // If extraction found nothing (e.g. file has only imports), still
      // fall back to sliding window so the file contributes something.
    }

    return this.slidingWindowChunks(filePath, content);
  }

  private getExtension(filePath: string): string {
    const dot = filePath.lastIndexOf(".");
    return dot === -1 ? "" : filePath.slice(dot).toLowerCase();
  }

  /**
   * Extract top-level function and class declarations from TypeScript/
   * JavaScript source. Uses regex to find declaration starts, then brace
   * counting to find the matching close.
   *
   * Known limitations:
   *   - Regex matches don't understand strings/comments, so the brace
   *     counter uses a mini string/comment-aware scanner below.
   *   - Arrow functions assigned to consts are recognized if they use
   *     a block body `const name = (...) => { ... }`.
   */
  private extractTsJsChunks(filePath: string, content: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];

    // Find candidate declaration starts. The patterns below all anchor on
    // a keyword-like prefix so we don't match random identifiers.
    const patterns: Array<{
      regex: RegExp;
      type: "function" | "class";
      nameGroup: number;
    }> = [
      // function foo(...) {
      {
        regex:
          /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{]+)?\s*\{/g,
        type: "function",
        nameGroup: 1,
      },
      // const foo = (...) => {
      {
        regex:
          /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::[^=]+)?\s*=>\s*\{/g,
        type: "function",
        nameGroup: 1,
      },
      // class Foo {
      {
        regex:
          /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+[^{]+)?(?:\s+implements\s+[^{]+)?\s*\{/g,
        type: "class",
        nameGroup: 1,
      },
    ];

    for (const { regex, type, nameGroup } of patterns) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const name = match[nameGroup];
        // Position of the opening brace is the end of the match minus 1.
        const openBraceIdx = match.index + match[0].length - 1;
        const closeBraceIdx = this.findMatchingBrace(content, openBraceIdx);
        if (closeBraceIdx === -1) continue;

        // The declaration's start is the first non-whitespace position
        // after the preceding newline. Use the match index adjusted so we
        // don't include the leading newline in the chunk text.
        const declStart = this.skipLeadingWhitespace(content, match.index);
        const chunkText = content.slice(declStart, closeBraceIdx + 1);
        const startLine = this.lineNumberAt(content, declStart);
        const endLine = this.lineNumberAt(content, closeBraceIdx);
        const lineCount = endLine - startLine + 1;

        if (lineCount <= MAX_CHUNK_LINES) {
          chunks.push({
            filePath,
            text: chunkText,
            startLine,
            endLine,
            symbolName: name,
            chunkType: type,
          });
        } else {
          // Oversized function/class: split the body into fixed-size
          // windows but keep each window tagged with the parent symbol
          // so searches still surface the correct location.
          const windowChunks = this.splitOversizedChunk(
            filePath,
            chunkText,
            startLine,
            name,
            type,
          );
          chunks.push(...windowChunks);
        }
      }
    }

    // Sort by start line for stable output (the test relies on finding
    // chunks by symbol name, but downstream consumers benefit from order).
    chunks.sort((a, b) => a.startLine - b.startLine);
    return chunks;
  }

  /**
   * Walk forward from an opening brace to find its matching close brace,
   * ignoring braces inside strings and comments. Returns -1 if the file
   * ends before the brace balances.
   */
  private findMatchingBrace(content: string, openIdx: number): number {
    let depth = 1;
    let i = openIdx + 1;
    const n = content.length;

    while (i < n && depth > 0) {
      const ch = content[i];

      // Line comment
      if (ch === "/" && content[i + 1] === "/") {
        const nl = content.indexOf("\n", i);
        if (nl === -1) return -1;
        i = nl + 1;
        continue;
      }

      // Block comment
      if (ch === "/" && content[i + 1] === "*") {
        const end = content.indexOf("*/", i + 2);
        if (end === -1) return -1;
        i = end + 2;
        continue;
      }

      // String literals
      if (ch === '"' || ch === "'" || ch === "`") {
        i = this.skipString(content, i, ch);
        if (i === -1) return -1;
        continue;
      }

      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth === 0) return i;
      i++;
    }

    return -1;
  }

  /**
   * Advance past a string literal starting at openIdx with the given
   * quote character. Handles escapes and, for template literals,
   * ${ ... } interpolations.
   */
  private skipString(content: string, openIdx: number, quote: string): number {
    let i = openIdx + 1;
    const n = content.length;

    while (i < n) {
      const ch = content[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (quote === "`" && ch === "$" && content[i + 1] === "{") {
        // Template literal interpolation — skip until the matching }.
        let depth = 1;
        i += 2;
        while (i < n && depth > 0) {
          if (content[i] === "{") depth++;
          else if (content[i] === "}") depth--;
          i++;
        }
        continue;
      }
      if (ch === quote) return i + 1;
      i++;
    }
    return -1;
  }

  private skipLeadingWhitespace(content: string, idx: number): number {
    let i = idx;
    while (
      i < content.length &&
      (content[i] === "\n" ||
        content[i] === " " ||
        content[i] === "\t" ||
        content[i] === "\r")
    ) {
      i++;
    }
    return i;
  }

  private lineNumberAt(content: string, index: number): number {
    let line = 1;
    for (let i = 0; i < index && i < content.length; i++) {
      if (content[i] === "\n") line++;
    }
    return line;
  }

  private splitOversizedChunk(
    filePath: string,
    text: string,
    startLine: number,
    symbolName: string,
    parentType: "function" | "class",
  ): CodeChunk[] {
    const lines = text.split("\n");
    const chunks: CodeChunk[] = [];

    for (let i = 0; i < lines.length; i += MAX_CHUNK_LINES) {
      const slice = lines.slice(i, i + MAX_CHUNK_LINES);
      chunks.push({
        filePath,
        text: slice.join("\n"),
        startLine: startLine + i,
        endLine: startLine + i + slice.length - 1,
        symbolName: `${symbolName} [part ${Math.floor(i / MAX_CHUNK_LINES) + 1}]`,
        chunkType: parentType === "class" ? "class" : "function",
      });
    }

    return chunks;
  }

  /**
   * Sliding window chunker for unsupported languages or files where the
   * regex extractor produced nothing. Produces overlapping fixed-size
   * chunks so a query that lands near a chunk boundary still retrieves
   * relevant context.
   */
  private slidingWindowChunks(filePath: string, content: string): CodeChunk[] {
    const lines = content.split("\n");
    const chunks: CodeChunk[] = [];
    const step = SLIDING_WINDOW_LINES - SLIDING_WINDOW_OVERLAP;

    for (let i = 0; i < lines.length; i += step) {
      const slice = lines.slice(i, i + SLIDING_WINDOW_LINES);
      if (slice.length === 0) break;
      chunks.push({
        filePath,
        text: slice.join("\n"),
        startLine: i + 1,
        endLine: i + slice.length,
        chunkType: "block",
      });
      if (i + SLIDING_WINDOW_LINES >= lines.length) break;
    }

    return chunks;
  }
}
