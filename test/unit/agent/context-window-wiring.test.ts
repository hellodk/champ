import { describe, it, expect, vi } from "vitest";
import { AgentController } from "../../../src/agent/agent-controller";
import { ToolRegistry } from "../../../src/tools/registry";

function makeProvider(contextWindow = 100) {
  const chat = vi.fn(async function* () {
    yield { type: "text" as const, text: "ok" };
    yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } };
  });
  return {
    name: "test",
    config: { provider: "test", model: "test" },
    modelInfo: () => ({
      id: "test",
      name: "test",
      provider: "test",
      contextWindow,
      maxOutputTokens: 32,
      supportsToolUse: false,
      supportsImages: false,
      supportsStreaming: true,
    }),
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    supportsImages: () => false,
    countTokens: (text: string) => Math.ceil(text.length / 4),
    chat,
    complete: vi.fn(async function* () {
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }),
    withModel: () => makeProvider(contextWindow),
  };
}

describe("AgentController — context window compression", () => {
  it("drops oldest messages when history exceeds context window", async () => {
    const provider = makeProvider(80); // tiny context
    const registry = new ToolRegistry();
    const ctrl = new AgentController(provider as never, registry, "/tmp");

    // Pre-fill with 10 long messages (~25 tokens each = ~250 tokens total, way over 80)
    ctrl.setHistory(
      Array.from({ length: 10 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: "a".repeat(80), // ~20 tokens each
      })),
    );

    await ctrl.processMessage("new question");

    const chatCall = provider.chat.mock.calls[0];
    const messages: Array<{ role: string }> = chatCall[0];
    // System message + some turns — must be fewer than 12 (10 history + system + new msg)
    expect(messages.length).toBeLessThan(12);
  });

  it("always preserves the most recent user message", async () => {
    const provider = makeProvider(80);
    const registry = new ToolRegistry();
    const ctrl = new AgentController(provider as never, registry, "/tmp");

    ctrl.setHistory(
      Array.from({ length: 8 }, (_, i) => ({
        role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
        content: "a".repeat(80),
      })),
    );

    await ctrl.processMessage("keep this");

    const chatCall = provider.chat.mock.calls[0];
    const messages: Array<{ role: string; content: unknown }> = chatCall[0];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    expect(
      typeof lastUser?.content === "string" ? lastUser.content : "",
    ).toContain("keep this");
  });

  it("does not drop messages when history fits within context window", async () => {
    const provider = makeProvider(8192); // large window
    const registry = new ToolRegistry();
    const ctrl = new AgentController(provider as never, registry, "/tmp");

    ctrl.setHistory([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);

    await ctrl.processMessage("another");

    const chatCall = provider.chat.mock.calls[0];
    const messages: Array<{ role: string }> = chatCall[0];
    // system + 2 history + new user = 4
    expect(messages.length).toBe(4);
  });
});
