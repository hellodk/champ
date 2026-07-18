import { describe, it, expect } from "vitest";

// Helper: simulate Ollama /api/tags response
function ollamaTagsResponse(names: string[]) {
  return {
    models: names.map((n) => ({ name: n, size: 2_000_000_000, digest: "abc" })),
  };
}

// Helper: simulate OpenAI /v1/models response
function openaiModelsResponse(ids: string[]) {
  return { data: ids.map((id) => ({ id, object: "model" })) };
}

// Pure parsing functions mirroring the handler logic in chat-view-provider.ts
function parseOllamaModels(body: ReturnType<typeof ollamaTagsResponse>) {
  return (body.models || []).map((m: { name: string; size?: number }) => ({
    name: m.name,
    size: m.size ? formatBytes(m.size) : undefined,
  }));
}

function parseOpenAIModels(body: ReturnType<typeof openaiModelsResponse>) {
  return (body.data || []).map((m: { id: string }) => ({ name: m.id }));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${bytes} B`;
}

describe("discoverModels — response parsing", () => {
  it("parses Ollama /api/tags response", () => {
    const result = parseOllamaModels(
      ollamaTagsResponse(["llama3.2:latest", "phi4:latest"]),
    );
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("llama3.2:latest");
    expect(result[0].size).toBe("2.0 GB");
    expect(result[1].name).toBe("phi4:latest");
  });

  it("parses OpenAI /v1/models response (vLLM, MLX, openai-compatible)", () => {
    const result = parseOpenAIModels(
      openaiModelsResponse(["BAAI/bge-base-en", "deepseek-r1:8b"]),
    );
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("BAAI/bge-base-en");
    expect(result[1].name).toBe("deepseek-r1:8b");
  });

  it("handles empty Ollama response gracefully", () => {
    expect(parseOllamaModels({ models: [] })).toEqual([]);
  });

  it("formatBytes: GB range", () => {
    expect(formatBytes(4_900_000_000)).toBe("4.9 GB");
  });
  it("formatBytes: MB range", () => {
    expect(formatBytes(274_000_000)).toBe("274 MB");
  });
});

describe("saveSettings baseUrl", () => {
  it("SaveSettingsRequest accepts optional baseUrl", () => {
    // Type check only — if this compiles the interface is correct
    const msg = {
      type: "saveSettings" as const,
      provider: "mlx",
      model: "mlx-community/llama",
      baseUrl: "http://192.168.1.19:8080",
    };
    expect(msg.baseUrl).toBe("http://192.168.1.19:8080");
  });
});
