/**
 * EmbeddingService: generate vector embeddings from text via LLM APIs.
 *
 * Supports two provider formats:
 *   - **ollama**: POST /api/embeddings  → { embedding: number[] }
 *   - **openai**: POST /v1/embeddings   → { data: [{ embedding: number[] }] }
 *
 * The openai format also covers OpenAI-compatible endpoints (vLLM,
 * llama.cpp with --embedding, etc.).
 *
 * Includes a content-hash embedding cache: identical text strings return
 * cached vectors without hitting the API. The cache is keyed by
 * `modelId:sha256(text)` and persists to disk at ~/.champ/embed-cache/.
 *
 * Cache is LRU-evicted at 10K entries to prevent OOM on large workspaces.
 * Disk format is binary (JSON header + raw Float32 bytes) for fast load.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type EmbeddingProvider =
  | "ollama"
  | "openai"
  | "vllm"
  | "openai-compatible";

export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** Maximum cache entries before LRU eviction. */
const MAX_CACHE_ENTRIES = 10_000;

export class EmbeddingService {
  private dimensions: number | null = null;
  /** LRU cache: most-recently-used at the end, evict from front. */
  private cache = new Map<string, Float32Array>();

  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly config: EmbeddingConfig,
  ) {}

  /**
   * Embed a single text string. Returns a Float32Array of the
   * embedding vector. Uses the content-hash cache to skip redundant
   * API calls for identical text.
   */
  async embed(text: string): Promise<Float32Array> {
    const cacheKey = `${this.config.model}:${crypto.createHash("sha256").update(text).digest("hex")}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      // Move to end (most recently used) by re-inserting
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached;
    }

    let vec: Float32Array;
    if (this.provider === "ollama") {
      vec = await this.embedOllama(text);
    } else {
      vec = await this.embedOpenAI(text);
    }

    // LRU eviction: remove oldest entry when at capacity
    if (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }

    this.cache.set(cacheKey, vec);
    return vec;
  }

  /**
   * Embed multiple texts. For Ollama (which doesn't support batch),
   * this calls embed() sequentially. For OpenAI-compatible endpoints,
   * batch could be done in one call but we keep it simple for now.
   */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }

  /**
   * Returns the embedding dimension after at least one embed() call.
   * Returns null if no embedding has been generated yet.
   */
  getDimensions(): number | null {
    return this.dimensions;
  }

  private async embedOllama(text: string): Promise<Float32Array> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/api/embeddings`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.model,
        prompt: text,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Ollama embedding failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { embedding: number[] };
    const vec = new Float32Array(data.embedding);
    this.dimensions = vec.length;
    return vec;
  }

  /**
   * Load cached embeddings from disk. Silently skips on any error.
   * Only loads entries whose vector dimension matches the current model.
   * Tries binary format first, falls back to JSON for backward compat.
   */
  async loadCache(): Promise<void> {
    try {
      const cacheDir = path.join(os.homedir(), ".champ", "embed-cache");
      // Try binary format first (preferred)
      const binPath = path.join(cacheDir, `${this.config.model}.bin`);
      try {
        await this.loadCacheBin(binPath);
        return;
      } catch {
        // Fall through to JSON format
      }
      // Legacy JSON format
      const jsonPath = path.join(cacheDir, `${this.config.model}.json`);
      const raw = await fs.readFile(jsonPath, "utf-8");
      const entries = JSON.parse(raw) as Array<[string, number[]]>;
      for (const [key, arr] of entries) {
        if (this.dimensions !== null && arr.length !== this.dimensions)
          continue;
        this.cache.set(key, new Float32Array(arr));
      }
    } catch {
      // Cache miss — cold start
    }
  }

  /** Load from binary cache file. */
  private async loadCacheBin(binPath: string): Promise<void> {
    const buf = await fs.readFile(binPath);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let offset = 0;
    const dim = view.getUint32(offset, true);
    offset += 4;
    const count = view.getUint32(offset, true);
    offset += 4;
    for (let i = 0; i < count; i++) {
      const keyLen = view.getUint16(offset, true);
      offset += 2;
      const keyBytes = buf.slice(offset, offset + keyLen);
      const key = new TextDecoder().decode(keyBytes);
      offset += keyLen;
      const vec = new Float32Array(dim);
      for (let j = 0; j < dim; j++) {
        vec[j] = view.getFloat32(offset, true);
        offset += 4;
      }
      if (this.dimensions !== null && dim !== this.dimensions) continue;
      this.cache.set(key, vec);
    }
  }

  /**
   * Persist the embedding cache to disk in binary format for fast load.
   * Format: [dim:u32][count:u32]...[keyLen:u16][key bytes][vec:dim × f32]
   * Best-effort — never throws.
   */
  async saveCache(): Promise<void> {
    try {
      const cacheDir = path.join(os.homedir(), ".champ", "embed-cache");
      await fs.mkdir(cacheDir, { recursive: true });
      const binPath = path.join(cacheDir, `${this.config.model}.bin`);
      const dim = this.dimensions ?? 0;
      if (dim === 0 || this.cache.size === 0) return;

      const encoder = new TextEncoder();
      // Calculate total buffer size
      let totalBytes = 8; // header (dim u32 + count u32)
      const keyBuffers: Array<{ buf: Uint8Array; key: string }> = [];
      for (const key of this.cache.keys()) {
        const kb = encoder.encode(key);
        keyBuffers.push({ buf: kb, key });
        totalBytes += 2 + kb.length + dim * 4; // keyLen u16 + key + vec
      }

      const buf = Buffer.alloc(totalBytes);
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      let offset = 0;
      view.setUint32(offset, dim, true);
      offset += 4;
      view.setUint32(offset, this.cache.size, true);
      offset += 4;

      for (const { buf: kb } of keyBuffers) {
        view.setUint16(offset, kb.length, true);
        offset += 2;
        buf.set(kb, offset);
        offset += kb.length;
        const vec = this.cache.get(new TextDecoder().decode(kb))!;
        for (let j = 0; j < dim; j++) {
          view.setFloat32(offset, vec[j], true);
          offset += 4;
        }
      }

      await fs.writeFile(binPath, buf);
    } catch {
      // Persistence is best-effort
    }
  }

  /**
   * Number of cached embeddings.
   */
  cacheSize(): number {
    return this.cache.size;
  }

  private async embedOpenAI(text: string): Promise<Float32Array> {
    const url = `${this.config.baseUrl.replace(/\/$/, "")}/embeddings`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        input: text,
      }),
    });

    if (!response.ok) {
      throw new Error(
        `OpenAI embedding failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    const vec = new Float32Array(data.data[0].embedding);
    this.dimensions = vec.length;
    return vec;
  }
}
