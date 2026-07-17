/**
 * VectorStore: in-memory vector storage with cosine-similarity KNN search
 * and optional disk persistence.
 *
 * Persistence: call save(path) after indexing completes; call load(path)
 * on startup to skip re-indexing sessions. The format is a single binary
 * buffer: a JSON header (chunk metadata) followed by raw Float32 embedding
 * bytes, allowing fast mmap-style loading without JSON-encoding large arrays.
 *
 * KNN: brute-force L2 scan for ≤10K chunks. For larger workspaces,
 * automatically uses HNSW approximate nearest neighbor search when
 * `hnswlib-node` is installed (optional peer dependency). Falls back
 * to brute-force if hnswlib is not available.
 */
import * as fs from "fs/promises";
import * as path from "path";

/** Minimum entries before HNSW index is used (avoids overhead on small stores). */
const HNSW_THRESHOLD = 10_000;

/** Interface for HNSW index (hnswlib-node dynamic import). */
interface HnswIndex {
  search(
    query: Float32Array,
    k: number,
  ): Array<{ label: number; distance: number }>;
  addPoint(vector: Float32Array, label: number): void;
  setEf(ef: number): void;
}

export interface VectorStoreEntry {
  filePath: string;
  chunkText: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  chunkType: string;
  embedding: Float32Array;
}

export interface VectorSearchResult {
  filePath: string;
  chunkText: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  chunkType: string;
  distance: number;
  /** Normalised similarity score in [0, 1]. Computed as 1 / (1 + distance). */
  similarity: number;
}

/**
 * Composite key that identifies a unique chunk within the store.
 * Two upserts with the same key replace each other; different symbols
 * in the same file are separate entries.
 */
function chunkKey(entry: {
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
}): string {
  return `${entry.filePath}::${entry.startLine}-${entry.endLine}::${entry.symbolName ?? ""}`;
}

export class VectorStore {
  private entries = new Map<string, VectorStoreEntry>();
  private disposed = false;
  private hnswIndex: HnswIndex | null = null;
  private hnswDirty = true; // true when entries changed since last HNSW build
  private static hnswAvailable: boolean | null = null; // cached import result

  /**
   * @param _path - Storage path. `:memory:` or any string are accepted;
   *   this implementation is always in-memory but the argument exists
   *   for interface compatibility with a future persistent backend.
   * @param embeddingModelId - The embedding model used to build this index.
   *   When set, save() includes it in the cache header and load() rejects
   *   caches built with a different model ID, preventing silent wrong-distance
   *   lookups when the embedding model changes.
   */
  constructor(
    _path: string = ":memory:",
    private readonly embeddingModelId?: string,
  ) {
    // _path intentionally unused — included for API parity with a
    // sqlite-vec-backed implementation.
  }

  /**
   * Check if hnswlib-node is available (cached after first check).
   */
  private static async isHnswAvailable(): Promise<boolean> {
    if (VectorStore.hnswAvailable !== null) return VectorStore.hnswAvailable;
    try {
      // Dynamic import for optional dependency — no type declarations expected
      await (Function('return import("hnswlib-node")')() as Promise<unknown>);
      VectorStore.hnswAvailable = true;
    } catch {
      VectorStore.hnswAvailable = false;
    }
    return VectorStore.hnswAvailable;
  }

  /**
   * Insert a chunk or update an existing one with the same composite key.
   */
  upsert(entry: VectorStoreEntry): void {
    if (this.disposed) throw new Error("VectorStore has been disposed");
    this.entries.set(chunkKey(entry), entry);
    this.hnswDirty = true;
  }

  /**
   * Delete all entries associated with a file path.
   */
  deleteByFile(filePath: string): void {
    if (this.disposed) throw new Error("VectorStore has been disposed");
    for (const [key, entry] of this.entries) {
      if (entry.filePath === filePath) {
        this.entries.delete(key);
      }
    }
    this.hnswDirty = true;
  }

  /**
   * Return the top-K most similar entries to the query embedding.
   *
   * Ranking uses Euclidean (L2) distance rather than cosine similarity.
   * For normalized embedding vectors (which modern embedding models
   * produce) the two metrics are equivalent, but L2 also works sensibly
   * for raw, unnormalized vectors — cosine is scale-invariant and
   * collapses parallel-but-different-magnitude vectors to the same
   * score, which hides useful signal.
   *
   * When hnswlib-node is installed and the store has >10K entries,
   * uses HNSW approximate nearest neighbor search for O(log n) performance.
   */
  async search(
    queryEmbedding: Float32Array,
    topK: number = 10,
  ): Promise<VectorSearchResult[]> {
    if (this.disposed) return [];
    if (this.entries.size === 0) return [];

    // Use HNSW for large stores when available
    if (
      this.entries.size > HNSW_THRESHOLD &&
      (await VectorStore.isHnswAvailable())
    ) {
      return this.searchHnsw(queryEmbedding, topK);
    }

    return this.searchBruteForce(queryEmbedding, topK);
  }

  /**
   * Brute-force L2 scan — exact, O(n*d).
   */
  private searchBruteForce(
    queryEmbedding: Float32Array,
    topK: number,
  ): VectorSearchResult[] {
    const scored: VectorSearchResult[] = [];
    for (const entry of this.entries.values()) {
      const distance = euclideanDistance(queryEmbedding, entry.embedding);
      scored.push({
        filePath: entry.filePath,
        chunkText: entry.chunkText,
        startLine: entry.startLine,
        endLine: entry.endLine,
        symbolName: entry.symbolName,
        chunkType: entry.chunkType,
        distance,
        similarity: 1 / (1 + distance),
      });
    }

    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, topK);
  }

  /**
   * HNSW approximate nearest neighbor search — O(log n).
   * Builds the index lazily on first search after mutations.
   */
  private async searchHnsw(
    queryEmbedding: Float32Array,
    topK: number,
  ): Promise<VectorSearchResult[]> {
    if (this.hnswDirty || !this.hnswIndex) {
      await this.buildHnswIndex();
    }

    if (!this.hnswIndex) {
      // Fallback to brute-force if HNSW build failed
      return this.searchBruteForce(queryEmbedding, topK);
    }

    const results = this.hnswIndex.search(queryEmbedding, topK);

    // Build a reverse map from HNSW label index to chunk key
    const entries = [...this.entries.entries()];
    return results.map((r) => {
      const entry = entries[r.label]?.[1];
      return {
        filePath: entry?.filePath ?? "",
        chunkText: entry?.chunkText ?? "",
        startLine: entry?.startLine ?? 0,
        endLine: entry?.endLine ?? 0,
        symbolName: entry?.symbolName,
        chunkType: entry?.chunkType ?? "",
        distance: r.distance,
        similarity: 1 / (1 + r.distance),
      };
    });
  }

  /**
   * Build or rebuild the HNSW index from current entries.
   */
  private async buildHnswIndex(): Promise<void> {
    try {
      // Dynamic import for optional dependency
      const hnswlib = await (Function(
        'return import("hnswlib-node")',
      )() as Promise<{
        HNSWLib: new (opts: {
          dimension: number;
          maxElements: number;
        }) => HnswIndex;
      }>);
      const HNSWLib = hnswlib.HNSWLib;
      const dim = this.entries.values().next()?.value?.embedding.length ?? 0;
      if (dim === 0) return;

      const index = new HNSWLib({
        dimension: dim,
        maxElements: this.entries.size,
      });
      const entries = [...this.entries.entries()];
      for (let i = 0; i < entries.length; i++) {
        const [, entry] = entries[i];
        index.addPoint(entry.embedding, i);
      }
      index.setEf(128);

      this.hnswIndex = index;
      this.hnswDirty = false;
    } catch {
      // HNSW build failed — will fall back to brute-force
      this.hnswIndex = null;
    }
  }

  /**
   * Number of entries currently stored. Useful for telemetry and tests.
   */
  size(): number {
    return this.entries.size;
  }

  /**
   * Persist the entire index to disk. Format: JSON metadata header (one line)
   * followed by raw Float32 embedding bytes packed sequentially.
   * Skips silently if the store is empty or disposed.
   */
  async save(filePath: string): Promise<void> {
    if (this.disposed || this.entries.size === 0) return;
    try {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const entries = [...this.entries.values()];
      const dim = entries[0]?.embedding.length ?? 0;
      const meta = {
        version: 1,
        count: entries.length,
        dim,
        embeddingModelId: this.embeddingModelId,
        chunks: entries.map((e) => ({
          k: chunkKey(e),
          filePath: e.filePath,
          chunkText: e.chunkText,
          startLine: e.startLine,
          endLine: e.endLine,
          symbolName: e.symbolName,
          chunkType: e.chunkType,
        })),
      };
      const header = Buffer.from(JSON.stringify(meta) + "\n", "utf-8");
      const embBytes = dim * 4 * entries.length;
      const embBuf = Buffer.allocUnsafe(embBytes);
      entries.forEach((e, i) => {
        const view = new Float32Array(
          embBuf.buffer,
          embBuf.byteOffset + i * dim * 4,
          dim,
        );
        view.set(
          e.embedding.length === dim
            ? e.embedding
            : e.embedding.subarray(0, dim),
        );
      });
      await fs.writeFile(filePath, Buffer.concat([header, embBuf]));
    } catch {
      // Persistence is best-effort — indexing still works without it
    }
  }

  /**
   * Load a previously saved index from disk. Replaces any existing entries.
   * Returns the number of chunks loaded, or 0 on failure.
   */
  async load(filePath: string): Promise<number> {
    if (this.disposed) return 0;
    try {
      const raw = await fs.readFile(filePath);
      const nlIdx = raw.indexOf(0x0a); // newline after JSON header
      if (nlIdx < 0) return 0;
      const meta = JSON.parse(raw.subarray(0, nlIdx).toString("utf-8")) as {
        version: number;
        count: number;
        dim: number;
        embeddingModelId?: string;
        chunks: Array<{
          k: string;
          filePath: string;
          chunkText: string;
          startLine: number;
          endLine: number;
          symbolName?: string;
          chunkType: string;
        }>;
      };
      if (meta.version !== 1 || meta.count !== meta.chunks.length) return 0;
      // Reject cache when both sides have a model ID and they differ.
      if (
        this.embeddingModelId &&
        meta.embeddingModelId &&
        meta.embeddingModelId !== this.embeddingModelId
      ) {
        return 0;
      }
      const embStart = nlIdx + 1;
      const { dim, chunks } = meta;
      this.entries.clear();
      chunks.forEach((c, i) => {
        const offset = embStart + i * dim * 4;
        // Copy the bytes into a fresh ArrayBuffer to guarantee Float32Array
        // 4-byte alignment. Buffer.slice() / subarray() returns a view into the
        // same backing buffer, which may have a non-4-aligned byteOffset.
        // Buffer.from(subarray) copies the bytes into a new allocation whose
        // byteOffset is always 0.
        const copied = Buffer.from(raw.subarray(offset, offset + dim * 4));
        const embedding = new Float32Array(copied.buffer, 0, dim);
        this.entries.set(c.k, { ...c, embedding });
      });
      this.hnswDirty = true; // entries changed, rebuild HNSW on next search
      return this.entries.size;
    } catch {
      return 0;
    }
  }

  /**
   * Release all storage. The store becomes unusable after disposal.
   */
  dispose(): void {
    this.entries.clear();
    this.hnswIndex = null;
    this.hnswDirty = true;
    this.disposed = true;
  }
}

/**
 * Euclidean (L2) distance between two vectors.
 * Returns 0 when the vectors are identical, larger values for farther ones.
 */
function euclideanDistance(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const diff = a[i] - b[i];
    sumSq += diff * diff;
  }
  return Math.sqrt(sumSq);
}
