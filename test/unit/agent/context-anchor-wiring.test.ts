/**
 * TDD (#137): the AgentController anchors context fitting on the provider's
 * reported prompt_tokens across tool-call iterations within a single turn.
 *
 * The controller builds a fresh ContextWindowManager per user message and runs
 * one fit per iteration. A turn that calls a tool therefore fits twice. The
 * first fit has no measurement; after the provider responds, its reported
 * prompt_tokens anchor the prefix, so the second fit reuses the measurement for
 * the prefix and only sizes the appended tool-call/tool-result tail.
 *
 * We distinguish "anchor honoured" from "naive estimate" by making the cheap
 * tokenizer wildly under-estimate, then reporting a large prompt_tokens. Only
 * an honoured anchor pushes the second fit over budget and triggers compaction.
 */
import { describe, it, expect, vi } from "vitest";
import { AgentController } from "@/agent/agent-controller";
import type { LLMProvider, StreamDelta } from "@/providers/types";
import type { ToolRegistry } from "@/tools/registry";

/**
 * Queue-driven provider. `chat` returns responses[callIdx], reusing the last
 * response once the queue is exhausted (the summarizer and the second agent
 * iteration may consume calls in either order).
 */
function createQueuedProvider(responses: StreamDelta[][]): {
  provider: LLMProvider;
  chat: ReturnType<typeof vi.fn>;
} {
  let callIdx = 0;
  const chat = vi.fn().mockImplementation(async function* () {
    const deltas = responses[callIdx] || responses[responses.length - 1];
    callIdx++;
    for (const delta of deltas) yield delta;
  });
  const provider = {
    name: "mock",
    config: { provider: "mock", model: "test" },
    chat,
    complete: vi.fn(),
    supportsToolUse: () => true,
    supportsStreaming: () => true,
    // Deliberate under-estimate: the anchor must be used if reported > naive.
    countTokens: () => 10,
    modelInfo: () => ({
      id: "test",
      name: "Test",
      provider: "mock",
      contextWindow: 4000, // budget = 4000 - min(4096, 2000) = 2000
      maxOutputTokens: 1024,
      supportsToolUse: true,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: vi.fn(),
  } as unknown as LLMProvider;
  return { provider, chat };
}

function toolCallTurn(inputTokens: number): StreamDelta[] {
  return [
    { type: "text", text: "reading" },
    {
      type: "tool_call_start",
      toolCall: { id: "c1", name: "read_file", arguments: { path: "x" } },
    },
    { type: "tool_call_end" },
    { type: "done", usage: { inputTokens, outputTokens: 1 } },
  ];
}

const finalTurn: StreamDelta[] = [
  { type: "text", text: "done" },
  { type: "done", usage: { inputTokens: 2, outputTokens: 1 } },
];

function emptyRegistry(): ToolRegistry {
  return {
    getAll: vi.fn().mockReturnValue([]),
    getDefinitions: vi.fn().mockReturnValue([]),
    get: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    execute: vi
      .fn()
      .mockResolvedValue({ success: true, output: "tool result" }),
  } as unknown as ToolRegistry;
}

describe("AgentController — provider-anchored fitting (#137)", () => {
  it("uses the measured prefix on the next iteration and compacts when it overflows", async () => {
    const { provider, chat } = createQueuedProvider([
      toolCallTurn(5000),
      finalTurn,
    ]);
    const controller = new AgentController(provider, emptyRegistry(), "/tmp");

    await controller.processMessage("read x");

    // iter1 agent chat + summarizer chat + iter2 agent chat = 3.
    // The naive estimate (4 msgs x 14 = 56) is far under the 2000 budget, so
    // only an honoured anchor (5000) can force compaction.
    expect(chat.mock.calls.length).toBe(3);
  });

  it("does not compact when the measured prefix fits the budget", async () => {
    const { provider, chat } = createQueuedProvider([
      toolCallTurn(1),
      finalTurn,
    ]);
    const controller = new AgentController(provider, emptyRegistry(), "/tmp");

    await controller.processMessage("read x");

    // iter1 agent chat + iter2 agent chat = 2; no summarizer.
    expect(chat.mock.calls.length).toBe(2);
  });
});
