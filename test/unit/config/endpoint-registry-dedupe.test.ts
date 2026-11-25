import { describe, expect, it } from "vitest";
import { EndpointRegistry } from "@/config/endpoint-registry";
import type { ProvidersDocument } from "@/config/provider-model";
import type { ProviderRepository } from "@/config/provider-persistence";

class InMemoryRepo implements ProviderRepository {
  private doc: ProvidersDocument = {
    version: 1,
    endpoints: [],
    assignments: {},
  };
  async read(): Promise<ProvidersDocument> {
    return structuredClone(this.doc);
  }
  async write(doc: ProvidersDocument): Promise<void> {
    this.doc = structuredClone(doc);
  }
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

async function registry() {
  return new EndpointRegistry({
    repository: new InMemoryRepo(),
    credentials: {
      get: async () => undefined,
      set: async () => ({ persisted: true, status: "keyring" as const }),
      delete: async () => ({ persisted: true, status: "keyring" as const }),
    },
    discovery: {
      discoverModels: async () => [],
      testEndpoint: async () => ({ ok: true, source: "mock" as const }),
    },
  });
}

describe("EndpointRegistry dedupe", () => {
  it("collapses duplicate base URLs and migrates assignments", async () => {
    const reg = await registry();
    const a = await reg.add({
      name: "local-llm",
      provider: "openai-compatible",
      baseUrl: "http://192.168.1.64:8030/v1",
    });
    const b = await reg.add({
      name: "mm",
      provider: "openai-compatible",
      baseUrl: "http://192.168.1.64:8030/v1/",
    });
    await reg.setAssignment(
      "default",
      b.id,
      "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    );

    const result = await reg.deduplicateByBaseUrl();

    expect(result.removed).toEqual([b.id]);
    const endpoints = await reg.list();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].id).toBe(a.id);
    const assignment = await reg.resolveAssignment("default");
    expect(assignment?.endpoint.id).toBe(a.id);
    expect(assignment?.model).toBe("mlx-community/Qwen2.5-0.5B-Instruct-4bit");
  });
});
