/**
 * Integration test for the headless CLI router initialization path.
 *
 * This exercises the helper invoked by src/cli.ts; it deliberately does not
 * construct a SmartRouter directly or pre-seed one into AgentController.
 */
import { describe, expect, it, vi } from "vitest";
import { initializeCliRouter } from "@/cli/smart-router-init";

interface FakeProvider {
  config: { model: string; baseUrl?: string };
  withModel: ReturnType<typeof vi.fn>;
}

function fakeProvider(model: string): FakeProvider {
  return {
    config: { model },
    withModel: vi.fn((next: string) => fakeProvider(next)),
  };
}

function endpoint(
  id: string,
  name: string,
  models: Array<{ id: string; capabilities?: string[] }>,
) {
  return {
    id,
    name,
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    credential: null,
    enabled: true,
    isDefault: id === "ep-primary",
    contextWindow: 8192,
    models: models.map((m) => ({
      id: m.id,
      capabilities: m.capabilities ?? ["coding", "general"],
    })),
    lastDiscoveredAt: undefined,
  };
}

describe("headless CLI SmartRouter initialization", () => {
  it("seeds registry models into the routable pool and honours task overrides", async () => {
    const primary = fakeProvider("endpoint-first-model");
    const secondary = fakeProvider("secondary-model");
    const createProvider = vi.fn(async () => secondary as never);

    const router = await initializeCliRouter({
      endpoint: endpoint("ep-primary", "Primary", [
        { id: "endpoint-first-model" },
        { id: "task-override-model" },
        { id: "chat-model" },
      ]) as never,
      primaryProvider: primary as never,
      endpoints: [
        endpoint("ep-primary", "Primary", [
          { id: "endpoint-first-model" },
          { id: "task-override-model" },
          { id: "chat-model" },
        ]),
        endpoint("ep-secondary", "Secondary", [{ id: "secondary-model" }]),
      ] as never,
      assignments: {
        coding: { endpointId: "ep-primary", model: "task-override-model" },
        chat: { endpointId: "ep-primary", model: "chat-model" },
      } as never,
      secretProvider: { get: async () => undefined },
      createProvider,
      tieBreak: "model-id",
    });

    expect(router).not.toBeNull();
    expect(router!.getModels().map((m) => m.id)).toEqual(
      expect.arrayContaining([
        "endpoint-first-model",
        "task-override-model",
        "chat-model",
        "secondary-model",
      ]),
    );
    expect(router!.select("coding")?.model.id).toBe("task-override-model");
    expect(router!.select("chat")?.model.id).toBe("chat-model");
    expect(createProvider).toHaveBeenCalledTimes(1);
  });
});
