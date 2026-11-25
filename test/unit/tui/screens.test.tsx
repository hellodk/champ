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
      sessionId: "sess_1",
    },
    initialEndpoints: [],
    initialScreen: "chat",
    submit: vi.fn(async () => ({ text: "", aborted: false })),
    abort: vi.fn(),
    refreshEndpoints: vi.fn(async () => []),
    addEndpoint: vi.fn(async () => "ok"),
    updateEndpoint: vi.fn(async () => "updated"),
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

async function tabTo(view: ReturnType<typeof render>, count: number) {
  for (let i = 0; i < count; i += 1) {
    view.stdin.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("TUI session and review screens (#148)", () => {
  it("renders Sessions and Review tabs", async () => {
    const view = render(<App runtime={runtime()} />);
    await ready(view);
    await tabTo(view, 4);
    expect(view.lastFrame()).toContain("Sessions");
    await tabTo(view, 1);
    expect(view.lastFrame()).toContain("Review");
    view.unmount();
  });

  it("lists sessions and resumes the selected one", async () => {
    const rt = runtime({
      listSessions: vi.fn(async () => [
        {
          id: "sess_2",
          label: "fix parser",
          updatedAt: "2026-11-24T10:00:00Z",
        },
      ]),
      resumeSession: vi.fn(async () => "resumed sess_2"),
    });
    const view = render(<App runtime={rt} />);
    await ready(view);
    await tabTo(view, 4);
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("fix parser");
    });
    view.stdin.write("\r");
    await vi.waitFor(() => {
      expect(rt.resumeSession).toHaveBeenCalledWith("sess_2");
    });
    view.unmount();
  });

  it("accepts and rejects recorded diffs from the Review screen", async () => {
    const rt = runtime({
      listReviews: vi.fn(async () => [
        {
          id: "rev_1",
          status: "pending",
          files: 1,
          summary: "a.txt",
        },
      ]),
      acceptReview: vi.fn(async () => "accepted"),
      rejectReview: vi.fn(async () => "rejected"),
    });
    const view = render(<App runtime={rt} />);
    await ready(view);
    await tabTo(view, 5);
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("rev_1");
    });
    view.stdin.write("a");
    await vi.waitFor(() => {
      expect(rt.acceptReview).toHaveBeenCalledWith("rev_1");
    });
    view.stdin.write("r");
    await vi.waitFor(() => {
      expect(rt.rejectReview).toHaveBeenCalledWith("rev_1");
    });
    view.unmount();
  });

  it("documents the new controls in the help screen", async () => {
    const view = render(<App runtime={runtime()} />);
    await ready(view);
    await tabTo(view, 5);
    await tabTo(view, 1);
    expect(view.lastFrame()).toContain("Sessions");
    expect(view.lastFrame()).toContain("Review");
    view.unmount();
  });
});
