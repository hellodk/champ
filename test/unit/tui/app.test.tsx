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
});
