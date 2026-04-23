import * as fs from "fs";
import * as path from "path";
import { EmbeddingService } from "./embedding-service";
import { VectorStore, type VectorSearchResult } from "./vector-store";
import { ChunkingService } from "./chunking-service";
import type { SmartRouter } from "../providers/smart-router";
import type { ChampConfig } from "../config/config-loader";

export interface IndexingStats {
  filesIndexed: number;
  chunksIndexed: number;
  embeddingModel: string;
}

export class IndexingService {
  private embeddingService: EmbeddingService | null = null;
  private vectorStore: VectorStore;
  private chunkingService: ChunkingService;
  private embeddingModelId: string | null = null;
  private indexingPromise: Promise<IndexingStats | null> | null = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly smartRouter: SmartRouter,
    private readonly config: ChampConfig,
  ) {
    this.vectorStore = new VectorStore();
    this.chunkingService = new ChunkingService();
  }

  /**
   * Auto-detect an embedding model from discovered models, initialize
   * EmbeddingService, and kick off workspace indexing in the background.
   * Returns null silently if no embedding-capable model is available.
   * Safe to call multiple times — subsequent calls return the same promise.
   */
  initialize(): Promise<IndexingStats | null> {
    if (this.indexingPromise) return this.indexingPromise;
    this.indexingPromise = this._initialize();
    return this.indexingPromise;
  }

  private async _initialize(): Promise<IndexingStats | null> {
    // Prefer explicit config, fall back to SmartRouter auto-detection.
    let baseUrl = "http://localhost:11434";
    let modelId: string | null = null;
    let providerFormat: "ollama" | "openai" = "ollama";

    // Check if user explicitly configured an embedding model in config.
    if (this.config.indexing?.embeddingModel) {
      modelId = this.config.indexing.embeddingModel;
      if (this.config.indexing.embeddingProvider === "openai") {
        providerFormat = "openai";
      }
    }

    // Auto-detect via SmartRouter if not explicitly configured.
    if (!modelId) {
      const result = this.smartRouter.select("embedding");
      if (!result) return null;
      modelId = result.model.id;
      providerFormat =
        result.model.providerType === "ollama" ? "ollama" : "openai";
      baseUrl = result.provider.config.baseUrl ?? baseUrl;
    }

    this.embeddingModelId = modelId;
    this.embeddingService = new EmbeddingService(providerFormat, {
      baseUrl,
      model: modelId,
    });

    // Verify the model actually responds before indexing.
    try {
      await this.embeddingService.embed("ping");
    } catch {
      console.warn(
        `Champ: embedding model "${modelId}" did not respond — skipping indexing`,
      );
      this.embeddingService = null;
      this.embeddingModelId = null;
      return null;
    }

    console.log(`Champ: indexing workspace with embedding model "${modelId}"…`);
    return this.indexWorkspace();
  }

  /** True once an embedding model is confirmed working and index is ready. */
  isReady(): boolean {
    return this.embeddingService !== null && this.vectorStore.size() > 0;
  }

  /** The detected embedding model id, or null if none available. */
  getEmbeddingModel(): string | null {
    return this.embeddingModelId;
  }

  /**
   * Semantic search over the indexed workspace.
   * Returns empty array if the index is not ready.
   */
  async search(query: string, topK = 10): Promise<VectorSearchResult[]> {
    if (!this.embeddingService || this.vectorStore.size() === 0) return [];
    try {
      const queryVec = await this.embeddingService.embed(query);
      return this.vectorStore.search(queryVec, topK);
    } catch {
      return [];
    }
  }

  /**
   * Re-index a single file (call after saves to keep index fresh).
   */
  async reindexFile(filePath: string): Promise<void> {
    if (!this.embeddingService) return;
    try {
      this.vectorStore.deleteByFile(filePath);
      const content = fs.readFileSync(filePath, "utf8");
      await this.indexFile(filePath, content);
    } catch {
      // Silently skip — file may have been deleted.
    }
  }

  dispose(): void {
    this.vectorStore.dispose();
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private async indexWorkspace(): Promise<IndexingStats> {
    const ignore = this.config.indexing?.ignore ?? [
      "node_modules/**",
      "dist/**",
      ".git/**",
      "*.min.js",
      "package-lock.json",
      "yarn.lock",
      "pnpm-lock.yaml",
    ];
    const files = this.collectFiles(this.workspaceRoot, ignore);
    let filesIndexed = 0;
    let chunksIndexed = 0;

    for (const filePath of files) {
      try {
        const content = fs.readFileSync(filePath, "utf8");
        const indexed = await this.indexFile(filePath, content);
        if (indexed > 0) {
          filesIndexed++;
          chunksIndexed += indexed;
        }
      } catch {
        // Skip unreadable files.
      }
    }

    console.log(
      `Champ: indexed ${filesIndexed} files, ${chunksIndexed} chunks`,
    );
    return {
      filesIndexed,
      chunksIndexed,
      embeddingModel: this.embeddingModelId!,
    };
  }

  private async indexFile(filePath: string, content: string): Promise<number> {
    if (!this.embeddingService) return 0;
    const chunks = await this.chunkingService.chunkFile(filePath, content);
    for (const chunk of chunks) {
      try {
        const embedding = await this.embeddingService.embed(chunk.text);
        this.vectorStore.upsert({
          filePath: chunk.filePath,
          chunkText: chunk.text,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbolName: chunk.symbolName,
          chunkType: chunk.chunkType,
          embedding,
        });
      } catch {
        // Skip chunks that fail to embed.
      }
    }
    return chunks.length;
  }

  private collectFiles(root: string, ignorePatterns: string[]): string[] {
    const results: string[] = [];
    const TEXT_EXTS = new Set([
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
      ".kt",
      ".swift",
      ".rb",
      ".php",
      ".cs",
      ".cpp",
      ".c",
      ".h",
      ".yaml",
      ".yml",
      ".json",
      ".toml",
      ".md",
      ".sh",
      ".bash",
      ".env",
    ]);

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full);

        if (this.matchesIgnore(rel, ignorePatterns)) continue;

        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.isFile() &&
          TEXT_EXTS.has(path.extname(entry.name).toLowerCase())
        ) {
          results.push(full);
        }
      }
    };

    walk(root);
    return results;
  }

  private matchesIgnore(relPath: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
      const p = pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
      if (new RegExp(`^${p}$`).test(relPath)) return true;
      if (new RegExp(`(^|/)${p}(/|$)`).test(relPath)) return true;
    }
    return false;
  }
}
