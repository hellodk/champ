/**
 * E2E for #164: the full Ink TUI must render semantic role colours that adapt
 * to the active palette. FORCE_COLOR makes Ink emit the ANSI sequences so the
 * raw frames can be asserted, and symbols keep meaning available without colour.
 */
// Set before importing Ink/App so chalk captures FORCE_COLOR at module load.
// Level 3 forces truecolor, so hex role colours are emitted even on basic
// terminals in CI (level 1 would downgrade them to 16-colour ANSI codes).
process.env.FORCE_COLOR = "3";
delete process.env.NO_COLOR;

const React = (await import("react")).default;
const { render } = await import("ink-testing-library");
const { App } = await import("@/tui/app");
const { PALETTES } = await import("@/tui/theme");
import { describe, expect, it, vi } from "vitest";
import type { TuiRuntime } from "@/tui/runtime";

function runtime(theme: "dark" | "light", stale = false): TuiRuntime {
  return {
    header: { version: "test", model: "active-model", workspace: "/repo" },
    initialEndpoints: [
      {
        id: "ep_a",
        name: "Local",
        provider: "ollama",
        baseUrl: "http://localhost:11434",
        hasCredential: false,
        models: ["active-model"],
      },
    ],
    initialSelection: stale
      ? { endpointId: "ep_a", model: "missing-model" }
      : undefined,
    initialScreen: "chat",
    theme,
    submit: vi.fn(async () => ({ text: "", aborted: false })),
    abort: vi.fn(),
    refreshEndpoints: vi.fn(async () => []),
    addEndpoint: vi.fn(async () => "ok"),
    updateEndpoint: vi.fn(async () => "ok"),
    selectModel: vi.fn(async () => "ok"),
    testEndpoint: vi.fn(async () => "ok"),
    validate: vi.fn(async () => []),
    doctor: vi.fn(async () => ({ healthy: true, lines: [] })),
    exportRedacted: vi.fn(async () => "{}"),
    exit: vi.fn(),
  };
}

/** Extract the colour sequence ink emitted for the accent-coloured version. */
function accentSequence(frame: string): string {
  const match = /\u001b\[([0-9;]+)mvtest/.exec(frame);
  if (!match) throw new Error("no colour sequence found for the accent role");
  return match[1];
}

async function frameFor(
  theme: "dark" | "light",
  stale = false,
): Promise<string> {
  const view = render(
    React.createElement(App, { runtime: runtime(theme, stale) }),
  );
  await vi.waitFor(() => {
    expect(view.lastFrame()).toContain("CHAMP");
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const frame = view.lastFrame() ?? "";
  view.unmount();
  return frame;
}

describe("TUI theme colours end to end (#164)", () => {
  it("uses different accent role colours for dark and light themes", async () => {
    const dark = accentSequence(await frameFor("dark"));
    const light = accentSequence(await frameFor("light"));
    expect(dark).toMatch(/^[0-9;]+$/);
    expect(light).toMatch(/^[0-9;]+$/);
    expect(dark).not.toBe(light);
  });

  it("derives those colours from the semantic palettes", () => {
    expect(PALETTES.dark.accent).not.toBe(PALETTES.light.accent);
    expect(PALETTES.dark.error).not.toBe(PALETTES.light.error);
    expect(PALETTES.dark.success).not.toBe(PALETTES.light.success);
  });

  it("keeps semantic symbols in the rendered frame", async () => {
    const frame = await frameFor("dark", true);
    expect(frame).toContain("⚠");
  });
});
