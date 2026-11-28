import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "@/tui/app";
import type { TuiRuntime } from "@/tui/runtime";

function runtime(overrides: Partial<TuiRuntime> = {}): TuiRuntime {
  return {
    header: {
      version: "2.0.2",
      model: "qwen3.5-4b",
      workspace: "/repo",
      sessionId: "sess_1",
      routingMode: "auto",
    },
    initialEndpoints: [
      {
        id: "ep_a",
        name: "Local",
        provider: "ollama",
        baseUrl: "http://localhost:11434",
        hasCredential: false,
        models: ["qwen3:8b"],
      },
    ],
    submit: vi.fn(async () => ({ text: "", aborted: false })),
    abort: vi.fn(),
    refreshEndpoints: vi.fn(async () => []),
    addEndpoint: vi.fn(async () => "ep_b"),
    updateEndpoint: vi.fn(async () => "updated"),
    selectModel: vi.fn(async () => "ok"),
    testEndpoint: vi.fn(async () => "ok"),
    validate: vi.fn(async () => []),
    doctor: vi.fn(async () => ({ healthy: true, lines: ["ok"] })),
    exportRedacted: vi.fn(async () => "{}"),
    exit: vi.fn(),
    ...overrides,
  };
}

async function ready(view: ReturnType<typeof render>): Promise<void> {
  await vi.waitFor(() => {
    expect(view.lastFrame()).toContain("type a message");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function paletteTo(view: ReturnType<typeof render>, query: string) {
  view.stdin.write("\x10"); // Ctrl-P
  await vi.waitFor(() => {
    expect(view.lastFrame()).toContain("Command palette");
  });
  // Ink re-registers its input handler after the commit that opened the
  // overlay; let that effect flush before typing.
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (const char of query) {
    view.stdin.write(char);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  view.stdin.write("\r");
}

describe("competitive gap surfaces", () => {
  it("opens the command palette and jumps to a discovered screen", async () => {
    const adapter = runtime({
      listMcpServers: vi.fn(async () => [
        {
          name: "filesystem",
          transport: "stdio",
          status: "running",
          health: "healthy",
          tools: 3,
        },
      ]),
    });
    const view = render(<App runtime={adapter} />);
    await ready(view);
    await paletteTo(view, "mcp");
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("filesystem");
      expect(frame).toContain("3 tool(s)");
    });
  });

  it("shows the full structured tool detail with Ctrl-E", async () => {
    const adapter = runtime({
      submit: vi.fn(async (_text, events) => {
        events.onToolEvent?.({
          id: "t1",
          name: "run_terminal",
          args: JSON.stringify({ token: "sk-abcdefgh1234" }),
          startedAt: "2026-01-01T00:00:00.000Z",
        });
        events.onToolResultEvent?.({
          id: "t1",
          name: "run_terminal",
          output: "x".repeat(400),
          success: false,
          stderr: "boom",
          exitCode: 2,
          durationMs: 12,
          approval: "approved",
          error: "command failed",
        });
        return { text: "", aborted: false };
      }),
    });
    const view = render(<App runtime={adapter} />);
    await ready(view);
    view.stdin.write("run");
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("Ctrl-E to expand");
    });
    view.stdin.write("\u0005");
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("Tool detail");
      expect(frame).toContain("stderr");
      expect(frame).toContain("boom");
      expect(frame).toContain("exit code");
      expect(frame).toContain("12ms");
      expect(frame).toContain("approved");
      expect(frame).toContain("command failed");
      expect(frame).toContain("[redacted]");
    });
  });

  it("keeps pasted newlines and loads an externally edited prompt", async () => {
    const adapter = runtime({
      openExternalEditor: vi.fn(async () => "edited\nsecond line"),
    });
    const view = render(<App runtime={adapter} />);
    await ready(view);
    view.stdin.write("one\ntwo");
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("one");
      expect(frame).toContain("two▌");
    });
    view.stdin.write("\x0f"); // Ctrl-O
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("edited");
      expect(frame).toContain("second line▌");
    });
  });

  it("queues a second prompt while a turn is running", async () => {
    let release = () => {};
    const first = new Promise<{ text: string; aborted: boolean }>((resolve) => {
      release = () => resolve({ text: "", aborted: false });
    });
    const submit = vi
      .fn()
      .mockImplementationOnce(async () => first)
      .mockResolvedValue({ text: "", aborted: false });
    const adapter = runtime({ submit });
    const view = render(<App runtime={adapter} />);
    await ready(view);
    view.stdin.write("first");
    view.stdin.write("\r");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    view.stdin.write("second");
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("Queued 1 task(s)");
    });
    release();
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit.mock.calls[1][0]).toBe("second");
  });

  it("renames a selected session from the Sessions screen", async () => {
    const renameSession = vi.fn(async () => "renamed");
    const adapter = runtime({
      listSessions: vi.fn(async () => [
        { id: "sess_1", label: "Old label", updatedAt: "2026-01-01" },
      ]),
      renameSession,
    });
    const view = render(<App runtime={adapter} />);
    await ready(view);
    await paletteTo(view, "sessions");
    await vi.waitFor(() => expect(view.lastFrame()).toContain("Old label"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.stdin.write("N");
    await vi.waitFor(() =>
      expect(view.lastFrame()).toContain("Rename session"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.stdin.write("Renamed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(renameSession).toHaveBeenCalledWith("sess_1", "Old labelRenamed");
    });
  });

  it("renders context, usage and recovery data", async () => {
    const adapter = runtime({
      getContext: vi.fn(async () => ({
        usedTokens: 6000,
        limit: 10000,
        model: "m",
        messages: 12,
        compactions: [
          {
            at: "2026-01-01T00:00:00.000Z",
            label: "checkpoint 1",
            elided: 8,
          },
        ],
      })),
      listCheckpoints: vi.fn(async () => [
        {
          id: "cp-1",
          label: "checkpoint 1",
          at: "2026-01-01T00:00:00.000Z",
          checkpointId: "cp-1",
        },
      ]),
      listUsage: vi.fn(async () => [
        {
          at: "2026-01-01T00:00:00.000Z",
          model: "m",
          provider: "ollama",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
          cacheWriteTokens: 5,
          costUsd: 0.0012,
          latencyMs: 430,
        },
      ]),
    });
    const view = render(<App runtime={adapter} />);
    await ready(view);
    await paletteTo(view, "context");
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("6000/10000");
      expect(frame).toContain("checkpoint 1");
    });
    await paletteTo(view, "usage");
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("$0.0012");
      expect(frame).toContain("m/ollama");
    });
  });
});
