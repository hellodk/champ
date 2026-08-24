/**
 * TDD: Approval integrity (issue #105).
 *
 * Contracts pinned here:
 * 1. When no requestApproval callback is wired, approval-required tools are
 *    DENIED — never silently auto-approved.
 * 2. An explicitly wired resolver still gates execution.
 * 3. A cancelled turn must NOT flush staged file edits to disk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentController } from "@/agent/agent-controller";
import { ToolRegistry } from "@/tools/registry";
import { StagedEdits } from "@/agent/staged-edits";
import type { LLMProvider, StreamDelta } from "@/providers/types";
import type { Tool, ToolExecutionContext } from "@/tools/types";

function createMockProvider(responses: StreamDelta[][]): LLMProvider {
  let callIdx = 0;
  return {
    name: "mock",
    config: {
      provider: "mock",
      model: "test",
      maxTokens: 1024,
      temperature: 0.7,
    },
    chat: vi.fn().mockImplementation(async function* () {
      const deltas = responses[callIdx] || responses[responses.length - 1];
      callIdx++;
      for (const delta of deltas) {
        yield delta;
      }
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

function makeDestructiveTool(executed: string[]): Tool {
  return {
    name: "wreak_havoc",
    description: "destructive test tool",
    parameters: { type: "object", properties: {}, required: [] },
    requiresApproval: true,
    execute: async () => {
      executed.push("wreak_havoc");
      return { success: true, output: "havoc wreaked" };
    },
  } as unknown as Tool;
}

function makeController(provider: LLMProvider, registry: ToolRegistry) {
  return new AgentController(provider, registry);
}

async function collectStream(p: Promise<unknown>): Promise<string[]> {
  // helper not used; placeholder to keep structure clear
  return [];
}

describe("approval integrity (#105)", () => {
  let executed: string[];

  beforeEach(() => {
    executed = [];
  });

  it("DENIES approval-required tools when no callback is wired", async () => {
    const registry = new ToolRegistry();
    registry.register(makeDestructiveTool(executed));

    const provider = createMockProvider([
      [
        {
          type: "tool_call_start",
          toolCall: { id: "c1", name: "wreak_havoc", arguments: {} },
        },
        { type: "tool_call_end", toolCallId: "c1" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5 } },
      ],
      [
        { type: "text", text: "done" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5 } },
      ],
    ]);

    const controller = makeController(provider, registry);
    await controller.processMessage("do it");

    expect(executed).toEqual([]);
  });

  it("executes when an explicit resolver approves", async () => {
    const registry = new ToolRegistry();
    registry.register(makeDestructiveTool(executed));

    const provider = createMockProvider([
      [
        {
          type: "tool_call_start",
          toolCall: { id: "c1", name: "wreak_havoc", arguments: {} },
        },
        { type: "tool_call_end", toolCallId: "c1" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5 } },
      ],
      [
        { type: "text", text: "done" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5 } },
      ],
    ]);

    const controller = makeController(provider, registry);
    await controller.processMessage("do it", {
      requestApproval: async () => true,
    });

    expect(executed).toEqual(["wreak_havoc"]);
  });

  it("does NOT flush staged edits when the turn was aborted", async () => {
    const flushSpy = vi
      .spyOn(StagedEdits.prototype, "flush")
      .mockResolvedValue([]);

    const registry = new ToolRegistry();
    registry.register(makeDestructiveTool(executed));

    const abort = new AbortController();
    const provider = createMockProvider([
      [
        {
          type: "tool_call_start",
          toolCall: { id: "c1", name: "wreak_havoc", arguments: {} },
        },
        { type: "tool_call_end", toolCallId: "c1" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 5 } },
      ],
    ]);

    const controller = makeController(provider, registry);
    const streamed: string[] = [];
    controller.onStreamDelta((d) => {
      if (d.type === "text" && d.text) {
        streamed.push(d.text);
      }
    });

    // Fill the staged-edit buffer during tool execution, then abort so the
    // loop exits via the cancellation path with pending edits.
    const origExecute = registry.execute.bind(registry);
    vi.spyOn(registry, "execute").mockImplementation(
      async (name: string, args: unknown, ctx: ToolExecutionContext) => {
        const result = await origExecute(name as never, args as never, ctx);
        ctx.stagedEdits.stage(
          "/tmp/some-file.ts",
          "old content",
          "new content",
        );
        abort.abort(); // cancel mid-turn, after the edit was staged
        return result;
      },
    );

    const result = await controller.processMessage("do it", {
      abortSignal: abort.signal,
      requestApproval: async () => true,
    });

    expect(flushSpy).not.toHaveBeenCalled();
    expect(streamed.join("")).toContain("discarded");
    flushSpy.mockRestore();
  });
});
