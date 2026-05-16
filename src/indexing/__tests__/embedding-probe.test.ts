import { describe, it, expect, vi, afterEach } from "vitest";
import { probeEmbeddingProvider } from "../embedding-probe";
import type { ChampConfig } from "../../config/config-loader";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

afterEach(() => vi.clearAllMocks());

const noSecret = async (_name: string): Promise<string | undefined> =>
  undefined;
const withSecret =
  (value: string) =>
  async (_name: string): Promise<string | undefined> =>
    value;

describe("probeEmbeddingProvider", () => {
  it("returns openai available when provider is openai and key present", async () => {
    const config: ChampConfig = {
      indexing: { embeddingProvider: "openai" },
    };
    const result = await probeEmbeddingProvider(
      config,
      withSecret("sk-abc123"),
    );
    expect(result).toEqual({ available: true, provider: "openai" });
  });

  it("returns openai-key-absent when provider is openai but no key", async () => {
    const config: ChampConfig = {
      indexing: { embeddingProvider: "openai" },
    };
    const result = await probeEmbeddingProvider(config, noSecret);
    expect(result).toEqual({ available: false, reason: "openai-key-absent" });
  });

  it("returns ollama-unreachable when ollama is down", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const config: ChampConfig = { indexing: {} };
    const result = await probeEmbeddingProvider(config, noSecret);
    expect(result).toEqual({ available: false, reason: "ollama-unreachable" });
  });

  it("returns model-not-found when model is not listed in ollama", async () => {
    // First fetch: /api/tags for isOllamaReachable → ok: true
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Second fetch: /api/tags for isEmbeddingModelAvailable → model not present
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ models: [{ name: "llama3" }] }),
    });
    const config: ChampConfig = {
      indexing: { embeddingModel: "nomic-embed-text" },
    };
    const result = await probeEmbeddingProvider(config, noSecret);
    expect(result).toEqual({ available: false, reason: "model-not-found" });
  });

  it("returns ollama available when reachable and model matches", async () => {
    // First fetch: /api/tags for isOllamaReachable → ok: true
    mockFetch.mockResolvedValueOnce({ ok: true });
    // Second fetch: /api/tags for isEmbeddingModelAvailable → model present
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        models: [{ name: "nomic-embed-text:latest" }],
      }),
    });
    const config: ChampConfig = {
      indexing: { embeddingModel: "nomic-embed-text" },
    };
    const result = await probeEmbeddingProvider(config, noSecret);
    expect(result).toEqual({ available: true, provider: "ollama" });
  });
});
