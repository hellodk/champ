import { describe, it, expect, vi } from "vitest";
import { SmartRouter } from "@/providers/smart-router";

describe("SmartRouter.seedDiscoveredModels", () => {
  it("makes a seeded embedding model selectable without network discovery", () => {
    const router = new SmartRouter();
    router.registerProvider(
      "local",
      { config: { baseUrl: "http://localhost:11434" } } as never,
      "ollama",
      "http://localhost:11434",
    );

    router.seedDiscoveredModels([
      {
        id: "nomic-embed-text",
        providerName: "local",
        providerType: "ollama",
        capabilities: ["embedding"],
        speed: "medium",
        contextWindow: 8192,
        sizeHint: "",
        quantizationLevel: "",
        source: "discovered",
      },
    ]);

    const route = router.select("embedding");
    expect(route?.model.id).toBe("nomic-embed-text");
  });

  it("does not emit when the seeded list is unchanged", () => {
    const router = new SmartRouter();
    const onChange = vi.fn();
    router.onChange(onChange);
    const models = [
      {
        id: "nomic-embed-text",
        providerName: "local",
        providerType: "ollama",
        capabilities: ["embedding"] as const,
        speed: "medium" as const,
        contextWindow: 8192,
        sizeHint: "",
        quantizationLevel: "",
        source: "discovered" as const,
      },
    ];

    router.seedDiscoveredModels(models as never);
    router.seedDiscoveredModels(models as never);

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
