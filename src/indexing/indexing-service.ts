import * as fsp from "fs/promises";
import * as crypto from "crypto";
import * as path from "path";
import { champConfigDir } from "../config/home";
import {
  checkManifestFreshness,
  ignoreFingerprint,
  indexingIgnorePatterns,
  INDEX_MANIFEST_VERSION,
  manifestPathFor,
  readIndexManifest,
  sha256,
  writeIndexManifest,
  type IndexFileState,
} from "./index-manifest";
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

/** File extensions eligible for indexing (incremental watcher whitelist). */
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

/** True when the file's extension is part of the indexable whitelist. */
export function isIndexableTextFile(filePath: string): boolean {
  return TEXT_EXTS.has(path.extname(filePath).toLowerCase());
}

/** Debounce window for persisting incremental index updates to disk. */
const SAVE_DEBOUNCE_MS = 500;

export class IndexingService {
  private embeddingService: EmbeddingService | null = null;
  private vectorStore: VectorStore;
  private chunkingService: ChunkingService;
  private embeddingModelId: string | null = null;
  private indexingPromise: Promise<IndexingStats | null> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private fileStates = new Map<string, IndexFileState>();
  private manifestComplete = false;

  constructor(
    private readonly workspaceRoot: string,
    private readonly smartRouter: SmartRouter,
    private readonly config: ChampConfig,
    /** Override the index cache directory (tests and `champ index`). */
    private readonly cacheDirectory?: string,
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
  initialize(options: { force?: boolean } = {}): Promise<IndexingStats | null> {
    if (options.force) this.indexingPromise = null;
    if (this.indexingPromise) return this.indexingPromise;
    this.indexingPromise = this._initialize(options.force === true);
    return this.indexingPromise;
  }

  private async _initialize(force = false): Promise<IndexingStats | null> {
    const embedding = this.resolveEmbedding();
    if (!embedding) return null;
    const { baseUrl, apiKey, modelId, providerFormat } = embedding;

    this.embeddingModelId = modelId;
    // Re-create the VectorStore now that we know the embedding model, so that
    // save/load operations can validate model ID consistency.
    this.vectorStore = new VectorStore(":memory:", modelId);

    // Try to reuse a recently persisted index BEFORE any provider traffic so
    // warm sessions cost zero embedding calls. Only attempted when indexing
    // is enabled. Search still needs query embeddings afterwards, so a live
    // EmbeddingService is kept — but the health probe and full rebuild are
    // skipped entirely. If the provider is down, search degrades to [] via
    // its own error handling.
    if (!force && this.config.indexing?.enabled !== false) {
      const loaded = await this.tryLoadIndex();
      if (loaded) {
        this.embeddingService = new EmbeddingService(providerFormat, {
          baseUrl,
          apiKey,
          model: modelId,
        });
        await this.embeddingService.loadCache();
        return {
          filesIndexed: this.vectorStore.filePaths().length,
          chunksIndexed: this.vectorStore.size(),
          embeddingModel: modelId,
        };
      }
    }

    this.embeddingService = new EmbeddingService(providerFormat, {
      baseUrl,
      apiKey,
      model: modelId,
    });
    // Load the content-hash embedding cache to skip redundant API calls.
    await this.embeddingService.loadCache();

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
   * Replaces all previous chunks for the file and schedules a debounced
   * persist of the updated index.
   */
  async reindexFile(filePath: string): Promise<void> {
    if (!this.embeddingService) return;
    try {
      await this.vectorStore.deleteByFile(filePath);
      const content = await fsp.readFile(filePath, "utf8");
      const chunks = await this.indexFile(filePath, content);
      this.fileStates.set(this.relativeKey(filePath), {
        sha256: sha256(content),
        size: Buffer.byteLength(content),
        chunks,
      });
      this.scheduleSaveIndex();
    } catch {
      // Silently skip — file may have been deleted.
    }
  }

  /**
   * Remove every chunk belonging to a file (call on deletion).
   * @returns The number of chunks removed.
   */
  async deleteByFile(filePath: string): Promise<number> {
    if (!this.embeddingService) return 0;
    const removed = await this.vectorStore.deleteByFile(filePath);
    this.fileStates.delete(this.relativeKey(filePath));
    if (removed > 0) this.scheduleSaveIndex();
    return removed;
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.vectorStore.dispose();
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Resolve the embedding route without network I/O. An explicit model fixes
   * identity; the selected route still supplies base URL, key and wire format.
   */
  private resolveEmbedding(): {
    baseUrl: string;
    apiKey: string | undefined;
    modelId: string;
    providerFormat: "ollama" | "openai";
  } | null {
    const route = this.smartRouter.select("embedding");
    const explicitModel = this.config.indexing?.embeddingModel;
    if (!explicitModel && !route) return null;
    const provider =
      this.config.indexing?.embeddingProvider ??
      route?.model.providerType ??
      "ollama";
    const indexing = this.config.indexing;
    return {
      // Explicit indexing config wins over the router's discovered endpoint;
      // otherwise a remote embedding endpoint is silently replaced by the
      // Ollama localhost default (#140).
      baseUrl:
        indexing?.baseUrl ??
        route?.provider.config.baseUrl ??
        "http://localhost:11434",
      apiKey: indexing?.apiKey ?? route?.provider.config.apiKey,
      modelId: explicitModel ?? route!.model.id,
      providerFormat: provider === "ollama" ? "ollama" : "openai",
    };
  }

  private async indexWorkspace(): Promise<IndexingStats> {
    const files = await this.collectFiles(
      this.workspaceRoot,
      indexingIgnorePatterns(this.config),
    );
    this.fileStates.clear();
    let filesIndexed = 0;
    let chunksIndexed = 0;

    // Parallel indexing with concurrency limit (no external dependency).
    const CONCURRENCY = 6;
    let idx = 0;
    const next = async (): Promise<void> => {
      while (idx < files.length) {
        const i = idx++;
        const filePath = files[i];
        try {
          const content = await fsp.readFile(filePath, "utf8");
          const indexed = await this.indexFile(filePath, content);
          this.fileStates.set(this.relativeKey(filePath), {
            sha256: sha256(content),
            size: Buffer.byteLength(content),
            chunks: indexed,
          });
          if (indexed > 0) {
            filesIndexed++;
            chunksIndexed += indexed;
          }
        } catch {
          // Skip unreadable files.
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, files.length) },
      () => next(),
    );
    await Promise.all(workers);
    this.manifestComplete = true;

    console.log(
      `Champ: indexed ${filesIndexed} files, ${chunksIndexed} chunks`,
    );

    // Persist index + embedding cache to disk so subsequent sessions skip re-embedding.
    // Stored at ~/.champ/index/<workspace-hash>.idx
    // Await both to prevent races with dispose().
    await Promise.allSettled([
      this.saveIndex(),
      this.embeddingService?.saveCache() ?? Promise.resolve(),
    ]);

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
    const dir = this.cacheDirectory ?? path.join(champConfigDir(), "index");
    return path.join(dir, `${hash}.idx`);
  }

  private relativeKey(absolutePath: string): string {
    return path
      .relative(this.workspaceRoot, absolutePath)
      .split(path.sep)
      .join("/");
  }

  /**
   * Hash every indexable file in the workspace. Chunk counts are computed
   * only when needed (a full build or migration of a legacy cache).
   */
  private async scanWorkspaceFiles(
    withChunkCounts = false,
  ): Promise<Map<string, IndexFileState>> {
    const files = await this.collectFiles(
      this.workspaceRoot,
      indexingIgnorePatterns(this.config),
    );
    const states = new Map<string, IndexFileState>();
    for (const file of files) {
      try {
        const content = await fsp.readFile(file, "utf8");
        states.set(this.relativeKey(file), {
          sha256: sha256(content),
          size: Buffer.byteLength(content),
          chunks: withChunkCounts
            ? (await this.chunkingService.chunkFile(file, content)).length
            : 0,
        });
      } catch {
        // Skip files that disappeared or became unreadable during the scan.
      }
    }
    return states;
  }

  private async saveIndex(): Promise<void> {
    const cachePath = this.indexCachePath();
    const modelId = this.embeddingModelId ?? this.resolveEmbedding()?.modelId;
    try {
      await this.vectorStore.save(cachePath);
      if (modelId) {
        if (!this.manifestComplete) {
          // Migrating a pre-manifest cache: derive complete file state now so
          // an incremental update never writes a partial manifest.
          this.fileStates = await this.scanWorkspaceFiles(true);
        }
        await writeIndexManifest(cachePath, {
          version: INDEX_MANIFEST_VERSION,
          embeddingModelId: modelId,
          ignoreFingerprint: ignoreFingerprint(
            indexingIgnorePatterns(this.config),
          ),
          chunkCount: this.vectorStore.size(),
          files: Object.fromEntries(this.fileStates),
          createdAt: new Date().toISOString(),
        });
        this.manifestComplete = true;
      }
      console.log(
        `Champ: index persisted to disk (${this.vectorStore.size()} chunks)`,
      );
    } catch {
      // Persistence is best-effort
    }
  }

  /**
   * Debounced persist of the index after incremental updates, so rapid
   * bursts of file saves coalesce into a single disk write.
   */
  private scheduleSaveIndex(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveIndex();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Try to load a previously saved index from disk. Content hashes decide
   * freshness when a manifest exists; caches written by older versions fall
   * back to the legacy mtime rule until they are rebuilt.
   */
  async tryLoadIndex(): Promise<boolean> {
    try {
      const cachePath = this.indexCachePath();
      const stat = await fsp.stat(cachePath);
      const manifest = await readIndexManifest(cachePath);
      const modelId = this.embeddingModelId ?? this.resolveEmbedding()?.modelId;

      let currentFiles: Map<string, IndexFileState> | undefined;
      if (manifest && modelId) {
        currentFiles = await this.scanWorkspaceFiles();
        const result = checkManifestFreshness(manifest, {
          modelId,
          ignoreFingerprint: ignoreFingerprint(
            indexingIgnorePatterns(this.config),
          ),
          files: currentFiles,
        });
        if (!result.fresh) {
          console.log(`Champ: rebuilding index — ${result.reason}`);
          return false;
        }
      } else if (Date.now() - stat.mtimeMs > 24 * 60 * 60 * 1000) {
        // Legacy cache without manifest: retain the old 24h safety net.
        return false;
      }

      const loaded = await this.vectorStore.load(cachePath);
      if (loaded > 0) {
        if (manifest && currentFiles) {
          this.fileStates = new Map(
            [...currentFiles].map(([key, state]) => [
              key,
              { ...state, chunks: manifest.files[key]?.chunks ?? 0 },
            ]),
          );
          this.manifestComplete = true;
        }
        console.log(`Champ: loaded persisted index (${loaded} chunks)`);
        return true;
      }
    } catch {
      // Cache miss or stale — will re-index
    }
    return false;
  }

  /** Serve a human-readable status report without touching the provider. */
  async indexStatus(): Promise<{
    indexPath: string;
    model: string | null;
    files: number;
    chunks: number;
    lastIndexed: string | null;
    fresh: boolean;
    reason: string;
  }> {
    const indexPath = this.indexCachePath();
    const manifest = await readIndexManifest(indexPath);
    const modelId =
      this.embeddingModelId ?? this.resolveEmbedding()?.modelId ?? null;
    let lastIndexed: string | null = manifest?.createdAt ?? null;
    try {
      const stat = await fsp.stat(indexPath);
      lastIndexed ??= stat.mtime.toISOString();
    } catch {
      // No cache on disk.
    }
    if (!manifest) {
      return {
        indexPath,
        model: modelId,
        files: 0,
        chunks: 0,
        lastIndexed,
        fresh: false,
        reason: lastIndexed
          ? "legacy index without content manifest — run --rebuild"
          : "no persisted index",
      };
    }
    if (!modelId) {
      return {
        indexPath,
        model: manifest.embeddingModelId,
        files: Object.keys(manifest.files).length,
        chunks: manifest.chunkCount,
        lastIndexed,
        fresh: false,
        reason: "no embedding model configured",
      };
    }
    const result = checkManifestFreshness(manifest, {
      modelId,
      ignoreFingerprint: ignoreFingerprint(indexingIgnorePatterns(this.config)),
      files: await this.scanWorkspaceFiles(),
    });
    return {
      indexPath,
      model: manifest.embeddingModelId,
      files: Object.keys(manifest.files).length,
      chunks: manifest.chunkCount,
      lastIndexed,
      fresh: result.fresh,
      reason: result.reason ?? "index is current",
    };
  }

  /** Discard vectors and manifest, then rebuild from scratch. */
  async rebuildIndex(): Promise<IndexingStats | null> {
    await this.invalidateIndex();
    this.embeddingService = null;
    this.embeddingModelId = null;
    this.fileStates.clear();
    this.manifestComplete = false;
    this.indexingPromise = null;
    return this.initialize();
  }

  /** Remove the persisted index and its manifest. */
  async invalidateIndex(): Promise<void> {
    const indexPath = this.indexCachePath();
    await Promise.allSettled([
      fsp.unlink(indexPath),
      fsp.unlink(manifestPathFor(indexPath)),
    ]);
    this.fileStates.clear();
    this.manifestComplete = false;
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

  private async collectFiles(
    root: string,
    ignorePatterns: string[],
  ): Promise<string[]> {
    const results: string[] = [];

    const walk = async (dir: string): Promise<void> => {
      let entries: import("fs").Dirent[];
      try {
        entries = (await fsp.readdir(dir, {
          withFileTypes: true,
        })) as import("fs").Dirent[];
      } catch {
        return;
      }

      for (const entry of entries) {
        const name = entry.name.toString();
        const full = path.join(dir, name);
        const rel = path.relative(root, full);

        if (this.matchesIgnore(rel, ignorePatterns)) continue;

        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && isIndexableTextFile(full)) {
          results.push(full);
        }
      }
    };

    await walk(root);
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
