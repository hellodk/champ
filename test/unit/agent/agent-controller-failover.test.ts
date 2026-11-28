import { describe, expect, it, vi } from "vitest";
import { AgentController } from "@/agent/agent-controller";
import type { RouteDecision } from "@/config/model-router";
import type { LLMProvider, StreamDelta } from "@/providers/types";
import type { SmartRouter } from "@/providers/smart-router";
import type { ToolRegistry } from "@/tools/registry";

function makeProvider(
  name: string,
  model: string,
  deltas: StreamDelta[],
): LLMProvider {
  const chat = vi.fn().mockImplementation(async function* () {
    for (const delta of deltas) yield delta;
  });
  return {
    name,
    config: { provider: name, model, maxTokens: 1024, temperature: 0.7 },
    chat,
    complete: vi.fn(),
    supportsToolUse: () => true,
    supportsStreaming: () => true,
    countTokens: () => 10,
    modelInfo: () => ({
      id: model,
      name: model,
      provider: name,
      contextWindow: 4096,
      maxOutputTokens: 1024,
      supportsToolUse: true,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: vi.fn(),
  } as unknown as LLMProvider;
}

const tools = {
  getAll: vi.fn(() => []),
  getDefinitions: vi.fn(() => []),
  execute: vi.fn(async () => ({ success: true, output: "" })),
} as unknown as ToolRegistry;

const primaryTarget = { endpointId: "ep_a", modelId: "primary" };
const altTarget = { endpointId: "ep_b", modelId: "alternate" };

function decision(): RouteDecision {
  return {
    target: primaryTarget,
    scope: "pool",
    scopeKey: "local",
    pinned: false,
    source: "selection",
    reason: "balanced ranking",
    preference: "balanced",
    failover: { enabled: true, maxAttempts: 1 },
    candidates: [primaryTarget, altTarget],
    excluded: [],
    alternatives: [altTarget],
    requestId: "req-1",
  };
}

function routerWithFailover(
  decisionValue: RouteDecision,
  primary: LLMProvider,
  alternate: LLMProvider,
): SmartRouter {
  return {
    select: vi.fn(() => ({
      model: {
        id: "primary",
        providerName: "ep_a",
        providerType: "ollama",
        capabilities: ["general"],
        speed: "medium",
        contextWindow: 4096,
        sizeHint: "",
        quantizationLevel: "",
        source: "discovered",
      },
      provider: primary,
      reason: decisionValue.reason,
      decision: decisionValue,
    })),
    getLastRouteDecision: vi.fn(() => decisionValue),
    safeAlternatives: vi.fn((_d: unknown, _f: unknown, error: string) =>
      error === "auth" ? [] : [altTarget],
    ),
    resolveTarget: vi.fn(() => ({
      model: {
        id: "alternate",
        providerName: "ep_b",
        providerType: "ollama",
        capabilities: ["general"],
        speed: "medium",
        contextWindow: 4096,
        sizeHint: "",
        quantizationLevel: "",
        source: "discovered",
      },
      provider: alternate,
      reason: "failover",
    })),
  } as unknown as SmartRouter;
}

const done = (): StreamDelta => ({
  type: "done",
  usage: { inputTokens: 4, outputTokens: 2 },
});

describe("AgentController safe failover", () => {
  it("replays a clean failure once and records both attempts", async () => {
    const primary = makeProvider("primary", "primary", [
      { type: "error", error: "HTTP 503 unavailable" },
    ]);
    const alternate = makeProvider("alternate", "alternate", [
      { type: "text", text: "recovered" },
      done(),
    ]);
    const route = decision();
    const controller = new AgentController(primary, tools);
    const smartRouter = routerWithFailover(route, primary, alternate);
    controller.setSmartRouter(smartRouter);
    const deltas: StreamDelta[] = [];
    controller.onStreamDelta((delta) => deltas.push(delta));
    const onFailover = vi.fn();
    controller.setRoutingObserver({ onDecision: vi.fn(), onFailover });

    const result = await controller.processMessage("hello", {
      correlation: { sessionId: "sess-1" },
    });

    expect(result.text).toContain("recovered");
    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(alternate.chat).toHaveBeenCalledTimes(1);
    expect(deltas.some((d) => d.type === "error")).toBe(false);
    expect(onFailover).toHaveBeenCalledWith(
      expect.objectContaining({
        attempt: 1,
        from: primaryTarget,
        to: altTarget,
        error: "server",
        sessionId: "sess-1",
      }),
    );
  });

  it("does not replay after text has reached the UI", async () => {
    const primary = makeProvider("primary", "primary", [
      { type: "text", text: "partial" },
      { type: "error", error: "HTTP 500 failed" },
    ]);
    const alternate = makeProvider("alternate", "alternate", [
      { type: "text", text: "recovered" },
      done(),
    ]);
    const controller = new AgentController(primary, tools);
    controller.setSmartRouter(
      routerWithFailover(decision(), primary, alternate),
    );
    const deltas: StreamDelta[] = [];
    controller.onStreamDelta((delta) => deltas.push(delta));

    await controller.processMessage("hello");

    expect(alternate.chat).not.toHaveBeenCalled();
    expect(deltas.some((d) => d.type === "error")).toBe(true);
  });

  it("does not replay terminal auth failures", async () => {
    const primary = makeProvider("primary", "primary", [
      { type: "error", error: "HTTP 401 invalid key" },
    ]);
    const alternate = makeProvider("alternate", "alternate", [done()]);
    const controller = new AgentController(primary, tools);
    controller.setSmartRouter(
      routerWithFailover(decision(), primary, alternate),
    );

    await controller.processMessage("hello");

    expect(alternate.chat).not.toHaveBeenCalled();
  });
});
