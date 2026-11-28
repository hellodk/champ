import { describe, expect, it } from "vitest";
import { initializeCliRouter } from "@/cli/smart-router-init";
import type { Endpoint, ProvidersDocument } from "@/config/provider-model";
import type { LLMProvider } from "@/providers/types";

function endpoint(id: string, name: string, modelId: string): Endpoint {
  return {
    id,
    name,
    provider: "ollama",
    baseUrl: `http://localhost:11434/${id}`,
    credential: null,
    enabled: true,
    isDefault: id === "ep_a",
    models: [{ id: modelId, capabilitySet: { chat: "yes" } }],
  };
}

function provider(name: string): LLMProvider {
  return {
    name,
    config: { provider: name, model: "", maxTokens: 1, temperature: 0 },
  } as never;
}

const secretProvider = { get: async () => undefined };

describe("CLI router initialization", () => {
  it("uses the canonical selection instead of cross-endpoint task assignments", async () => {
    const epA = endpoint("ep_a", "A", "model-a");
    const epB = endpoint("ep_b", "B", "model-b");
    const doc: ProvidersDocument = {
      version: 1,
      endpoints: [epA, epB],
      assignments: {
        coding: { endpointId: "ep_a", model: "model-a" },
      },
      routingMode: "auto",
      selection: {
        scope: { kind: "endpoint", endpointId: "ep_b" },
        preference: "balanced",
        pinned: { endpointId: "ep_b", modelId: "model-b" },
      },
    };

    const router = await initializeCliRouter({
      endpoint: epA,
      primaryProvider: provider("A"),
      endpoints: [epA, epB],
      assignments: doc.assignments,
      secretProvider,
      createProvider: async (ep) => provider(ep.name),
      doc,
    });

    const result = router?.select("coding");
    expect(result?.model.id).toBe("model-b");
    expect(result?.model.providerName).toBe("B");
  });
});
