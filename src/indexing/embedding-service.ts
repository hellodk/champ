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

export class EmbeddingService {
  private dimensions: number | null = null;
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
    if (cached) return cached;

    let vec: Float32Array;
    if (this.provider === "ollama") {
      vec = await this.embedOllama(text);
    } else {
      vec = await this.embedOpenAI(text);
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
   */
  async loadCache(): Promise<void> {
    try {
      const cacheDir = path.join(os.homedir(), ".champ", "embed-cache");
      const cachePath = path.join(cacheDir, `${this.config.model}.json`);
      const raw = await fs.readFile(cachePath, "utf-8");
      const entries = JSON.parse(raw) as Array<[string, number[]]>;
      for (const [key, arr] of entries) {
        this.cache.set(key, new Float32Array(arr));
      }
    } catch {
      // Cache miss — cold start
    }
  }

  /**
   * Persist the embedding cache to disk. Best-effort — never throws.
   */
  async saveCache(): Promise<void> {
    try {
      const cacheDir = path.join(os.homedir(), ".champ", "embed-cache");
      await fs.mkdir(cacheDir, { recursive: true });
      const cachePath = path.join(cacheDir, `${this.config.model}.json`);
      const entries: Array<[string, number[]]> = [];
      for (const [key, vec] of this.cache) {
        entries.push([key, Array.from(vec)]);
      }
      await fs.writeFile(cachePath, JSON.stringify(entries), "utf-8");
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
