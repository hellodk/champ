/**
 * FileUploadService: processes user-uploaded files for chat context.
 *
 * Handles the file-ingestion pipeline for drag/drop, file picker, and
 * clipboard paste uploads: detects the file type, extracts text,
 * chunks large files into token-budget-safe windows, and stores the
 * result in session memory so downstream agents can reference it.
 *
 * For Phase 7 this is a text-centric implementation. PDF extraction
 * (via pdf-parse) and OCR for screenshots are planned but out of
 * scope here — binary files are flagged with their type so the UI
 * can render them appropriately.
 */

export type FileType =
  | "code"
  | "json"
  | "yaml"
  | "markdown"
  | "log"
  | "text"
  | "image"
  | "pdf"
  | "binary";

export interface UploadInput {
  name: string;
  content: Buffer;
  mimeType: string;
}

export interface ProcessResult {
  success: boolean;
  name: string;
  fileType: FileType;
  chunks: string[];
  totalSize: number;
  error?: string;
}

/** Max size of a single text chunk in characters (~10K tokens). */
const MAX_CHUNK_CHARS = 40_000;
/** Overlap between consecutive chunks to preserve context across boundaries. */
const CHUNK_OVERLAP = 1_000;

/** File extensions that are treated as source code. */
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".html",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".sql",
  ".graphql",
  ".proto",
  ".vue",
  ".svelte",
  ".astro",
]);

export class FileUploadService {
  private sessionFiles = new Map<string, ProcessResult>();

  /**
   * Process an uploaded file: detect type, chunk if necessary, and
   * store in session memory.
   */
  async processFile(input: UploadInput): Promise<ProcessResult> {
    const fileType = this.detectFileType(input);

    // Images and other binary content are not chunked — the UI or
    // multimodal provider handles them directly.
    if (fileType === "image" || fileType === "binary") {
      const result: ProcessResult = {
        success: true,
        name: input.name,
        fileType,
        chunks: [],
        totalSize: input.content.length,
      };
      this.sessionFiles.set(input.name, result);
      return result;
    }

    let text: string;
    try {
      text = input.content.toString("utf-8");
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        name: input.name,
        fileType: "binary",
        chunks: [],
        totalSize: input.content.length,
        error,
      };
    }

    const chunks = this.chunkText(text);
    const result: ProcessResult = {
      success: true,
      name: input.name,
      fileType,
      chunks,
      totalSize: input.content.length,
    };

    this.sessionFiles.set(input.name, result);
    return result;
  }

  /** List all files currently held in session memory. */
  getSessionFiles(): ProcessResult[] {
    return Array.from(this.sessionFiles.values());
  }

  /** Remove a single file from session memory. */
  removeFile(name: string): void {
    this.sessionFiles.delete(name);
  }

  /** Drop all session files. Called when a new chat starts. */
  clearSession(): void {
    this.sessionFiles.clear();
  }

  /**
   * Decide the semantic file type from name + mime type. Extension is
   * the primary signal because MIME types for log and code files vary
   * wildly between operating systems and upload sources.
   */
  private detectFileType(input: UploadInput): FileType {
    const name = input.name.toLowerCase();
    const dot = name.lastIndexOf(".");
    const ext = dot === -1 ? "" : name.slice(dot);
    const mime = input.mimeType.toLowerCase();

    if (mime.startsWith("image/")) return "image";
    if (mime === "application/pdf" || ext === ".pdf") return "pdf";

    if (CODE_EXTENSIONS.has(ext)) return "code";
    // MIME-based code hints (some browsers/platforms send these).
    if (mime === "text/typescript" || mime === "application/typescript")
      return "code";
    if (mime === "text/javascript" || mime === "application/javascript")
      return "code";

    if (ext === ".json" || mime === "application/json") return "json";
    if (ext === ".yaml" || ext === ".yml" || mime === "application/x-yaml")
      return "yaml";
    if (ext === ".md" || ext === ".markdown" || mime === "text/markdown")
      return "markdown";
    if (ext === ".log") return "log";

    // Binary sniffing: check the first few bytes for known binary magic.
    if (this.looksBinary(input.content)) return "binary";

    return "text";
  }

  /**
   * Cheap binary detection: if the first 1KB contains null bytes or a
   * high density of non-printable characters, treat the file as binary.
   */
  private looksBinary(buffer: Buffer): boolean {
    const sample = buffer.subarray(0, Math.min(1024, buffer.length));
    let nonPrintable = 0;
    for (let i = 0; i < sample.length; i++) {
      const byte = sample[i];
      if (byte === 0) return true;
      // Allow tab, LF, CR; count other <32 or >126 as non-printable.
      if (
        byte !== 9 &&
        byte !== 10 &&
        byte !== 13 &&
        (byte < 32 || byte > 126)
      ) {
        nonPrintable++;
      }
    }
    return nonPrintable / sample.length > 0.3;
  }

  /**
   * Split text into overlapping chunks no larger than MAX_CHUNK_CHARS.
   * Short files produce a single chunk.
   */
  private chunkText(text: string): string[] {
    if (text.length <= MAX_CHUNK_CHARS) {
      return [text];
    }

    const chunks: string[] = [];
    const step = MAX_CHUNK_CHARS - CHUNK_OVERLAP;
    for (let start = 0; start < text.length; start += step) {
      const end = Math.min(start + MAX_CHUNK_CHARS, text.length);
      chunks.push(text.slice(start, end));
      if (end >= text.length) break;
    }
    return chunks;
  }
}
