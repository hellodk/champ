/**
 * TDD: a task assignment names an endpoint as well as a model. When two
 * providers expose the same model id, the router must use the assigned
 * endpoint's provider instead of the first model with a matching id.
 */
import { describe, expect, it, vi } from "vitest";
import { initializeCliRouter } from "@/cli/smart-router-init";

function endpoint(id: string, name: string) {
  return {
    id,
    name,
    provider: "openai-compatible",
    baseUrl: `http://127.0.0.1/${id}`,
    credential: null,
    enabled: true,
    isDefault: id === "primary",
    contextWindow: 8192,
    models: [
      { id: "shared-model", capabilities: ["coding", "general"] },
      { id: "chat-model", capabilities: ["chat", "general"] },
    ],
    lastDiscoveredAt: undefined,
  };
}

function provider(model = "shared-model") {
  return {
    config: { model },
    withModel: vi.fn((next: string) => provider(next)),
  };
}

async function buildRouter(
  assignments: Record<string, { endpointId: string; model: string }>,
) {
  const primary = endpoint("primary", "Primary");
  const secondary = endpoint("secondary", "Secondary");
  return initializeCliRouter({
    endpoint: primary as never,
    primaryProvider: provider() as never,
    endpoints: [primary, secondary] as never,
    assignments: assignments as never,
    secretProvider: { get: async () => undefined },
    createProvider: async () => provider() as never,
    tieBreak: "model-id",
  });
}

describe("CLI router endpoint affinity", () => {
  it("routes a task override to the assigned endpoint, not a duplicate model id", async () => {
    const router = await buildRouter({
      coding: { endpointId: "secondary", model: "shared-model" },
    });

    expect(router).not.toBeNull();
    const route = router!.select("coding");
    expect(route?.model.id).toBe("shared-model");
    expect(route?.reason).toContain("routing.coding override");
    expect(
      router!.getModels().filter((m) => m.id === "shared-model"),
    ).toHaveLength(2);
    // The provider registered for "Secondary" must own the selected model.
    expect(
      router!.getModels().find((m) => m === route?.model)?.providerName,
    ).toBe("Secondary");
  });

  it("keeps the first provider when no endpoint is specified", async () => {
    const router = await buildRouter({
      coding: { endpointId: "", model: "shared-model" },
    });

    expect(router!.select("coding")?.model.providerName).toBe("Primary");
  });
});
