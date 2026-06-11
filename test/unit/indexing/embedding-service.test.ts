/**
 * TDD: Tests for EmbeddingService — calls LLM embedding endpoints.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  EmbeddingService,
  type EmbeddingProvider,
} from "@/indexing/embedding-service";

function mockFetch(responseBody: unknown): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => responseBody,
  }) as unknown as typeof fetch;
}

describe("EmbeddingService", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a Float32Array embedding for a single text", async () => {
    mockFetch({ embedding: [0.1, 0.2, 0.3] });
    const svc = new EmbeddingService("ollama", {
      baseUrl: "http://localhost:11434",
      model: "nomic-embed-text",
    });
    const result = await svc.embed("hello world");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(3);
    expect(result[0]).toBeCloseTo(0.1);
  });

  it("batch embeds multiple texts", async () => {
    // Ollama returns one embedding per call, so batch calls embed N times.
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => ({ embedding: [callCount * 0.1, 0.0, 0.0] }),
      };
    }) as unknown as typeof fetch;

    const svc = new EmbeddingService("ollama", {
      baseUrl: "http://localhost:11434",
      model: "nomic-embed-text",
    });
    const results = await svc.embedBatch(["one", "two", "three"]);
    expect(results).toHaveLength(3);
    expect(results[0][0]).toBeCloseTo(0.1);
    expect(results[2][0]).toBeCloseTo(0.3);
  });

  it("supports openai provider format", async () => {
    mockFetch({
      data: [{ embedding: [0.5, 0.6] }],
    });
    const svc = new EmbeddingService("openai", {
      baseUrl: "https://api.openai.com",
      model: "text-embedding-3-small",
      apiKey: "test-key",
    });
    const result = await svc.embed("test");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(2);
  });

  it("throws on fetch failure", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    }) as unknown as typeof fetch;

    const svc = new EmbeddingService("ollama", {
      baseUrl: "http://localhost:11434",
      model: "nomic-embed-text",
    });
    await expect(svc.embed("fail")).rejects.toThrow(/500/);
  });

  it("getDimensions returns cached dimension after first embed", async () => {
    mockFetch({ embedding: [0.1, 0.2, 0.3, 0.4] });
    const svc = new EmbeddingService("ollama", {
      baseUrl: "http://localhost:11434",
      model: "nomic-embed-text",
    });
    await svc.embed("test");
    expect(svc.getDimensions()).toBe(4);
  });

  describe("provider routing", () => {
    it("vllm provider routes to openai endpoint", async () => {
      const mockFetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      });
      global.fetch = mockFetchFn as unknown as typeof fetch;

      const svc = new EmbeddingService("vllm", {
        baseUrl: "http://localhost:8000",
        model: "BAAI/bge-base-en",
      });
      await svc.embed("hello");

      // Verify the endpoint is /embeddings (openai format, not /api/embeddings)
      expect(mockFetchFn).toHaveBeenCalled();
      const callUrl = mockFetchFn.mock.calls[0][0] as string;
      expect(callUrl).toBe("http://localhost:8000/embeddings");
    });

    it("openai-compatible provider routes to openai endpoint", async () => {
      const mockFetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      });
      global.fetch = mockFetchFn as unknown as typeof fetch;

      const svc = new EmbeddingService("openai-compatible", {
        baseUrl: "http://localhost:8080",
        model: "mlx-community/nomic-embed-text",
      });
      await svc.embed("hello");

      // Verify the endpoint is /embeddings (openai format, not /api/embeddings)
      expect(mockFetchFn).toHaveBeenCalled();
      const callUrl = mockFetchFn.mock.calls[0][0] as string;
      expect(callUrl).toBe("http://localhost:8080/embeddings");
    });

    it("ollama provider routes to ollama endpoint", async () => {
      const mockFetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
      });
      global.fetch = mockFetchFn as unknown as typeof fetch;

      const svc = new EmbeddingService("ollama", {
        baseUrl: "http://localhost:11434",
        model: "nomic-embed-text",
      });
      await svc.embed("hello");

      // Verify the endpoint is /api/embeddings (ollama format)
      expect(mockFetchFn).toHaveBeenCalled();
      const callUrl = mockFetchFn.mock.calls[0][0] as string;
      expect(callUrl).toContain("/api/embeddings");
    });

    it("openai provider routes to openai endpoint", async () => {
      const mockFetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
      });
      global.fetch = mockFetchFn as unknown as typeof fetch;

      const svc = new EmbeddingService("openai", {
        baseUrl: "https://api.openai.com",
        model: "text-embedding-3-small",
      });
      await svc.embed("hello");

      // Verify the endpoint is /embeddings (openai format, not /api/embeddings)
      expect(mockFetchFn).toHaveBeenCalled();
      const callUrl = mockFetchFn.mock.calls[0][0] as string;
      expect(callUrl).toBe("https://api.openai.com/embeddings");
    });
  });
});
