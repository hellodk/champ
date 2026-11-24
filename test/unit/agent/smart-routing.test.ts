import { describe, it, expect, vi } from "vitest";
import { AgentController } from "../../../src/agent/agent-controller";
import { ToolRegistry } from "../../../src/tools/registry";

function makeProvider(supportsTools: boolean, name: string, model = name) {
  const chat = vi.fn(async function* () {
    yield { type: "text" as const, text: "answer" };
    yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } };
  });
  return {
    name,
    config: { provider: name, model },
    modelInfo: () => ({
      id: name,
      name,
      provider: name,
      contextWindow: 8192,
      maxOutputTokens: 2048,
      supportsToolUse: supportsTools,
      supportsImages: false,
      supportsStreaming: true,
    }),
    supportsToolUse: () => supportsTools,
    supportsStreaming: () => true,
    supportsImages: () => false,
    countTokens: (t: string) => Math.ceil(t.length / 4),
    chat,
    complete: vi.fn(async function* () {
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }),
    withModel: vi.fn((nextModel: string) =>
      makeProvider(supportsTools, name, nextModel),
    ),
  };
}

function makeRouter(
  routedProvider: ReturnType<typeof makeProvider>,
  modelId = routedProvider.name,
) {
  return {
    select: () => ({
      model: {
        id: modelId,
        providerName: "test",
        providerType: "test",
        capabilities: [] as never[],
        speed: "fast" as const,
        contextWindow: 8192,
        sizeHint: "8B",
      },
      provider: routedProvider,
      reason: "test routing",
    }),
  };
}

describe("AgentController — smart routing format guard", () => {
  it("uses routed provider when both use same tool format (both prompt-based)", async () => {
    const original = makeProvider(false, "original");
    const routed = makeProvider(false, "routed");
    const ctrl = new AgentController(
      original as never,
      new ToolRegistry(),
      "/tmp",
    );
    ctrl.setSmartRouter(makeRouter(routed) as never);

    await ctrl.processMessage("hello");

    expect(routed.chat.mock.calls.length).toBe(1);
    expect(original.chat.mock.calls.length).toBe(0);
  });

  it("keeps original when formats differ and history exists", async () => {
    const original = makeProvider(true, "original"); // native tool calling
    const routed = makeProvider(false, "routed"); // prompt-based — different
    const ctrl = new AgentController(
      original as never,
      new ToolRegistry(),
      "/tmp",
    );
    ctrl.setHistory([
      { role: "user", content: "prior message" },
      { role: "assistant", content: "prior answer" },
    ]);
    ctrl.setSmartRouter(makeRouter(routed) as never);

    await ctrl.processMessage("hello");

    // Must use original — history was written with native format
    expect(original.chat.mock.calls.length).toBe(1);
    expect(routed.chat.mock.calls.length).toBe(0);
  });

  it("allows format switch on fresh conversation (empty history)", async () => {
    const original = makeProvider(true, "original");
    const routed = makeProvider(false, "routed");
    const ctrl = new AgentController(
      original as never,
      new ToolRegistry(),
      "/tmp",
    );
    // No setHistory call — history is empty
    ctrl.setSmartRouter(makeRouter(routed) as never);

    await ctrl.processMessage("hello");

    expect(routed.chat.mock.calls.length).toBe(1);
  });

  it("clones the routed provider for the routed model before sending", async () => {
    const original = makeProvider(false, "original");
    const routed = makeProvider(false, "routed", "endpoint-first-model");
    const ctrl = new AgentController(
      original as never,
      new ToolRegistry(),
      "/tmp",
    );
    ctrl.setSmartRouter(makeRouter(routed, "routed-model") as never);

    await ctrl.processMessage("hello");

    expect(routed.withModel).toHaveBeenCalledWith("routed-model");
    const used = routed.withModel.mock.results[0].value as ReturnType<
      typeof makeProvider
    >;
    expect(used.config.model).toBe("routed-model");
    expect(used.chat.mock.calls.length).toBe(1);
    expect(routed.chat.mock.calls.length).toBe(0);
  });

  it("does not clone the provider when the route matches its current model", async () => {
    const original = makeProvider(false, "original");
    const routed = makeProvider(false, "routed", "selected-model");
    const ctrl = new AgentController(
      original as never,
      new ToolRegistry(),
      "/tmp",
    );
    ctrl.setSmartRouter(makeRouter(routed, "selected-model") as never);

    await ctrl.processMessage("hello");

    expect(routed.withModel).not.toHaveBeenCalled();
    expect(routed.chat.mock.calls.length).toBe(1);
  });
});
