/**
 * EmbeddingService: generate vector embeddings from text via LLM APIs.
 *
 * Supports two provider formats:
 *   - **ollama**: POST /api/embeddings  → { embedding: number[] }
 *   - **openai**: POST /v1/embeddings   → { data: [{ embedding: number[] }] }
 *
 * The openai format also covers OpenAI-compatible endpoints (vLLM,
 * llama.cpp with --embedding, etc.).
 */

export type EmbeddingProvider = "ollama" | "openai";

export interface EmbeddingConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export class EmbeddingService {
  private dimensions: number | null = null;

  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly config: EmbeddingConfig,
  ) {}

  /**
   * Embed a single text string. Returns a Float32Array of the
   * embedding vector.
   */
  async embed(text: string): Promise<Float32Array> {
    if (this.provider === "ollama") {
      return this.embedOllama(text);
    }
    return this.embedOpenAI(text);
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
