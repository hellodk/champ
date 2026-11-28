/**
 * ChunkingService: splits source files into semantically meaningful chunks.
 *
 * Provides polyglot AST/declaration extraction for:
 *   - TypeScript / JavaScript (.ts, .tsx, .js, .jsx, .mjs, .cjs)
 *   - Python (.py)
 *   - Go (.go)
 *   - Rust (.rs)
 *   - Java (.java)
 *   - Terraform / HCL (.tf, .hcl)
 *
 * Uses token-aware chunk sizing alongside line boundaries so chunks fit
 * comfortably in modern embedding model context windows.
 *
 * For unsupported languages, falls back to an overlapping sliding window chunker.
 */

export interface CodeChunk {
  filePath: string;
  text: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  chunkType: "function" | "class" | "method" | "block";
  tokenCount?: number;
}

/** Languages handled by declaration extractors. */
export const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".tf",
  ".hcl",
]);

const TS_JS_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);

/** Max lines per chunk. Functions longer than this are split. */
export const MAX_CHUNK_LINES = 150;
/** Max tokens per chunk. Functions/blocks larger than this are split. */
export const MAX_CHUNK_TOKENS = 512;

/** Sliding window size for unsupported languages. */
export const SLIDING_WINDOW_LINES = 100;
/** Overlap between consecutive sliding windows. */
export const SLIDING_WINDOW_OVERLAP = 20;

/** Heuristic token estimation (average 4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface DeclarationPattern {
  regex: RegExp;
  type: "function" | "class" | "method" | "block";
  nameGroup: number;
}

export class ChunkingService {
  async chunkFile(filePath: string, content: string): Promise<CodeChunk[]> {
    if (!content || !content.trim()) return [];

    const ext = this.getExtension(filePath);
    let chunks: CodeChunk[] = [];

    if (TS_JS_EXTENSIONS.has(ext)) {
      chunks = this.extractTsJsChunks(filePath, content);
    } else if (ext === ".py") {
      chunks = this.extractPythonChunks(filePath, content);
    } else if (ext === ".go") {
      chunks = this.extractGoChunks(filePath, content);
    } else if (ext === ".rs") {
      chunks = this.extractRustChunks(filePath, content);
    } else if (ext === ".java") {
      chunks = this.extractJavaChunks(filePath, content);
    } else if (ext === ".tf" || ext === ".hcl") {
      chunks = this.extractTerraformChunks(filePath, content);
    }

    if (chunks.length > 0) return chunks;
    return this.slidingWindowChunks(filePath, content);
  }

  private getExtension(filePath: string): string {
    const dot = filePath.lastIndexOf(".");
    return dot === -1 ? "" : filePath.slice(dot).toLowerCase();
  }

  /**
   * Extract TypeScript/JavaScript declarations.
   */
  private extractTsJsChunks(filePath: string, content: string): CodeChunk[] {
    const patterns: DeclarationPattern[] = [
      {
        regex:
          /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{]+)?\s*\{/g,
        type: "function",
        nameGroup: 1,
      },
      {
        regex:
          /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::[^=]+)?\s*=>\s*\{/g,
        type: "function",
        nameGroup: 1,
      },
      {
        regex:
          /(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+[^{]+)?(?:\s+implements\s+[^{]+)?\s*\{/g,
        type: "class",
        nameGroup: 1,
      },
    ];
    return this.extractBraceChunks(filePath, content, patterns);
  }

  /**
   * Extract Go functions, methods, structs, and interfaces.
   */
  private extractGoChunks(filePath: string, content: string): CodeChunk[] {
    const patterns: DeclarationPattern[] = [
      {
        regex:
          /(?:^|\n)\s*func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?:[^{]+)?\s*\{/g,
        type: "function",
        nameGroup: 1,
      },
      {
        regex: /(?:^|\n)\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\s*\{/g,
        type: "class",
        nameGroup: 1,
      },
    ];
    return this.extractBraceChunks(filePath, content, patterns);
  }

  /**
   * Extract Rust functions, structs, enums, traits, and impl blocks.
   */
  private extractRustChunks(filePath: string, content: string): CodeChunk[] {
    const patterns: DeclarationPattern[] = [
      {
        regex:
          /(?:^|\n)\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?:->[^{]+)?\s*\{/g,
        type: "function",
        nameGroup: 1,
      },
      {
        regex:
          /(?:^|\n)\s*(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?(?:\s+where[^{]+)?\s*\{/g,
        type: "class",
        nameGroup: 1,
      },
      {
        regex:
          /(?:^|\n)\s*impl(?:\s+<[^>]*>)?\s+(?:[A-Za-z_]\w*\s+for\s+)?([A-Za-z_]\w*)\s*(?:<[^>]*>)?(?:\s+where[^{]+)?\s*\{/g,
        type: "class",
        nameGroup: 1,
      },
    ];
    return this.extractBraceChunks(filePath, content, patterns);
  }

  /**
   * Extract Java classes, interfaces, and methods.
   */
  private extractJavaChunks(filePath: string, content: string): CodeChunk[] {
    const patterns: DeclarationPattern[] = [
      {
        regex:
          /(?:^|\n)\s*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+([A-Za-z_]\w*)[^{]*\{/g,
        type: "class",
        nameGroup: 1,
      },
      {
        regex:
          /(?:^|\n)\s*(?:@\w+\s+)*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:synchronized\s+)?(?:<[^>]*>\s+)?(?:[A-Za-z_][\w<>[\],\s]*)\s+([A-Za-z_]\w*)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\s*\{/g,
        type: "function",
        nameGroup: 1,
      },
    ];
    return this.extractBraceChunks(filePath, content, patterns);
  }

  /**
   * Extract Terraform / HCL blocks (resource, data, module, variable, output, locals, provider).
   */
  private extractTerraformChunks(
    filePath: string,
    content: string,
  ): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const pattern =
      /(?:^|\n)\s*(resource|data|module|variable|output|locals|provider)\s*(?:"([^"]+)"\s*)?(?:"([^"]+)"\s*)?\{/g;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
      const kind = match[1];
      const arg1 = match[2];
      const arg2 = match[3];
      const symbolName = arg2
        ? `${arg1}.${arg2}`
        : arg1
          ? `${kind}.${arg1}`
          : kind;
      const openBraceIdx = match.index + match[0].length - 1;
      const closeBraceIdx = this.findMatchingBrace(content, openBraceIdx);
      if (closeBraceIdx === -1) continue;

      const declStart = this.skipLeadingWhitespace(content, match.index);
      const chunkText = content.slice(declStart, closeBraceIdx + 1);
      const startLine = this.lineNumberAt(content, declStart);
      const endLine = this.lineNumberAt(content, closeBraceIdx);
      const tokenCount = estimateTokens(chunkText);
      const lineCount = endLine - startLine + 1;

      if (lineCount <= MAX_CHUNK_LINES && tokenCount <= MAX_CHUNK_TOKENS) {
        chunks.push({
          filePath,
          text: chunkText,
          startLine,
          endLine,
          symbolName,
          chunkType: "block",
          tokenCount,
        });
      } else {
        chunks.push(
          ...this.splitOversizedChunk(
            filePath,
            chunkText,
            startLine,
            symbolName,
            "block",
          ),
        );
      }
    }

    chunks.sort((a, b) => a.startLine - b.startLine);
    return chunks;
  }

  /**
   * Extract Python functions and classes using indentation block tracking.
   */
  private extractPythonChunks(filePath: string, content: string): CodeChunk[] {
    const chunks: CodeChunk[] = [];
    const lines = content.split("\n");
    const pattern = /^([ \t]*)(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const match = pattern.exec(line);
      if (!match) {
        i++;
        continue;
      }

      const indent = match[1].length;
      const isDef =
        line.trimStart().startsWith("def") ||
        line.trimStart().startsWith("async def");
      const type: "function" | "class" = isDef ? "function" : "class";
      const name = match[2];
      const startLine = i + 1;

      let endIdx = i;
      let j = i + 1;
      let inDocstring: string | null = null;

      while (j < lines.length) {
        const cur = lines[j];
        const trimmed = cur.trim();

        if (trimmed.includes('"""')) {
          const count = (trimmed.match(/"""/g) || []).length;
          if (count % 2 === 1)
            inDocstring = inDocstring === '"""' ? null : '"""';
        } else if (trimmed.includes("'''")) {
          const count = (trimmed.match(/'''/g) || []).length;
          if (count % 2 === 1)
            inDocstring = inDocstring === "'''" ? null : "'''";
        }

        if (inDocstring) {
          endIdx = j;
          j++;
          continue;
        }

        if (trimmed === "" || trimmed.startsWith("#")) {
          j++;
          continue;
        }

        const curIndent = cur.length - cur.trimStart().length;
        if (curIndent <= indent) {
          break;
        }

        endIdx = j;
        j++;
      }

      const chunkLines = lines.slice(i, endIdx + 1);
      const chunkText = chunkLines.join("\n");
      const endLine = endIdx + 1;
      const tokenCount = estimateTokens(chunkText);
      const lineCount = endLine - startLine + 1;

      if (lineCount <= MAX_CHUNK_LINES && tokenCount <= MAX_CHUNK_TOKENS) {
        chunks.push({
          filePath,
          text: chunkText,
          startLine,
          endLine,
          symbolName: name,
          chunkType: type,
          tokenCount,
        });
      } else {
        chunks.push(
          ...this.splitOversizedChunk(
            filePath,
            chunkText,
            startLine,
            name,
            type,
          ),
        );
      }

      i = endIdx + 1;
    }

    chunks.sort((a, b) => a.startLine - b.startLine);
    return chunks;
  }

  /**
   * Generic extractor for brace-delimited languages ({ ... }).
   */
  private extractBraceChunks(
    filePath: string,
    content: string,
    patterns: DeclarationPattern[],
  ): CodeChunk[] {
    const chunks: CodeChunk[] = [];

    for (const { regex, type, nameGroup } of patterns) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const name = match[nameGroup];
        const openBraceIdx = match.index + match[0].length - 1;
        const closeBraceIdx = this.findMatchingBrace(content, openBraceIdx);
        if (closeBraceIdx === -1) continue;

        const declStart = this.skipLeadingWhitespace(content, match.index);
        const chunkText = content.slice(declStart, closeBraceIdx + 1);
        const startLine = this.lineNumberAt(content, declStart);
        const endLine = this.lineNumberAt(content, closeBraceIdx);
        const lineCount = endLine - startLine + 1;
        const tokenCount = estimateTokens(chunkText);

        if (lineCount <= MAX_CHUNK_LINES && tokenCount <= MAX_CHUNK_TOKENS) {
          chunks.push({
            filePath,
            text: chunkText,
            startLine,
            endLine,
            symbolName: name,
            chunkType: type,
            tokenCount,
          });
        } else {
          chunks.push(
            ...this.splitOversizedChunk(
              filePath,
              chunkText,
              startLine,
              name,
              type,
            ),
          );
        }
      }
    }

    chunks.sort((a, b) => a.startLine - b.startLine);
    return chunks;
  }

  /**
   * Walk forward from an opening brace to find its matching close brace.
   */
  private findMatchingBrace(content: string, openIdx: number): number {
    let depth = 1;
    let i = openIdx + 1;
    const n = content.length;

    while (i < n && depth > 0) {
      const ch = content[i];

      // Line comment // or #
      if (
        (ch === "/" && content[i + 1] === "/") ||
        (ch === "#" &&
          (i === 0 || content[i - 1] === "\n" || content[i - 1] === " "))
      ) {
        const nl = content.indexOf("\n", i);
        if (nl === -1) return -1;
        i = nl + 1;
        continue;
      }

      // Block comment /* ... */
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

  /**
   * Split oversized function/class into token and line-aware chunks.
   */
  private splitOversizedChunk(
    filePath: string,
    text: string,
    startLine: number,
    symbolName: string,
    parentType: "function" | "class" | "method" | "block",
  ): CodeChunk[] {
    const lines = text.split("\n");
    const chunks: CodeChunk[] = [];

    let currentLines: string[] = [];
    let currentTokens = 0;
    let windowStartLine = startLine;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineTokens = estimateTokens(line);

      if (
        (currentTokens + lineTokens > MAX_CHUNK_TOKENS ||
          currentLines.length >= MAX_CHUNK_LINES) &&
        currentLines.length > 0
      ) {
        const chunkText = currentLines.join("\n");
        chunks.push({
          filePath,
          text: chunkText,
          startLine: windowStartLine,
          endLine: windowStartLine + currentLines.length - 1,
          symbolName: `${symbolName} [part ${chunks.length + 1}]`,
          chunkType: parentType,
          tokenCount: currentTokens,
        });

        const overlapCount = Math.min(5, Math.floor(currentLines.length / 2));
        currentLines = currentLines.slice(-overlapCount);
        currentTokens = estimateTokens(currentLines.join("\n"));
        windowStartLine = startLine + i - overlapCount;
      }

      currentLines.push(line);
      currentTokens += lineTokens;
    }

    if (currentLines.length > 0) {
      const chunkText = currentLines.join("\n");
      chunks.push({
        filePath,
        text: chunkText,
        startLine: windowStartLine,
        endLine: windowStartLine + currentLines.length - 1,
        symbolName:
          chunks.length === 0
            ? symbolName
            : `${symbolName} [part ${chunks.length + 1}]`,
        chunkType: parentType,
        tokenCount: estimateTokens(chunkText),
      });
    }

    return chunks;
  }

  /**
   * Sliding window chunker for unsupported languages or declaration-free files.
   */
  private slidingWindowChunks(filePath: string, content: string): CodeChunk[] {
    const lines = content.split("\n");
    const chunks: CodeChunk[] = [];
    const step = SLIDING_WINDOW_LINES - SLIDING_WINDOW_OVERLAP;

    for (let i = 0; i < lines.length; i += step) {
      const slice = lines.slice(i, i + SLIDING_WINDOW_LINES);
      if (slice.length === 0) break;
      const text = slice.join("\n");
      chunks.push({
        filePath,
        text,
        startLine: i + 1,
        endLine: i + slice.length,
        chunkType: "block",
        tokenCount: estimateTokens(text),
      });
      if (i + SLIDING_WINDOW_LINES >= lines.length) break;
    }

    return chunks;
  }
}
