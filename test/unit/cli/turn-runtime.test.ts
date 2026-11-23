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
      { type: "done", usage: { inputTokens: 12, outputTokens: 5 } },
    ]);
    const text: string[] = [];
    const tools: string[] = [];
    let usage: TokenUsage | undefined;
    const onDone = vi.fn();

    const outcome = await executeTurn({
      controller,
      text: "hi",
      events: {
        onText: (chunk) => text.push(chunk),
        onTool: (call) => tools.push(call.name),
        onUsage: (value) => {
          usage = value;
        },
        onDone,
      },
    });

    expect(outcome.text).toBe("final reply");
    expect(text.join("")).toBe("Hello world");
    expect(tools).toEqual(["read_file"]);
    expect(usage).toEqual({ inputTokens: 12, outputTokens: 5 });
    expect(onDone).toHaveBeenCalledWith({ tools: 1, usage });
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
});
