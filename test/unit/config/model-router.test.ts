import { describe, expect, it } from "vitest";
import { ModelRouter } from "@/config/model-router";
import { RuntimeState } from "@/config/runtime-status";
import type {
  DiscoveredModel,
  Endpoint,
  ProvidersDocument,
} from "@/config/provider-model";

function model(
  id: string,
  opts: Partial<DiscoveredModel> = {},
): DiscoveredModel {
  return { id, ...opts };
}

function endpoint(
  id: string,
  provider: Endpoint["provider"] = "ollama",
  models: DiscoveredModel[] = [],
  extra: Partial<Endpoint> = {},
): Endpoint {
  return {
    id,
    name: `${id} name`,
    provider,
    baseUrl: `http://${id}.local:11434`,
    credential: null,
    enabled: true,
    isDefault: false,
    models,
    ...extra,
  };
}

function doc(endpoints: Endpoint[], extra: Partial<ProvidersDocument> = {}) {
  return {
    version: 1 as const,
    endpoints,
    assignments: {},
    routingMode: "auto" as const,
    ...extra,
  };
}

const chatModel = (id: string) =>
  model(id, {
    capabilitySet: {
      chat: "yes",
      tools: "unknown",
      embeddings: "no",
      images: "unknown",
      structuredOutput: "unknown",
    },
    contextWindow: 32_000,
  });

const embedModel = (id: string) =>
  model(id, {
    capabilitySet: {
      chat: "no",
      tools: "no",
      embeddings: "yes",
      images: "no",
      structuredOutput: "no",
    },
    contextWindow: 8_000,
  });

describe("ModelRouter", () => {
  it("keeps endpoint+model identity distinct when two endpoints expose the same model id", () => {
    const endpoints = [
      endpoint("ep_a", "ollama", [chatModel("same-id")]),
      endpoint("ep_b", "ollama", [
        model("same-id", {
          capabilitySet: chatModel("x").capabilitySet,
          contextWindow: 128_000,
        }),
      ]),
    ];
    const router = new ModelRouter();
    const decision = router.decide({
      task: "coding",
      doc: doc(endpoints, {
        selection: {
          scope: { kind: "endpoint", endpointId: "ep_a" },
          preference: "balanced",
          pinned: null,
        },
      }),
    });
    expect(decision.target?.endpointId).toBe("ep_a");
    expect(decision.target?.modelId).toBe("same-id");
    expect(decision.scope).toBe("endpoint");
    expect(decision.alternatives.some((a) => a.endpointId === "ep_b")).toBe(
      false,
    );
  });

  it("respects an exact pinned endpoint/model pair and records why", () => {
    const endpoints = [
      endpoint("ep_a", "ollama", [chatModel("small"), chatModel("large")]),
    ];
    const router = new ModelRouter();
    const decision = router.decide({
      task: "coding",
      doc: doc(endpoints, {
        selection: {
          scope: { kind: "endpoint", endpointId: "ep_a" },
          preference: "balanced",
          pinned: { endpointId: "ep_a", modelId: "small" },
        },
      }),
    });
    expect(decision.pinned).toBe(true);
    expect(decision.target?.modelId).toBe("small");
    expect(decision.reason).toContain("pinned endpoint/model pair");
    expect(decision.alternatives).toHaveLength(0);
  });

  it("does not silently move between endpoints on SmartRoute", () => {
    const endpoints = [
      endpoint("ep_a", "ollama", [chatModel("a-model")]),
      endpoint("ep_b", "vllm", [chatModel("b-model")]),
    ];
    const decision = new ModelRouter().decide({
      task: "chat",
      doc: doc(endpoints, {
        selection: {
          scope: { kind: "endpoint", endpointId: "ep_a" },
          preference: "balanced",
          pinned: null,
        },
      }),
    });
    expect(decision.target?.endpointId).toBe("ep_a");
    expect(decision.excluded.some((e) => e.target.endpointId === "ep_b")).toBe(
      false,
    );
  });

  it("uses only enabled members of an explicit pool", () => {
    const endpoints = [
      endpoint("ep_a", "ollama", [chatModel("a")]),
      endpoint("ep_b", "ollama", [chatModel("b")], { enabled: false }),
      endpoint("ep_c", "ollama", [chatModel("c")]),
    ];
    const decision = new ModelRouter().decide({
      task: "chat",
      doc: doc(endpoints, {
        pools: [
          {
            id: "pool_local",
            name: "Local",
            endpointIds: ["ep_a", "ep_b", "ep_missing"],
            routing: { preference: "balanced", allowCloud: false },
          },
        ],
        selection: {
          scope: { kind: "pool", poolId: "pool_local" },
          preference: "balanced",
          pinned: null,
        },
      }),
    });
    expect(["ep_a", "ep_c"]).toContain(decision.target?.endpointId);
    expect(decision.excluded.some((e) => e.target.endpointId === "ep_b")).toBe(
      true,
    );
    expect(decision.scope).toBe("pool");
  });

  it("excludes cloud endpoints unless global routing explicitly allows them", () => {
    const endpoints = [
      endpoint("ep_local", "ollama", [chatModel("local")]),
      endpoint("ep_cloud", "claude", [chatModel("cloud")], {
        credential: { kind: "keyring", id: "ep_cloud" },
      }),
    ];
    const router = new ModelRouter();
    const blocked = router.decide({
      task: "coding",
      doc: doc(endpoints, {
        selection: {
          scope: { kind: "global", allowCloud: false },
          preference: "balanced",
          pinned: null,
        },
      }),
    });
    expect(
      blocked.excluded.some((e) => e.target.endpointId === "ep_cloud"),
    ).toBe(true);
    expect(blocked.target?.endpointId).not.toBe("ep_cloud");

    const allowed = router.decide({
      task: "coding",
      doc: doc(endpoints, {
        selection: {
          scope: { kind: "global", allowCloud: true },
          preference: "balanced",
          pinned: null,
        },
      }),
    });
    expect(allowed.target).not.toBeNull();
  });

  it("hard-excludes embedding models from chat tasks and enforces tool requirements", () => {
    const endpoints = [
      endpoint("ep_a", "ollama", [embedModel("embed"), chatModel("chat")]),
    ];
    const router = new ModelRouter();
    const chat = router.decide({
      task: "chat",
      doc: doc(endpoints),
      requiredCapabilities: ["tools"],
    });
    // tools is unknown for chatModel -> mandatory proof absent -> no eligible target
    expect(chat.target).toBeNull();
    expect(
      chat.excluded.some(
        (e) =>
          e.target.modelId === "embed" && e.reason.includes("embedding-only"),
      ),
    ).toBe(true);
  });

  it("enforces known context windows and leaves unknown capability unclaimed", () => {
    const endpoints = [
      endpoint("ep_a", "ollama", [chatModel("smallctx")]),
      endpoint("ep_b", "ollama", [
        model("largectx", {
          capabilitySet: chatModel("x").capabilitySet,
          contextWindow: 120_000,
        }),
      ]),
    ];
    const decision = new ModelRouter().decide({
      task: "coding",
      doc: doc(endpoints, {
        selection: {
          scope: { kind: "global", allowCloud: false },
          preference: "quality",
          pinned: null,
        },
      }),
      contextTokens: 100_000,
    });
    expect(decision.target?.modelId).toBe("largectx");
    expect(
      decision.excluded.some(
        (e) =>
          e.target.modelId === "smallctx" &&
          e.reason.includes("context window"),
      ),
    ).toBe(true);
  });

  it("is deterministic and preference-sensitive", () => {
    const endpoints = [
      endpoint("ep_a", "ollama", [
        model("strong", {
          capabilitySet: chatModel("x").capabilitySet,
          contextWindow: 64_000,
          qualityHint: 90,
        }),
        model("quick", {
          capabilitySet: chatModel("x").capabilitySet,
          contextWindow: 16_000,
          speedHint: "fast",
        }),
      ]),
    ];
    const router = new ModelRouter();
    const make = (preference: "quality" | "balanced" | "fast") =>
      router.decide({
        task: "coding",
        doc: doc(endpoints, {
          selection: {
            scope: { kind: "endpoint", endpointId: "ep_a" },
            preference,
            pinned: null,
          },
        }),
        preference,
      });
    expect(make("quality").target?.modelId).toBe("strong");
    expect(make("fast").target?.modelId).toBe("quick");
    expect(make("balanced")).toEqual(make("balanced"));
  });

  it("keeps session affinity through a task and allows scope-aware alternatives", () => {
    const endpoints = [
      endpoint("ep_a", "ollama", [chatModel("a1"), chatModel("a2")]),
      endpoint("ep_b", "ollama", [chatModel("b1")]),
    ];
    const runtime = new RuntimeState();
    const router = new ModelRouter({ runtime });
    const document = doc(endpoints, {
      pools: [
        {
          id: "p",
          name: "P",
          endpointIds: ["ep_a", "ep_b"],
          routing: { preference: "balanced", allowCloud: false },
        },
      ],
      selection: {
        scope: { kind: "pool", poolId: "p" },
        preference: "balanced",
        pinned: null,
      },
    });
    const first = router.decide({
      task: "coding",
      doc: document,
      sessionKey: "session-1",
    });
    expect(first.target).not.toBeNull();
    const second = router.decide({
      task: "coding",
      doc: document,
      sessionKey: "session-1",
    });
    expect(second.target).toEqual(first.target);
    expect(second.reason).toContain("session affinity");

    runtime.recordFailure(first.target!, "timeout");
    const third = router.decide({
      task: "coding",
      doc: document,
      sessionKey: "session-1",
    });
    expect(third.target).not.toEqual(first.target);
    expect(third.target?.endpointId).toBe(first.target?.endpointId);
  });

  it("does not offer fallback outside the active scope or for pinned selections", () => {
    const endpoints = [
      endpoint("ep_a", "ollama", [chatModel("a1"), chatModel("a2")]),
      endpoint("ep_b", "ollama", [chatModel("b1")]),
    ];
    const router = new ModelRouter();
    const decision = router.decide({
      task: "coding",
      doc: doc(endpoints, {
        selection: {
          scope: { kind: "endpoint", endpointId: "ep_a" },
          preference: "balanced",
          pinned: { endpointId: "ep_a", modelId: "a1" },
        },
      }),
    });
    expect(router.nextAlternative(decision, decision.target!, "timeout")).toBe(
      null,
    );
  });
});
