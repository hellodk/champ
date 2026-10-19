/**
 * TDD (#138 / #114 AC 3): the team tool loop fits its growing history into the
 * provider's context window before every call, shares the anchored accounting
 * from #137, and budgets oversized tool results before they enter history.
 *
 * The loop re-sends its whole local history each iteration up to
 * `MAX_ITERATIONS`. Without fitting, two large tool results overflow a small
 * local model's window; without a result budget, one 100 KB read does it alone.
 */
import { describe, it, expect, vi } from "vitest";
import { ToolCallingLoop } from "@/agent/tool-calling-loop";
import { ToolRegistry } from "@/tools/registry";
import { DEFAULT_TOOL_OUTPUT_BUDGET_CHARS } from "@/agent/tool-output";
import { SUMMARISER_MARKER } from "@/providers/context-summariser";
import type { LLMMessage, LLMProvider, StreamDelta } from "@/providers/types";
import type { Tool, ToolExecutionContext } from "@/tools/types";

/** A body of `size` characters that reveals its own position. */
function bigOutput(size: number): string {
  return Array.from({ length: size }, (_, i) =>
    String.fromCharCode(97 + (i % 26)),
  ).join("");
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
  { type: "done", usage: { inputTokens: 1, outputTokens: 1 } },
];

function makeContext(): ToolExecutionContext {
  return {
    workspaceRoot: "/tmp",
    abortSignal: new AbortController().signal,
    reportProgress: () => {},
    requestApproval: async () => true,
  };
}

function registryReturning(output: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    requiresApproval: false,
    execute: async () => ({ success: true, output }),
  } as unknown as Tool);
  return registry;
}

/**
 * Queue-driven provider. Summariser requests (recognised by their prompt) are
 * answered inline and do not consume the script.
 */
function createLoopProvider(options: {
  contextWindow: number;
  script: StreamDelta[][];
}) {
  let callIdx = 0;
  const countTokens = vi.fn((text: string) => Math.ceil(text.length / 4));
  const chat = vi.fn(async function* (messages: LLMMessage[]) {
    const isSummaryRequest = messages.some(
      (m) =>
        typeof m.content === "string" && m.content.includes(SUMMARISER_MARKER),
    );
    if (isSummaryRequest) {
      yield { type: "text" as const, text: "Earlier the loop read files." };
      yield {
        type: "done" as const,
        usage: { inputTokens: 1, outputTokens: 1 },
      };
      return;
    }
    const deltas =
      options.script[callIdx] ?? options.script[options.script.length - 1];
    callIdx += 1;
    for (const delta of deltas) yield delta;
  });
  const provider = {
    name: "mock",
    config: { provider: "mock", model: "test" },
    chat,
    complete: vi.fn(),
    supportsToolUse: () => true,
    supportsStreaming: () => true,
    countTokens,
    modelInfo: () => ({
      id: "test",
      name: "Test",
      provider: "mock",
      contextWindow: options.contextWindow,
      maxOutputTokens: 1024,
      supportsToolUse: true,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: vi.fn(),
  } as unknown as LLMProvider;
  return { provider, chat, countTokens };
}

function isSummaryCall(call: unknown[]): boolean {
  const messages = (call[0] ?? []) as LLMMessage[];
  return messages.some(
    (m) =>
      typeof m.content === "string" && m.content.includes(SUMMARISER_MARKER),
  );
}

describe("ToolCallingLoop — context fitting (#138)", () => {
  it("compacts an oversized history instead of sending it wholesale (#138 AC 1)", async () => {
    const { provider, chat } = createLoopProvider({
      // budget = 4000 - min(4096, 2000) = 2000 tokens
      contextWindow: 4000,
      script: [toolCallTurn(10), finalTurn],
    });
    const loop = new ToolCallingLoop(
      provider,
      registryReturning(bigOutput(20_000)),
      makeContext(),
    );
    const history: LLMMessage[] = [];
    for (let i = 0; i < 4; i += 1) {
      history.push({
        role: "user",
        content: `question ${i} ${bigOutput(1000)}`,
      });
      history.push({
        role: "assistant",
        content: `answer ${i} ${bigOutput(1000)}`,
      });
    }

    await loop.run([...history, { role: "user", content: "current question" }]);

    // The second request is the one that carries the tool result; by then the
    // oversized prefix has been compacted into a summary instead of being
    // re-sent whole.
    expect(chat.mock.calls.filter(isSummaryCall).length).toBeGreaterThan(0);
    const secondRequest = chat.mock.calls[1][0] as LLMMessage[];
    const text = secondRequest
      .map((m) => (typeof m.content === "string" ? m.content : ""))
      .join("\n");
    expect(text).toContain("[Earlier conversation summary:");
    expect(text).not.toContain(history[0].content as string);
  });

  it("budgets an oversized tool result before it enters history (#114 AC 3)", async () => {
    const output = bigOutput(100_000);
    const { provider, chat } = createLoopProvider({
      contextWindow: 200_000,
      script: [toolCallTurn(50), finalTurn],
    });
    const loop = new ToolCallingLoop(
      provider,
      registryReturning(output),
      makeContext(),
    );

    await loop.run([{ role: "user", content: "read the file" }]);

    // The second request is the one carrying the tool result.
    const request = chat.mock.calls[1][0] as LLMMessage[];
    const blocks = request.flatMap((m) =>
      Array.isArray(m.content) ? m.content : [],
    );
    const result = blocks.find((b) => b.type === "tool_result");
    expect(result).toBeDefined();
    const content = (result as { content: string }).content;

    expect(content.length).toBeLessThanOrEqual(
      DEFAULT_TOOL_OUTPUT_BUDGET_CHARS,
    );
    expect(content).toMatch(/… \[\d+ chars elided\]/);
    expect(content.startsWith(output.slice(0, 100))).toBe(true);
    expect(content.endsWith(output.slice(-100))).toBe(true);
    // Nothing needed compacting: the request still fits.
    expect(chat.mock.calls.filter(isSummaryCall)).toHaveLength(0);
  });

  it("reuses the provider's measured prompt tokens on the next iteration (#138 AC 2)", async () => {
    const first = "first message content ".repeat(10);
    const { provider, chat, countTokens } = createLoopProvider({
      contextWindow: 200_000,
      script: [toolCallTurn(500), finalTurn],
    });
    const loop = new ToolCallingLoop(
      provider,
      registryReturning("ok"),
      makeContext(),
    );

    await loop.run([
      { role: "user", content: first },
      { role: "assistant", content: "ack" },
    ]);

    const tokenized = countTokens.mock.calls.map(([text]) => text as string);
    // First iteration estimates from scratch; the second reuses the measured
    // prefix and only sizes the appended tool-call/tool-result tail.
    expect(tokenized.filter((text) => text === first)).toHaveLength(1);
    expect(chat.mock.calls.filter(isSummaryCall)).toHaveLength(0);
  });

  it("re-measures instead of carrying a measurement from a compacted request (#138 AC 3)", async () => {
    const first = bigOutput(12_000);
    const { provider, chat, countTokens } = createLoopProvider({
      // budget = 4000 - min(4096, 2000) = 2000 tokens
      contextWindow: 4000,
      script: [toolCallTurn(50), finalTurn],
    });
    const loop = new ToolCallingLoop(
      provider,
      registryReturning(bigOutput(20_000)),
      makeContext(),
    );

    await loop.run([
      { role: "user", content: first },
      { role: "assistant", content: "ack" },
      { role: "user", content: "current question" },
    ]);

    // The first fit compacted the oversized history...
    expect(chat.mock.calls.filter(isSummaryCall)).toHaveLength(1);
    // ...so neither it nor the second fit reused a measurement taken from the
    // compacted request: the replaced prefix is measured again.
    const tokenized = countTokens.mock.calls.map(([text]) => text as string);
    expect(tokenized.filter((text) => text === first).length).toBeGreaterThan(
      1,
    );
  });
});
