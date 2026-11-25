/**
 * TDD: explicit indexing.baseUrl/apiKey/embeddingModel must survive config
 * validation and reach the embedding client and probe (#140).
 */
import { describe, it, expect, vi } from "vitest";
import { ConfigLoader } from "@/config/config-loader";
import { IndexingService } from "@/indexing/indexing-service";
import { probeEmbeddingProvider } from "@/indexing/embedding-probe";

function serviceWithConfig(config: unknown): {
  svc: IndexingService;
  inner: Record<string, unknown>;
} {
  const router = { select: vi.fn().mockReturnValue(null) };
  const svc = new IndexingService(
    "/tmp/workspace",
    router as never,
    config as never,
  );
  return { svc, inner: svc as unknown as Record<string, unknown> };
}

describe("IndexingConfig explicit embedding route", () => {
  it("config loader accepts baseUrl, apiKey and embeddingModel", () => {
    const config = ConfigLoader.parseYaml(`
provider: ollama
indexing:
  enabled: true
  embeddingProvider: openai-compatible
  embeddingModel: nomic-embed-text
  baseUrl: http://remote:8000/v1
  apiKey: sk-embed-123
`);
    expect(config.indexing).toMatchObject({
      embeddingProvider: "openai-compatible",
      embeddingModel: "nomic-embed-text",
      baseUrl: "http://remote:8000/v1",
      apiKey: "sk-embed-123",
    });
  });

  it("config loader rejects non-string baseUrl and apiKey", () => {
    expect(() =>
      ConfigLoader.parseYaml(`
provider: ollama
indexing:
  baseUrl: 42
`),
    ).toThrow(/indexing\.baseUrl/);
    expect(() =>
      ConfigLoader.parseYaml(`
provider: ollama
indexing:
  apiKey: 99
`),
    ).toThrow(/indexing\.apiKey/);
  });

  it("uses the configured base URL, key, model and wire format without a router match", () => {
    const { inner } = serviceWithConfig({
      indexing: {
        embeddingProvider: "openai-compatible",
        embeddingModel: "nomic-embed-text",
        baseUrl: "http://remote:8000/v1",
        apiKey: "sk-embed-123",
      },
    });
    const resolve = inner["resolveEmbedding"] as () => unknown;
    expect(resolve.call(inner)).toEqual({
      baseUrl: "http://remote:8000/v1",
      apiKey: "sk-embed-123",
      modelId: "nomic-embed-text",
      providerFormat: "openai",
    });
  });

  it("preserves the Ollama localhost default when no explicit route is configured", () => {
    const { inner } = serviceWithConfig({ indexing: {} });
    const resolve = inner["resolveEmbedding"] as () => unknown;
    expect(resolve.call(inner)).toBeNull();
  });

  it("probes the configured base URL for an OpenAI-compatible embedding provider", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await probeEmbeddingProvider(
        {
          indexing: {
            embeddingProvider: "openai-compatible",
            embeddingModel: "nomic-embed-text",
            baseUrl: "http://remote:8000/v1",
            apiKey: "sk-embed-123",
          },
        },
        async () => undefined,
      );
      expect(result).toEqual({ available: true, provider: "openai" });
      expect(fetchMock).toHaveBeenCalledWith(
        "http://remote:8000/v1/models",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer sk-embed-123",
          }),
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
