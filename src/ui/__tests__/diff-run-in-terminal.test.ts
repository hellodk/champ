// src/ui/__tests__/diff-run-in-terminal.test.ts
import { describe, it, expect } from "vitest";
import {
  createTerminalOutputChunk,
  isRunInTerminalRequest,
  isTerminalOutputChunkMessage,
  type TerminalOutputChunkMessage,
  type RunInTerminalRequest,
} from "../messages";

describe("TerminalOutputChunkMessage", () => {
  it("createTerminalOutputChunk produces a correctly shaped message", () => {
    const msg = createTerminalOutputChunk("exec-1", "hello\n", false);
    expect(msg).toEqual({
      type: "terminalOutputChunk",
      executionId: "exec-1",
      chunk: "hello\n",
      done: false,
    });
  });

  it("createTerminalOutputChunk with done=true sets done flag", () => {
    const msg = createTerminalOutputChunk("exec-2", "", true);
    expect(msg.done).toBe(true);
  });

  it("isTerminalOutputChunkMessage returns true for correct type", () => {
    const msg: TerminalOutputChunkMessage = {
      type: "terminalOutputChunk",
      executionId: "x",
      chunk: "data",
      done: false,
    };
    expect(isTerminalOutputChunkMessage(msg as never)).toBe(true);
  });

  it("isTerminalOutputChunkMessage returns false for other types", () => {
    expect(
      isTerminalOutputChunkMessage({ type: "streamDelta", text: "a" } as never),
    ).toBe(false);
  });
});

describe("RunInTerminalRequest", () => {
  it("isRunInTerminalRequest returns true for correct type", () => {
    const req: RunInTerminalRequest = {
      type: "runInTerminal",
      command: "ls -la",
      executionId: "exec-42",
    };
    expect(isRunInTerminalRequest(req as never)).toBe(true);
  });

  it("isRunInTerminalRequest returns false for other types", () => {
    expect(
      isRunInTerminalRequest({ type: "userMessage", text: "hi" } as never),
    ).toBe(false);
  });
});
