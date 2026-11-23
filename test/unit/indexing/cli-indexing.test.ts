import { describe, it, expect, vi } from "vitest";
import { createCliIndexingService } from "@/indexing/cli-indexing";
import type { ChampConfig } from "@/config/config-loader";
import type { Endpoint } from "@/config/provider-model";
import type { DiscoveredModel, SmartRouter } from "@/providers/smart-router";

function embeddingEndpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    id: "local",
    name: "local",
    provider: "ollama",
    credential: null,
    enabled: true,
    isDefault: true,
    models: [{ id: "nomic-embed-text", capabilities: ["embedding"] }],
    ...overrides,
  };
}

function stubProvider(baseUrl: string) {
  return {
    config: { provider: "ollama", model: "nomic-embed-text", baseUrl },
  } as never;
}

describe("createCliIndexingService", () => {
  it("returns null when indexing is disabled", async () => {
    const service = await createCliIndexingService({
      workspaceRoot: "/ws",
      config: { indexing: { enabled: false } },
      endpoints: [embeddingEndpoint()],
    });
    expect(service).toBeNull();
  });

  it("returns null when no endpoint advertises an embedding model", async () => {
    const createFromEndpoint = vi.fn();
    const service = await createCliIndexingService({
      workspaceRoot: "/ws",
      config: {},
      endpoints: [
        embeddingEndpoint({
          models: [{ id: "llama3.1", capabilities: ["coding", "general"] }],
        }),
      ],
      providerFactory: { createFromEndpoint } as never,
    });
    expect(service).toBeNull();
    expect(createFromEndpoint).not.toHaveBeenCalled();
  });

  it("builds a router that selects an embedding endpoint model", async () => {
    const endpoint = embeddingEndpoint();
    const createFromEndpoint = vi
      .fn()
      .mockResolvedValue(stubProvider("http://ollama:11434"));
    let capturedRouter: SmartRouter | undefined;

    const service = await createCliIndexingService({
      workspaceRoot: "/ws",
      config: {},
      endpoints: [endpoint],
      providerFactory: { createFromEndpoint } as never,
      indexingServiceFactory: (_root, router) => {
        capturedRouter = router;
        return { isReady: () => true } as never;
      },
    });

    expect(service).not.toBeNull();
    expect(createFromEndpoint).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({ model: "nomic-embed-text" }),
    );
    const route = capturedRouter?.select("embedding");
    expect(route?.model.id).toBe("nomic-embed-text");
    expect(route?.provider.config.baseUrl).toBe("http://ollama:11434");
  });

  it("uses an explicit indexing.embeddingModel when no endpoint advertises one", async () => {
    const config: ChampConfig = {
      provider: "ollama",
      providers: { ollama: { model: "llama3.1" } },
      indexing: {
        embeddingProvider: "ollama",
        embeddingModel: "nomic-embed-text",
      },
    };
    const createFromChampConfig = vi
      .fn()
      .mockResolvedValue(stubProvider("http://localhost:11434"));
    let capturedRouter: SmartRouter | undefined;

    await createCliIndexingService({
      workspaceRoot: "/ws",
      config,
      providerFactory: { createFromChampConfig } as never,
      indexingServiceFactory: (_root, router) => {
        capturedRouter = router;
        return { isReady: () => true } as never;
      },
    });

    expect(createFromChampConfig).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama" }),
      expect.anything(),
    );
    const model = capturedRouter?.select("embedding")?.model as
      | DiscoveredModel
      | undefined;
    expect(model?.id).toBe("nomic-embed-text");
    expect(model?.providerType).toBe("ollama");
  });
});
