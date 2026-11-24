import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "@/tui/app";
import type { TuiRuntime } from "@/tui/runtime";

function runtime(overrides: Partial<TuiRuntime> = {}): TuiRuntime {
  return {
    header: {
      version: "test",
      model: "test-model",
      workspace: "/repo",
    },
    initialEndpoints: [],
    initialScreen: "chat",
    submit: vi.fn(async () => ({ text: "", aborted: false })),
    abort: vi.fn(),
    refreshEndpoints: vi.fn(async () => []),
    addEndpoint: vi.fn(async () => "ok"),
    selectModel: vi.fn(async () => "ok"),
    testEndpoint: vi.fn(async () => "ok"),
    validate: vi.fn(async () => []),
    doctor: vi.fn(async () => ({ healthy: true, lines: [] })),
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

async function type(view: ReturnType<typeof render>, text: string) {
  for (const char of text) {
    view.stdin.write(char);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe("TUI autocomplete and aliases (#151)", () => {
  it("shows a filtered command popup and accepts with Tab", async () => {
    const view = render(<App runtime={runtime()} />);
    await ready(view);
    await type(view, "/mod");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("/model");
    });
    view.stdin.write("\t");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("/model ");
    });
    view.unmount();
  });

  it("does not send the popup when Escape dismisses it", async () => {
    const rt = runtime();
    const view = render(<App runtime={rt} />);
    await ready(view);
    await type(view, "/stat");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("/status");
    });
    view.stdin.write("\u001b");
    view.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rt.submit).not.toHaveBeenCalled();
    view.unmount();
  });

  it("treats /models as an alias for /model", async () => {
    const rt = runtime();
    const view = render(<App runtime={rt} />);
    await ready(view);
    await type(view, "/models");
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("Endpoints");
    });
    expect(rt.submit).not.toHaveBeenCalled();
    view.unmount();
  });
});

describe("TUI scrollback and history (#150)", () => {
  it("shows a scroll indicator and scrolls without changing messages", async () => {
    const view = render(<App runtime={runtime()} />);
    await ready(view);
    await view.stdin.write("\u001b[5~");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(view.lastFrame()).toContain("line 0 of 0");
    view.unmount();
  });

  it("recalls previous prompts with Up when input is not empty", async () => {
    const rt = runtime();
    const view = render(<App runtime={rt} />);
    await ready(view);
    await type(view, "first prompt");
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(rt.submit).toHaveBeenCalledWith(
        "first prompt",
        expect.any(Object),
        expect.any(Function),
      );
    });
    await type(view, "draft");
    view.stdin.write("\u001b[A");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("› first prompt");
    });
    view.unmount();
  });
});
