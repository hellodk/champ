/**
 * RepoMapBuilder: produces a compact tree-sitter-style outline of the
 * workspace's top-level files and symbols. The result is injected into
 * the agent's first turn so the LLM has factual grounding instead of
 * guessing function/class names — the most effective hallucination
 * mitigation we have. See docs/HALLUCINATION_MITIGATION.md.
 *
 * The map looks like:
 *
 *   # Workspace outline
 *
 *   src/auth/auth-service.ts:
 *     class AuthService
 *     function helper
 *
 *   src/api/users.ts:
 *     function getUser
 *     function listUsers
 *
 * Bodies are deliberately omitted — only symbol names. The chunking
 * service already extracts these via regex, so this module is mostly
 * a presentation layer over ChunkingService.
 */
import type { ChunkingService, CodeChunk } from "./chunking-service";

export interface RepoMapFile {
  path: string;
  content: string;
}

export interface BuildRepoMapOptions {
  /**
   * Maximum size of the rendered map in characters. Defaults to 8 KB
   * which fits comfortably in the context window of every supported
   * provider. Files are processed in input order; if the budget runs
   * out, remaining files are dropped and a "[truncated]" footer is
   * appended.
   */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 8192;
const HEADER =
  "# Workspace outline\n\nThe following is a compact outline of the user's workspace. Use this to ground your answers — do not invent symbols that are not listed here. If you need details about a specific symbol's body, call read_file on the file that contains it.\n\n";

export class RepoMapBuilder {
  constructor(private readonly chunker: ChunkingService) {}

  /**
   * Build a repo map from a list of files. Each file is chunked into
   * symbols (functions, classes), then formatted as a flat outline.
   */
  async buildFromFiles(
    files: RepoMapFile[],
    options: BuildRepoMapOptions = {},
  ): Promise<string> {
    if (files.length === 0) return "";

    const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

    // Sort files by path so output is stable across runs.
    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

    let body = "";
    let truncated = false;

    for (const file of sorted) {
      const chunks = await this.chunker.chunkFile(file.path, file.content);
      const symbols = chunks.filter(
        (c) =>
          c.symbolName &&
          (c.chunkType === "function" || c.chunkType === "class"),
      );
      if (symbols.length === 0) continue;

      const section = this.formatFileSection(file.path, symbols);

      // Only include the section if it fits in the remaining budget.
      // Reserve room for the header and a possible truncation footer.
      const available = maxChars - HEADER.length - body.length - 64;
      if (section.length > available) {
        truncated = true;
        break;
      }
      body += section;
    }

    if (!body) return "";

    let result = HEADER + body;
    if (truncated) {
      result +=
        "\n[truncated — workspace is larger than the repo map budget]\n";
    }
    return result;
  }

  private formatFileSection(path: string, symbols: CodeChunk[]): string {
    const lines: string[] = [`${path}:`];
    for (const sym of symbols) {
      const kind = sym.chunkType === "class" ? "class" : "function";
      lines.push(`  ${kind} ${sym.symbolName}`);
    }
    lines.push("");
    return lines.join("\n");
  }
}
