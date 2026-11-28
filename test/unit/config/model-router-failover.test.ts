import { describe, expect, it } from "vitest";
import { ModelRouter } from "@/config/model-router";
import type {
  DiscoveredModel,
  Endpoint,
  ProvidersDocument,
} from "@/config/provider-model";

const chatModel = (id: string): DiscoveredModel => ({
  id,
  capabilitySet: {
    chat: "yes",
    tools: "unknown",
    embeddings: "no",
    images: "unknown",
    structuredOutput: "unknown",
  },
  contextWindow: 16_000,
});

function endpoint(id: string, models: DiscoveredModel[]): Endpoint {
  return {
    id,
    name: id,
    provider: "ollama",
    credential: null,
    enabled: true,
    isDefault: false,
    models,
  };
}

function documentWith(failover?: {
  enabled: boolean;
  maxAttempts?: number;
}): ProvidersDocument {
  return {
    version: 1,
    endpoints: [
      endpoint("ep_a", [chatModel("m1")]),
      endpoint("ep_b", [chatModel("m2")]),
    ],
    assignments: {},
    routingMode: "auto",
    selection: {
      scope: { kind: "pool", poolId: "local" },
      preference: "balanced",
      pinned: null,
      ...(failover ? { failover } : {}),
    },
    pools: [{ id: "local", name: "Local", endpointIds: ["ep_a", "ep_b"] }],
  };
}

describe("ModelRouter safe failover", () => {
  it("is disabled unless explicitly enabled", () => {
    const router = new ModelRouter();
    const decision = router.decide({ task: "coding", doc: documentWith() });
    expect(decision.failover).toEqual({ enabled: false, maxAttempts: 1 });
    expect(
      router.safeAlternatives(decision, decision.target!, "timeout"),
    ).toEqual([]);
  });

  it("returns ranked alternatives up to the configured attempt budget", () => {
    const router = new ModelRouter();
    const decision = router.decide({
      task: "coding",
      doc: documentWith({ enabled: true, maxAttempts: 2 }),
    });
    const alternatives = router.safeAlternatives(
      decision,
      decision.target!,
      "timeout",
    );
    expect(alternatives).toHaveLength(1);
    expect(alternatives[0]?.endpointId).toBe("ep_b");
  });

  it("never fails over on terminal errors or session-affinity decisions", () => {
    const router = new ModelRouter();
    const decision = router.decide({
      task: "coding",
      doc: documentWith({ enabled: true }),
    });
    expect(router.safeAlternatives(decision, decision.target!, "auth")).toEqual(
      [],
    );
    expect(
      router.safeAlternatives(decision, decision.target!, "model_not_found"),
    ).toEqual([]);

    const sticky = router.decide({
      task: "coding",
      doc: documentWith({ enabled: true }),
      sessionKey: "sess-1",
    });
    const repeated = router.decide({
      task: "coding",
      doc: documentWith({ enabled: true }),
      sessionKey: "sess-1",
    });
    expect(repeated.source).toBe("session-affinity");
    expect(
      router.safeAlternatives(repeated, sticky.target!, "timeout"),
    ).toEqual([]);
  });

  it("never fails over from an exact pinned target", () => {
    const router = new ModelRouter();
    const doc = documentWith({ enabled: true });
    doc.selection!.pinned = { endpointId: "ep_a", modelId: "m1" };
    const decision = router.decide({ task: "coding", doc });
    expect(
      router.safeAlternatives(decision, decision.target!, "timeout"),
    ).toEqual([]);
  });
});
