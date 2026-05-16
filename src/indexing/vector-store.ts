/**
 * VectorStore: in-memory vector storage with cosine-similarity KNN search
 * and optional disk persistence.
 *
 * Persistence: call save(path) after indexing completes; call load(path)
 * on startup to skip re-indexing sessions. The format is a single binary
 * buffer: a JSON header (chunk metadata) followed by raw Float32 embedding
 * bytes, allowing fast mmap-style loading without JSON-encoding large arrays.
 *
 * KNN: brute-force L2 scan. Fast for ≤50K chunks. For larger workspaces
 * the save/load cycle avoids re-embedding on every session, which is the
 * real bottleneck at scale.
 */
import * as fs from "fs/promises";

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

  /**
   * @param _path - Storage path. `:memory:` or any string are accepted;
   *   this implementation is always in-memory but the argument exists
   *   for interface compatibility with a future persistent backend.
   */
  constructor(_path: string = ":memory:") {
    // Intentionally unused — included for API parity with a
    // sqlite-vec-backed implementation.
  }

  /**
   * Insert a chunk or update an existing one with the same composite key.
   */
  upsert(entry: VectorStoreEntry): void {
    if (this.disposed) throw new Error("VectorStore has been disposed");
    this.entries.set(chunkKey(entry), entry);
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
   */
  async search(
    queryEmbedding: Float32Array,
    topK: number = 10,
  ): Promise<VectorSearchResult[]> {
    if (this.disposed) return [];
    if (this.entries.size === 0) return [];

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
      });
    }

    scored.sort((a, b) => a.distance - b.distance);
    return scored.slice(0, topK);
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
      await fs.mkdir(require("path").dirname(filePath), { recursive: true });
      const entries = [...this.entries.values()];
      const dim = entries[0]?.embedding.length ?? 0;
      const meta = {
        version: 1,
        count: entries.length,
        dim,
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
      const embStart = nlIdx + 1;
      const { dim, chunks } = meta;
      this.entries.clear();
      chunks.forEach((c, i) => {
        const offset = embStart + i * dim * 4;
        const embedding = new Float32Array(
          raw.buffer,
          raw.byteOffset + offset,
          dim,
        ).slice();
        this.entries.set(c.k, { ...c, embedding });
      });
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
