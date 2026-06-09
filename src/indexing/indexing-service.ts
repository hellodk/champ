import * as fs from "fs";
import * as fsp from "fs/promises";
import * as crypto from "crypto";
import * as os from "os";
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
    // embeddingModelId is not known until _initialize() resolves; VectorStore
    // is re-created there once the model is confirmed. This placeholder holds
    // the store until then.
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
    // Re-create the VectorStore now that we know the embedding model, so that
    // save/load operations can validate model ID consistency.
    this.vectorStore = new VectorStore(":memory:", modelId);

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
   *
   * @param topK - Maximum number of results to return before filtering.
   * @param minSimilarity - Minimum similarity threshold (0–1). Results with
   *   a similarity score below this value are dropped. Default 0.65 prevents
   *   irrelevant chunks from polluting small model context windows.
   */
  async search(
    query: string,
    topK = 10,
    minSimilarity = 0.65,
  ): Promise<VectorSearchResult[]> {
    if (!this.embeddingService || this.vectorStore.size() === 0) return [];
    try {
      const queryVec = await this.embeddingService.embed(query);
      const results = this.vectorStore.search(queryVec, topK);
      return (await results).filter((r) => r.similarity >= minSimilarity);
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

    // Persist index to disk so subsequent sessions skip re-embedding.
    // Stored at ~/.champ/index/<workspace-hash>.idx
    void this.saveIndex();

    return {
      filesIndexed,
      chunksIndexed,
      embeddingModel: this.embeddingModelId!,
    };
  }

  private indexCachePath(): string {
    const hash = crypto
      .createHash("sha1")
      .update(this.workspaceRoot)
      .digest("hex")
      .slice(0, 12);
    return path.join(os.homedir(), ".champ", "index", `${hash}.idx`);
  }

  private async saveIndex(): Promise<void> {
    try {
      await this.vectorStore.save(this.indexCachePath());
      console.log(
        `Champ: index persisted to disk (${this.vectorStore.size()} chunks)`,
      );
    } catch {
      // Persistence is best-effort
    }
  }

  /**
   * Try to load a previously saved index from disk. Returns true if the
   * index was loaded successfully and indexing can be skipped.
   */
  async tryLoadIndex(): Promise<boolean> {
    try {
      const cachePath = this.indexCachePath();
      // Only load if the cache file is less than 24 hours old
      const stat = await fsp.stat(cachePath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > 24 * 60 * 60 * 1000) return false;
      const loaded = await this.vectorStore.load(cachePath);
      if (loaded > 0) {
        console.log(
          `Champ: loaded ${loaded} chunks from disk index (skip re-embedding)`,
        );
        return true;
      }
    } catch {
      // Cache miss or stale — will re-index
    }
    return false;
  }

  /**
   * Invalidate the disk cache (called when files change significantly).
   */
  async invalidateIndex(): Promise<void> {
    try {
      await fsp.unlink(this.indexCachePath());
    } catch {
      // Already gone
    }
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
