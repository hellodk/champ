import { describe, expect, it, vi } from "vitest";
import { createCanonicalRouteSource } from "@/config/canonical-route-source";
import type { ProvidersDocument } from "@/config/provider-model";

function doc(): ProvidersDocument {
  return {
    version: 1,
    endpoints: [
      {
        id: "ep_a",
        name: "A",
        provider: "ollama",
        credential: null,
        enabled: true,
        isDefault: true,
        models: [
          {
            id: "m1",
            capabilitySet: { chat: "yes", tools: "no", embeddings: "no" },
            contextWindow: 16_000,
          },
        ],
      },
      {
        id: "ep_b",
        name: "B",
        provider: "openai-compatible",
        credential: null,
        enabled: true,
        isDefault: false,
        models: [{ id: "m2" }],
      },
    ],
    assignments: {},
    routingMode: "auto",
    selection: {
      scope: { kind: "endpoint", endpointId: "ep_a" },
      preference: "balanced",
      pinned: null,
    },
  };
}

describe("canonical route source", () => {
  it("maps a canonical decision to a provider without name heuristics", () => {
    const provider = { name: "A" } as never;
    const resolveProvider = vi.fn((endpointId: string, modelId: string) =>
      endpointId === "ep_a" && modelId === "m1"
        ? { provider, name: "A", type: "ollama" }
        : null,
    );
    const source = createCanonicalRouteSource({
      doc: doc(),
      resolveProvider,
    });

    const result = source.select({ task: "chat" });
    expect(result?.model.id).toBe("m1");
    expect(result?.model.contextWindow).toBe(16_000);
    expect(result?.provider).toBe(provider);
    expect(result?.reason).toContain("balanced ranking");
    expect(resolveProvider).toHaveBeenCalledWith("ep_a", "m1");
  });

  it("returns null when the canonical target has no executable provider", () => {
    const source = createCanonicalRouteSource({
      doc: doc(),
      resolveProvider: () => null,
    });
    expect(source.select({ task: "chat" })).toBeNull();
  });

  it("leaves context unknown instead of inventing 8192", () => {
    const pinned = doc();
    pinned.selection = {
      scope: { kind: "endpoint", endpointId: "ep_b" },
      preference: "balanced",
      pinned: { endpointId: "ep_b", modelId: "m2" },
    };
    const source = createCanonicalRouteSource({
      doc: pinned,
      resolveProvider: () => ({
        provider: { name: "B" } as never,
        name: "B",
        type: "openai",
      }),
    });

    expect(source.select({ task: "chat" })?.model.contextWindow).toBe(0);
  });

  it("keeps the same target across messages when a session key is supplied", () => {
    const source = createCanonicalRouteSource({
      doc: doc(),
      resolveProvider: (endpointId) => ({
        provider: { name: endpointId } as never,
        name: endpointId,
        type: "ollama",
      }),
    });
    const first = source.select({ task: "chat", sessionKey: "sess-1" });
    const second = source.select({ task: "chat", sessionKey: "sess-1" });
    expect(first?.model.id).toBe("m1");
    expect(second?.model.id).toBe("m1");
    expect(source.getLastDecision()?.source).toBe("session-affinity");
  });

  it("exposes safe alternatives and resolves them without new selection", () => {
    const failoverDoc = doc();
    failoverDoc.selection = {
      scope: { kind: "pool", poolId: "local" },
      preference: "balanced",
      pinned: null,
      failover: { enabled: true, maxAttempts: 1 },
    };
    failoverDoc.pools = [
      { id: "local", name: "Local", endpointIds: ["ep_a", "ep_b"] },
    ];
    const source = createCanonicalRouteSource({
      doc: failoverDoc,
      resolveProvider: (endpointId) => ({
        provider: { name: endpointId } as never,
        name: endpointId,
        type: "ollama",
      }),
    });
    const decision = source.select({ task: "chat" })!.decision!;
    const alternatives = source.safeAlternatives!(
      decision,
      decision.target!,
      "timeout",
    );
    expect(alternatives).toHaveLength(1);
    const resolved = source.resolveTarget!(alternatives[0]);
    expect(resolved?.model.id).toBe("m2");
    expect(resolved?.provider.name).toBe("ep_b");
    expect(source.getLastDecision()?.target).toEqual(decision.target);
  });
});
