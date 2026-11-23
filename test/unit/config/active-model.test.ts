import { describe, expect, it, vi } from "vitest";
import {
  selectActiveModel,
  type ActiveModelRegistry,
} from "@/config/active-model";
import type { Endpoint } from "@/config/provider-model";

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    id: "ep_a",
    name: "Local MLX",
    provider: "openai-compatible",
    baseUrl: "http://localhost:8080/v1",
    credential: null,
    enabled: true,
    isDefault: true,
    models: [{ id: "qwen3.5-4b" }, { id: "llama-3.1-8b" }],
    ...overrides,
  };
}

function registryWith(endpoints: Endpoint[]) {
  const setAssignment = vi.fn(async () => {});
  const registry: ActiveModelRegistry = {
    list: async () => endpoints,
    setAssignment,
  };
  return { registry, setAssignment };
}

describe("selectActiveModel", () => {
  it("does not write an assignment when no endpoint matches", async () => {
    const { registry, setAssignment } = registryWith([endpoint()]);

    const result = await selectActiveModel(registry, "vllm", "qwen3.5-4b");

    expect(result.ok).toBe(false);
    expect(setAssignment).not.toHaveBeenCalled();
    expect(result.reason).toContain("no endpoint");
  });

  it("matches by provider kind and stores the chosen model", async () => {
    const { registry, setAssignment } = registryWith([endpoint()]);

    const result = await selectActiveModel(
      registry,
      "openai-compatible",
      "llama-3.1-8b",
    );

    expect(result).toMatchObject({
      ok: true,
      endpointId: "ep_a",
      model: "llama-3.1-8b",
    });
    expect(setAssignment).toHaveBeenCalledWith(
      "default",
      "ep_a",
      "llama-3.1-8b",
    );
  });

  it("matches by endpoint id or name and falls back to the first model", async () => {
    const { registry, setAssignment } = registryWith([endpoint()]);

    const byId = await selectActiveModel(registry, "ep_a");
    const byName = await selectActiveModel(registry, "LOCAL MLX");

    expect(byId.model).toBe("qwen3.5-4b");
    expect(byName.ok).toBe(true);
    expect(setAssignment).toHaveBeenCalledTimes(2);
  });

  it("uses the catalog default when the endpoint has no discovered models", async () => {
    const { registry, setAssignment } = registryWith([
      endpoint({ provider: "ollama", models: [] }),
    ]);

    const result = await selectActiveModel(registry, "ollama");

    expect(result.ok).toBe(true);
    expect(result.model).toBe("qwen3:8b");
    expect(setAssignment).toHaveBeenCalledWith("default", "ep_a", "qwen3:8b");
  });
});
