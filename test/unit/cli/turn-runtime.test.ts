import { describe, expect, it, vi } from "vitest";
import type { StreamDelta, TokenUsage } from "@/providers/types";
import {
  abortActiveTurn,
  activeAbortSignal,
  executeTurn,
  turnStatus,
} from "@/cli/turn-runtime";

function fakeController(
  seenSignal: { signal?: AbortSignal },
  deltas: StreamDelta[],
) {
  let emit: ((delta: StreamDelta) => void) | undefined;
  return {
    onStreamDelta(listener: (delta: StreamDelta) => void) {
      emit = listener;
      return () => {
        emit = undefined;
      };
    },
    async processMessage(_text: string, opts: { abortSignal?: AbortSignal }) {
      seenSignal!.signal = opts.abortSignal;
      for (const delta of deltas) emit?.(delta);
      return { text: "final reply", toolCalls: [], aborted: false };
    },
  };
}

describe("executeTurn", () => {
  it("streams text, tools and usage through transport-agnostic events", async () => {
    const controller = fakeController({}, [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
      {
        type: "tool_call_start",
        toolCall: { id: "1", name: "read_file", arguments: { path: "x" } },
      },
      {
        type: "tool_call_end",
        toolCallId: "1",
        toolName: "read_file",
        toolResult: "contents",
        toolSuccess: true,
      },
      { type: "done", usage: { inputTokens: 12, outputTokens: 5 } },
    ]);
    const text: string[] = [];
    const tools: string[] = [];
    const toolResults: unknown[] = [];
    let usage: TokenUsage | undefined;
    const onDone = vi.fn();

    const outcome = await executeTurn({
      controller,
      text: "hi",
      events: {
        onText: (chunk) => text.push(chunk),
        onTool: (call) => tools.push(call.name),
        onToolResult: (result) => toolResults.push(result),
        onUsage: (value) => {
          usage = value;
        },
        onDone,
      },
    });

    expect(outcome.text).toBe("final reply");
    expect(text.join("")).toBe("Hello world");
    expect(tools).toEqual(["read_file"]);
    expect(toolResults).toEqual([
      {
        id: "1",
        name: "read_file",
        output: "contents",
        success: true,
      },
    ]);
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({ tools: 1, usage }),
    );
  });

  it("reports rich telemetry including latency, TTFT, tool duration, model, cost and context", async () => {
    const base = fakeController({}, [
      { type: "text", text: "Hello " },
      {
        type: "tool_call_start",
        toolCall: { id: "1", name: "read_file", arguments: { path: "x" } },
      },
      {
        type: "tool_call_end",
        toolCallId: "1",
        toolName: "read_file",
        toolResult: "contents",
        toolSuccess: true,
      },
      {
        type: "done",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 20,
        },
      },
    ]);

    const controller = {
      ...base,
      getProvider: () => ({
        name: "anthropic",
        modelInfo: () => ({
          id: "claude-3-5-sonnet-20241022",
          name: "Claude 3.5 Sonnet",
          contextWindow: 200000,
        }),
      }),
    };

    const onDone = vi.fn();
    await executeTurn({
      controller,
      text: "hi",
      events: { onDone },
    });

    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: 1,
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 20,
        },
        durationMs: expect.any(Number),
        toolDurationMs: expect.any(Number),
        firstTokenMs: expect.any(Number),
        model: "claude-3-5-sonnet-20241022",
        provider: "anthropic",
        cost: expect.objectContaining({
          usd: expect.any(Number),
          known: true,
          pricingVersion: "2026-11-01",
          source: "table",
        }),
        context: expect.objectContaining({
          used: 150,
          window: 200000,
          remaining: 199850,
          percentUsed: 0,
        }),
      }),
    );
  });

  it("writes a final reply once when no text delta was streamed", async () => {
    const controller = fakeController({}, []);
    const text: string[] = [];

    await executeTurn({
      controller,
      text: "hi",
      events: { onText: (chunk) => text.push(chunk) },
    });

    expect(text).toEqual(["final reply"]);
  });

  it("returns the error delta as TurnOutcome.error so callers can fail the turn", async () => {
    const controller = fakeController({}, [
      { type: "text", text: "partial" },
      { type: "error", error: "Request failed: 404 Not Found" },
    ]);
    const onError = vi.fn();

    const outcome = await executeTurn({
      controller,
      text: "hi",
      events: { onError },
    });

    expect(onError).toHaveBeenCalledWith("Request failed: 404 Not Found");
    expect(outcome.error).toBe("Request failed: 404 Not Found");
    expect(outcome.aborted).toBe(false);
    expect(outcome.status).toBe("partial");
  });

  it("classifies failed, cancelled and successful outcomes", () => {
    expect(turnStatus({ text: "ok", aborted: false })).toBe("success");
    expect(turnStatus({ text: "", error: "boom", aborted: false })).toBe(
      "failed",
    );
    expect(turnStatus({ text: "some", error: "boom", aborted: false })).toBe(
      "partial",
    );
    expect(turnStatus({ text: "", error: "boom", aborted: true })).toBe(
      "cancelled",
    );
  });

  it("exposes and aborts the active turn signal", async () => {
    const seen: { signal?: AbortSignal } = {};
    const controller = fakeController([], seen);
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    const original = controller.processMessage;
    controller.processMessage = async (text, opts) => {
      seen.signal = opts.abortSignal;
      await gate;
      return original(text, opts);
    };

    const run = executeTurn({ controller, text: "hi" });
    await vi.waitFor(() => expect(activeAbortSignal()).toBeDefined());
    expect(abortActiveTurn()).toBe(true);
    expect(seen.signal?.aborted).toBe(true);
    resolve();
    await run;
    expect(activeAbortSignal()).toBeNull();
  });

  it("accumulates turn tokens across multiple iterations while computing context from the final request", async () => {
    const base = fakeController({}, [
      {
        type: "tool_call_start",
        toolCall: { id: "t1", name: "read_file", arguments: { path: "a.ts" } },
      },
      // Provider argument-stream end (no toolResult/toolSuccess) must not trigger false failure
      { type: "tool_call_end", toolCallId: "t1" },
      {
        type: "done",
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          cachedInputTokens: 200,
          reasoningTokens: 40,
        },
      },
      {
        type: "tool_call_end",
        toolCallId: "t1",
        toolName: "read_file",
        toolResult: "file body",
        toolSuccess: true,
        toolDurationMs: 25,
      },
      { type: "reasoning", text: "checking edge case" },
      { type: "text", text: "All fixed." },
      {
        type: "done",
        usage: {
          inputTokens: 1500,
          outputTokens: 200,
          cachedInputTokens: 500,
          reasoningTokens: 60,
        },
      },
    ]);

    const controller = {
      ...base,
      getProvider: () => ({
        name: "anthropic",
        modelInfo: () => ({
          id: "claude-3-5-sonnet-20241022",
          name: "Claude 3.5 Sonnet",
          contextWindow: 10000,
        }),
      }),
    };

    const toolResults: unknown[] = [];
    const reasoning: string[] = [];
    const onDone = vi.fn();

    await executeTurn({
      controller,
      text: "fix bug",
      events: {
        onToolResult: (res) => toolResults.push(res),
        onReasoning: (chunk) => reasoning.push(chunk),
        onDone,
      },
    });

    // Argument-end delta was ignored; only real execution completion fired
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      id: "t1",
      name: "read_file",
      success: true,
      durationMs: 25,
    });
    expect(reasoning).toEqual(["checking edge case"]);
    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: 1,
        toolDurationMs: 25,
        usage: expect.objectContaining({
          inputTokens: 2500,
          outputTokens: 300,
          cachedInputTokens: 700,
          reasoningTokens: 100,
        }),
        // Final request had 1500 + 200 = 1700 tokens (17% of 10000), NOT 2800 (28%)
        context: expect.objectContaining({
          used: 1700,
          window: 10000,
          remaining: 8300,
          percentUsed: 17,
        }),
      }),
    );
  });

  it("attributes model, provider, contextWindow and cost to the actual routed provider", async () => {
    let emit: ((delta: StreamDelta) => void) | undefined;
    const controller = {
      onStreamDelta(listener: (delta: StreamDelta) => void) {
        emit = listener;
        return () => {
          emit = undefined;
        };
      },
      getProvider: () => ({
        name: "ollama",
        modelInfo: () => ({
          id: "default-local-model",
          name: "default-local-model",
          contextWindow: 8192,
        }),
      }),
      async processMessage() {
        emit?.({ type: "text", text: "routed reply" });
        emit?.({
          type: "done",
          usage: { inputTokens: 1000, outputTokens: 500 },
        });
        return {
          text: "routed reply",
          toolCalls: [],
          actualModel: "claude-3-5-haiku-20241022",
          actualProvider: "claude",
          contextWindow: 200000,
          fallbacks: 1,
          compactions: 0,
        };
      },
    };

    const onDone = vi.fn();
    await executeTurn({ controller, text: "hello", events: { onDone } });

    expect(onDone).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "claude-3-5-haiku-20241022",
        provider: "claude",
        fallbacks: 1,
        context: expect.objectContaining({
          used: 1500,
          window: 200000,
        }),
        cost: expect.objectContaining({
          known: true,
          source: "table",
        }),
      }),
    );
  });
});
