import { describe, expect, it, vi } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { App } from "@/tui/app";
import { CHAT_COMMANDS, CHAT_COMMAND_HELP } from "@/cli/commands";
import type { TuiRuntime } from "@/tui/runtime";

function runtime(overrides: Partial<TuiRuntime> = {}): TuiRuntime {
  return {
    header: {
      version: "test",
      model: "test-model",
      workspace: "/tmp/ws",
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
    command: vi.fn(async (text: string) =>
      text === "/status" ? "mode=agent model=test-model" : null,
    ),
    exit: vi.fn(),
    ...overrides,
  };
}

describe("TUI slash commands", () => {
  it("advertises exactly the defined chat commands", () => {
    expect(CHAT_COMMANDS).toEqual([
      "/model",
      "/mode",
      "/status",
      "/index",
      "/export",
      "/clear",
      "/sessions",
      "/history",
      "/session",
      "/tui",
      "/checkpoint",
      "/compact",
      "/help",
      "/exit",
      "/cost",
      "/usage",
      "/context",
      "/route",
      "/tasks",
      "/tools",
      "/mcp",
      "/doctor",
      "/verbosity",
    ]);
    for (const command of CHAT_COMMANDS) {
      expect(CHAT_COMMAND_HELP[command]).toBeTruthy();
    }
  });

  it("routes a defined slash command through runtime.command", async () => {
    const rt = runtime();
    const app = render(<App runtime={rt} />);
    await vi.waitFor(() => {
      expect(app.lastFrame()).toContain("Ask anything");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const char of "/status") {
      app.stdin.write(char);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    app.stdin.write("\r");
    await vi.waitFor(() => {
      expect(rt.command).toHaveBeenCalledWith("/status");
    });
    expect(rt.command).toHaveBeenCalledWith("/status");
    expect(app.lastFrame()).toContain("mode=agent model=test-model");
    expect(rt.submit).not.toHaveBeenCalled();
    app.unmount();
  });
});
