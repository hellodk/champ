import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "@/tui/app";
import { resolveRuntimeTheme } from "@/tui/theme";
import type { TuiRuntime } from "@/tui/runtime";

function endpoint(
  overrides: Partial<TuiRuntime["initialEndpoints"][number]> = {},
) {
  return {
    id: "ep_a",
    name: "Local",
    provider: "ollama",
    baseUrl: "http://localhost:11434",
    hasCredential: false,
    models: ["qwen3:8b", "llama3:8b"],
    ...overrides,
  };
}

function runtime(overrides: Partial<TuiRuntime> = {}): TuiRuntime {
  const initialEndpoints = overrides.initialEndpoints ?? [endpoint()];
  return {
    header: {
      version: "test",
      model: "configured-model",
      workspace: "/repo",
    },
    initialEndpoints,
    initialScreen: "chat",
    submit: vi.fn(async () => ({ text: "", aborted: false })),
    abort: vi.fn(),
    refreshEndpoints: vi.fn(async () => initialEndpoints),
    addEndpoint: vi.fn(async () => "Added"),
    updateEndpoint: vi.fn(async () => "Updated"),
    selectModel: vi.fn(async () => "selected"),
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
    expect(view.lastFrame()).toContain("CHAMP");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function type(
  view: ReturnType<typeof render>,
  text: string,
): Promise<void> {
  for (const char of text) {
    view.stdin.write(char);
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
}

describe("TUI fixes for #164", () => {
  it("keeps the configured model visible when discovery does not list it", async () => {
    const view = render(<App runtime={runtime()} />);
    await ready(view);
    expect(view.lastFrame()).toContain("configured-model");
    expect(view.lastFrame()).toContain("⚠");
    view.unmount();
  });

  it("lets --theme override environment theme detection", () => {
    expect(
      resolveRuntimeTheme({ theme: "light" }, { CHAMP_THEME: "dark" }),
    ).toBe("light");
    expect(resolveRuntimeTheme({}, { CHAMP_THEME: "dark" })).toBe("dark");
  });

  it("auto-opens the model picker after adding an endpoint", async () => {
    const rt = runtime({
      initialEndpoints: [],
      initialScreen: "providers",
      refreshEndpoints: vi.fn(async () => [endpoint()]),
    });
    const view = render(<App runtime={rt} />);
    await ready(view);
    view.stdin.write("a");
    await type(view, "local");
    await type(view, "\r"); // provider
    await type(view, "\r"); // baseUrl
    await type(view, "http://localhost:11434");
    await type(view, "\r"); // credentialId
    await type(view, "\r"); // apiKey
    await type(view, "\r"); // model
    await type(view, "\r"); // save
    await vi.waitFor(() => {
      expect(rt.addEndpoint).toHaveBeenCalled();
      expect(view.lastFrame()).toContain("Select model");
    });
    view.unmount();
  });

  it("prefills the add/edit form when editing the selected endpoint", async () => {
    const rt = runtime({ initialScreen: "providers" });
    const view = render(<App runtime={rt} />);
    await ready(view);
    view.stdin.write("e");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("name: Local");
    });
    view.unmount();
  });

  it("uses progressive disclosure for help and a contextual footer", async () => {
    const view = render(<App runtime={runtime()} />);
    await ready(view);
    expect(view.lastFrame()).toContain("? help");
    expect(view.lastFrame()).not.toContain("PgUp/PgDn");
    view.stdin.write("?");
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain("PgUp/PgDn");
    });
    view.unmount();
  });
});
