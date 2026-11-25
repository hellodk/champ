/**
 * Regression tests for issue #176: an oversized first turn must be rejected
 * locally, after nonessential prompt material has been reduced.
 */
import { describe, expect, it, vi } from "vitest";
import { AgentController } from "../../../src/agent/agent-controller";
import { SystemPromptBuilder } from "../../../src/agent/system-prompt-builder";
import type { LLMMessage } from "../../../src/providers/types";
import { ToolRegistry } from "../../../src/tools/registry";

function makeProvider(contextWindow: number, maxTokens: number) {
  const chat = vi.fn(async function* () {
    yield { type: "text" as const, text: "ok" };
    yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } };
  });
  const provider = {
    name: "test",
    config: { provider: "test", model: "test", maxTokens },
    modelInfo: () => ({
      id: "test",
      name: "test",
      provider: "test",
      contextWindow,
      maxOutputTokens: maxTokens,
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
    withModel: () => provider,
  };
  return { provider, chat };
}

describe("oversized first turn (#176)", () => {
  it("does not call the provider when even the reduced prompt is over budget", async () => {
    const { provider, chat } = makeProvider(1200, 500);
    const ctrl = new AgentController(
      provider as never,
      new ToolRegistry(),
      "/tmp",
      new SystemPromptBuilder("agent"),
    );
    const deltas: string[] = [];
    ctrl.onStreamDelta((delta) => {
      if (delta.type === "error") deltas.push(delta.error);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warnings = "";

    try {
      await ctrl.processMessage("hello");
      warnings = warn.mock.calls.join("\n");
    } finally {
      warn.mockRestore();
    }

    expect(chat).not.toHaveBeenCalled();
    expect(deltas.join("\n")).toMatch(/context window|too large/i);
    expect(warnings).toMatch(/system prompt|newest user message/i);
  });

  it("reduces the repo map before touching the user message", async () => {
    const { provider, chat } = makeProvider(20_000, 2000);
    const ctrl = new AgentController(
      provider as never,
      new ToolRegistry(),
      "/tmp",
      new SystemPromptBuilder("agent"),
    );
    ctrl.setRepoMapProvider({
      getRepoMap: async () =>
        `REPO_MAP_START ${"r".repeat(80_000)} REPO_MAP_END`,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warnings = "";

    try {
      await ctrl.processMessage("new question");
      warnings = warn.mock.calls.join("\n");
    } finally {
      warn.mockRestore();
    }

    expect(chat).toHaveBeenCalledTimes(1);
    const messages = chat.mock.calls[0][0] as LLMMessage[];
    const system = messages.find((m) => m.role === "system");
    expect(typeof system?.content).toBe("string");
    const content = String(system?.content);
    expect(content).not.toContain("r".repeat(4000));
    expect(messages[messages.length - 1].content).toBe("new question");
    expect(warnings).toMatch(/repo map/i);
  });
});
