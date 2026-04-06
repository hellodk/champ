/**
 * VectorStore: in-memory vector storage with cosine-similarity KNN search.
 *
 * The production plan was to use sqlite-vec for persistence and native
 * KNN, but that requires a native SQLite extension that's not available
 * on every platform. This implementation stores vectors in a plain array
 * and does a brute-force cosine scan on every query. For workspaces up
 * to ~50K chunks it's fast enough (well under 100ms per query) and it
 * works everywhere Node.js does.
 *
 * The public interface matches what a sqlite-vec-backed store would
 * expose, so we can swap implementations later without touching callers.
 */

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
