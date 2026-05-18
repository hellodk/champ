// src/ui/__tests__/diff-run-in-terminal.test.ts
import { describe, it, expect } from "vitest";
import {
  createTerminalOutputChunk,
  isRunInTerminalRequest,
  isTerminalOutputChunkMessage,
  type TerminalOutputChunkMessage,
  type RunInTerminalRequest,
} from "../messages";
import { computeHunks } from "../diff-overlay-controller";

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

describe("DiffOverlayController — openDiffEditor CodeLens presence", () => {
  it("computeHunks returns at least one hunk for differing content (precondition for CodeLens)", () => {
    const old = "const x = 1;\nconst y = 2;";
    const neu = "const x = 99;\nconst y = 2;";
    const hunks = computeHunks(old, neu);
    expect(hunks.length).toBeGreaterThan(0);
    expect(hunks[0].newDocStartLine).toBe(0);
  });

  it("computeHunks returns empty for identical content (no CodeLens shown)", () => {
    const content = "line1\nline2";
    expect(computeHunks(content, content)).toHaveLength(0);
  });
});
