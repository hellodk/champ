import { describe, expect, it, vi } from "vitest";
import {
  SmartRouter,
  type DiscoveredModel,
  type RouteResult,
} from "@/providers/smart-router";

function model(id: string): DiscoveredModel {
  return {
    id,
    providerName: "ollama",
    providerType: "ollama",
    capabilities: ["general"],
    speed: "fast",
    contextWindow: 8192,
    sizeHint: "7B",
    quantizationLevel: "",
    source: "discovered",
  };
}

function provider() {
  return { name: "ollama" } as never;
}

describe("SmartRouter canonical delegation", () => {
  it("returns the canonical source decision without scoring legacy models", () => {
    const router = new SmartRouter();
    (router as unknown as { models: DiscoveredModel[] }).models = [
      model("legacy-model"),
    ];
    router.registerProvider("ollama", provider(), "ollama");

    const canonical = model("canonical-model");
    const select = vi.fn(() => ({
      model: canonical,
      provider: provider(),
      reason: "canonical decision",
    }));
    router.setCanonicalRouteSource({ select });

    const result: RouteResult | null = router.select("coding");
    expect(result?.model.id).toBe("canonical-model");
    expect(result?.reason).toBe("canonical decision");
    expect(select).toHaveBeenCalledWith({ task: "coding" });
  });

  it("does not fall back to legacy heuristics when the canonical source returns no target", () => {
    const router = new SmartRouter();
    (router as unknown as { models: DiscoveredModel[] }).models = [
      model("legacy-model"),
    ];
    router.registerProvider("ollama", provider(), "ollama");
    router.setCanonicalRouteSource({ select: () => null });

    expect(router.select("coding")).toBeNull();
  });

  it("removes the canonical source when cleared", () => {
    const router = new SmartRouter();
    (router as unknown as { models: DiscoveredModel[] }).models = [
      model("legacy-model"),
    ];
    router.registerProvider("ollama", provider(), "ollama");
    router.setCanonicalRouteSource({ select: () => null });
    expect(router.select("coding")).toBeNull();

    router.setCanonicalRouteSource(null);
    expect(router.select("coding")?.model.id).toBe("legacy-model");
  });

  it("passes the session key through to the canonical source", () => {
    const router = new SmartRouter();
    const select = vi.fn(() => null);
    router.setCanonicalRouteSource({ select });

    router.select("chat", undefined, "sess-1");
    expect(select).toHaveBeenCalledWith({ task: "chat", sessionKey: "sess-1" });

    // A different session must not reuse the cached decision of the first.
    router.select("chat", undefined, "sess-2");
    expect(select).toHaveBeenCalledTimes(2);
  });
});
