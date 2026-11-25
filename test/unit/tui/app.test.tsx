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

/** Wait until Ink has mounted and subscribed to stdin before sending keys. */
async function waitReady(view: ReturnType<typeof render>): Promise<void> {
  await vi.waitFor(() => {
    expect(view.lastFrame()).toContain("type a message");
  });
  // Ink attaches the stdin listener in an effect that runs after the first
  // frame is painted; let it settle so the first keystroke is not dropped.
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("Ink TUI", () => {
  it("moves back through transcript lines with PageUp and returns on End", async () => {
    const adapter = runtime({
      submit: vi.fn(async (_text, hooks) => {
        hooks.onText(
          Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n"),
        );
        return { text: "", aborted: false };
      }),
    });
    const view = render(<App runtime={adapter} />);
    await waitReady(view);
    for (const char of "hello") {
      view.stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("line 59");
    });

    view.stdin.write("\x1b[5~"); // PageUp
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("(scrolled)");
    });
    view.stdin.write("\x1b[F"); // End
    await vi.waitFor(() => {
      expect(view.lastFrame()).not.toContain("(scrolled)");
    });
  });

  it("renders markdown headings, lists and highlighted code in the transcript (#193)", async () => {
    const adapter = runtime({
      submit: vi.fn(async (_text, hooks) => {
        hooks.onText(
          "# Result\n\n- first\n- second\n\n```ts\nconst value = 1;\n```",
        );
        return { text: "", aborted: false };
      }),
    });
    const view = render(<App runtime={adapter} />);
    await waitReady(view);
    for (const char of "run") {
      view.stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    view.stdin.write("\r");
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("Result");
      expect(frame).toContain("• first");
      expect(frame).toContain("const");
      expect(frame).toContain("qwen3.5-4b");
      expect(frame).toContain("sess_1");
    });
  });

  it("collapses tool output and expands it with Ctrl-E (#193)", async () => {
    const adapter = runtime({
      submit: vi.fn(async (_text, hooks) => {
        hooks.onTool("read_file", '{"path":"a.txt"}');
        return { text: "", aborted: false };
      }),
    });
    const view = render(<App runtime={adapter} />);
    await waitReady(view);
    for (const char of "run") {
      view.stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("Ctrl-E to expand");
    });
    view.stdin.write("\u0005"); // Ctrl-E
    await vi.waitFor(() => {
      expect(view.lastFrame()).not.toContain("Ctrl-E to expand");
    });
  });

  it("renders the full-screen shell with header, tabs and prompt", () => {
    const view = render(<App runtime={runtime()} />);
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("CHAMP");
    expect(frame).toContain("Chat");
    expect(frame).toContain("Providers");
    expect(frame).toContain("Config");
    expect(frame).toContain("qwen3.5-4b");
    expect(frame).toContain("›");
  });

  it("switches screens with the tab key", async () => {
    const view = render(<App runtime={runtime()} />);
    await waitReady(view);
    view.stdin.write("\t");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("Endpoints");
    });
  });

  it("submits typed chat input through the shared runtime adapter", async () => {
    const adapter = runtime();
    const view = render(<App runtime={adapter} />);
    await waitReady(view);
    for (const char of "hello model") {
      view.stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(adapter.submit).toHaveBeenCalledWith(
        "hello model",
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  it("accepts pasted multi-character input in chat", async () => {
    const adapter = runtime();
    const view = render(<App runtime={adapter} />);
    await waitReady(view);
    // Paste multi-character string in a single write call
    view.stdin.write("create a python file to print hello world");
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(adapter.submit).toHaveBeenCalledWith(
        "create a python file to print hello world",
        expect.any(Object),
        expect.any(Function),
      );
    });
  });

  it("allows typing question marks in chat prompts without jumping to help screen", async () => {
    const adapter = runtime();
    const view = render(<App runtime={adapter} />);
    await waitReady(view);
    for (const char of "where is Tawang?") {
      view.stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(adapter.submit).toHaveBeenCalledWith(
        "where is Tawang?",
        expect.any(Object),
        expect.any(Function),
      );
    });
    // Should still be on the chat screen, not help screen
    expect(view.lastFrame()).toContain("Session");
  });

  it("renders tool execution and tool result in chat transcript", async () => {
    const adapter = runtime({
      submit: vi.fn(async (_text, events) => {
        events.onTool?.(
          "run_terminal",
          JSON.stringify({ command: "hostname" }),
        );
        events.onToolResult?.("run_terminal", "my-host.local\n", true);
        return { text: "Done", aborted: false };
      }),
    });
    const view = render(<App runtime={adapter} />);
    await waitReady(view);
    view.stdin.write("hostname");
    view.stdin.write("\r");
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("run_terminal");
      expect(frame).toContain("✓ run_terminal → my-host.local");
    });
  });

  it("displays clear approval prompt when approval is requested", async () => {
    let resolveApproval: (approved: boolean) => void = () => {};
    const adapter = runtime({
      submit: vi.fn(async (_text, _events, requestApproval) => {
        const approved = await requestApproval(
          "Run command: rm -rf /tmp/cache",
        );
        return { text: approved ? "Deleted" : "Denied", aborted: false };
      }),
    });
    const view = render(<App runtime={adapter} />);
    await waitReady(view);
    view.stdin.write("delete cache");
    view.stdin.write("\r");
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("Approval Required");
      expect(frame).toContain("Run command: rm -rf /tmp/cache");
      expect(frame).toContain("Press [y] Approve · [n/Esc] Deny");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Approve with 'y'
    view.stdin.write("y");
    await vi.waitFor(() => {
      const frame = view.lastFrame() ?? "";
      expect(frame).not.toContain("Approval Required");
    });
  });
});
