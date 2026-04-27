import { describe, it, expect, vi } from "vitest";
import { AgentController } from "../../../src/agent/agent-controller";
import { ToolRegistry } from "../../../src/tools/registry";

function makeProvider(supportsTools: boolean, name: string) {
  const chat = vi.fn(async function* () {
    yield { type: "text" as const, text: "answer" };
    yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } };
  });
  return {
    name,
    config: { provider: name, model: name },
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
    withModel: () => makeProvider(supportsTools, name),
  };
}

function makeRouter(routedProvider: ReturnType<typeof makeProvider>) {
  return {
    select: () => ({
      model: {
        id: routedProvider.name,
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
});
