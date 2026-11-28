import { describe, expect, it, vi } from "vitest";
import { AgentController } from "@/agent/agent-controller";
import type { RouteDecision } from "@/config/model-router";
import type { LLMProvider, StreamDelta } from "@/providers/types";
import type { SmartRouter } from "@/providers/smart-router";
import type { ToolRegistry } from "@/tools/registry";

function providerWithDeltas(deltas: StreamDelta[]): LLMProvider {
  return {
    name: "mock",
    config: {
      provider: "mock",
      model: "test",
      maxTokens: 1024,
      temperature: 0.7,
    },
    chat: vi.fn().mockImplementation(async function* () {
      for (const delta of deltas) yield delta;
    }),
    complete: vi.fn(),
    supportsToolUse: () => true,
    supportsStreaming: () => true,
    countTokens: () => 10,
    modelInfo: () => ({
      id: "test",
      name: "Test",
      provider: "mock",
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

function routedRouter(
  decision: RouteDecision,
  provider: LLMProvider,
): SmartRouter {
  return {
    select: vi.fn(() => ({
      model: {
        id: "test",
        providerName: "ep_a",
        providerType: "ollama",
        capabilities: ["general"],
        speed: "medium",
        contextWindow: 4096,
        sizeHint: "",
        quantizationLevel: "",
        source: "discovered",
      },
      provider,
      reason: decision.reason,
      decision,
    })),
    getLastRouteDecision: vi.fn(() => decision),
  } as unknown as SmartRouter;
}

function decision(): RouteDecision {
  return {
    target: { endpointId: "ep_a", modelId: "test" },
    scope: "endpoint",
    scopeKey: "ep_a",
    pinned: true,
    source: "pinned",
    reason: "explicit selection",
    preference: "balanced",
    candidates: [],
    excluded: [],
    alternatives: [],
    requestId: "req_1",
    sessionKey: "sess_1",
  };
}

function runtimeSink() {
  const release = vi.fn();
  return {
    release,
    beginRequest: vi.fn(() => release),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn(),
  };
}

describe("AgentController routing runtime and decision observability", () => {
  it("records success and emits a sanitized decision for the canonical target", async () => {
    const provider = providerWithDeltas([
      { type: "text", text: "ok" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 2 } },
    ]);
    const route = decision();
    const controller = new AgentController(provider, tools);
    const smartRouter = routedRouter(route, provider);
    controller.setSmartRouter(smartRouter);
    const sink = runtimeSink();
    controller.setRoutingRuntime(sink);
    const onDecision = vi.fn();
    controller.setRoutingObserver({ onDecision });

    await controller.processMessage("secret-user-text", {
      correlation: { sessionId: "sess_1" },
    });

    expect(smartRouter.select).toHaveBeenCalledWith(
      "coding",
      undefined,
      "sess_1",
    );
    expect(sink.beginRequest).toHaveBeenCalledWith(route.target);
    expect(sink.recordSuccess).toHaveBeenCalledWith(
      route.target,
      expect.any(Number),
      expect.any(Number),
    );
    expect(sink.recordFailure).not.toHaveBeenCalled();
    expect(sink.release).toHaveBeenCalled();
    const event = onDecision.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      task: "coding",
      decision: route,
      selectedProvider: "mock",
      selectedModel: "test",
      actualProvider: "mock",
      actualModel: "test",
    });
    expect(JSON.stringify(event)).not.toContain("secret-user-text");
  });

  it("classifies stream errors without recording them as success", async () => {
    const provider = providerWithDeltas([
      { type: "error", error: "HTTP 429 rate limit exceeded" },
    ]);
    const route = decision();
    const controller = new AgentController(provider, tools);
    controller.setSmartRouter(routedRouter(route, provider));
    const sink = runtimeSink();
    controller.setRoutingRuntime(sink);

    await controller.processMessage("hello");

    expect(sink.recordFailure).toHaveBeenCalledWith(route.target, "rate_limit");
    expect(sink.recordSuccess).not.toHaveBeenCalled();
    expect(sink.release).toHaveBeenCalled();
  });

  it("emits sanitized failure events with the failure class only", async () => {
    const provider = providerWithDeltas([
      {
        type: "error",
        error: "HTTP 401 invalid api key sk-secret-value",
      },
    ]);
    const route = decision();
    const controller = new AgentController(provider, tools);
    controller.setSmartRouter(routedRouter(route, provider));
    const onFailure = vi.fn();
    controller.setRoutingObserver({ onDecision: vi.fn(), onFailure });

    await controller.processMessage("secret-user-text", {
      correlation: { sessionId: "sess_1" },
    });

    const event = onFailure.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event).toMatchObject({
      target: route.target,
      error: "auth",
      requestId: "req_1",
      sessionId: "sess_1",
    });
    expect(JSON.stringify(event)).not.toContain("sk-secret-value");
    expect(JSON.stringify(event)).not.toContain("secret-user-text");
  });
});
