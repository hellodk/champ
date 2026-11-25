/**
 * TDD: SmartRouter must apply routing.tieBreak to equal-score models instead
 * of always retaining the first candidate.
 */
import { describe, expect, it, vi } from "vitest";
import { SmartRouter } from "@/providers/smart-router";
import type { DiscoveredModel } from "@/providers/smart-router";

function makeModel(id: string): DiscoveredModel {
  return {
    id,
    providerName: id,
    providerType: "ollama",
    capabilities: ["coding"],
    speed: "medium",
    contextWindow: 8192,
    sizeHint: "",
    quantizationLevel: "",
    source: "discovered",
  };
}

function makeRouter(): SmartRouter {
  const router = new SmartRouter();
  for (const id of ["z-model", "a-model"]) {
    router.registerProvider(
      id,
      { config: { model: id, baseUrl: "http://127.0.0.1:11434" } } as never,
      "ollama",
      "http://127.0.0.1:11434",
    );
  }
  router.seedDiscoveredModels([makeModel("z-model"), makeModel("a-model")]);
  return router;
}

describe("SmartRouter tie breaking", () => {
  it("defaults to deterministic model-id ordering", () => {
    expect(makeRouter().select("coding")?.model.id).toBe("a-model");
  });

  it("honours the configured last-model tie break", () => {
    const router = makeRouter();
    router.setTieBreak("last");
    expect(router.select("coding")?.model.id).toBe("a-model");
  });

  it("keeps the first discovered model for the first-model tie break", () => {
    const router = makeRouter();
    const onChange = vi.fn();
    router.onChange(onChange);
    router.setTieBreak("first");
    expect(router.select("coding")?.model.id).toBe("z-model");
  });
});
