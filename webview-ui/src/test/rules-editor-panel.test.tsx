/**
 * RulesEditorPanel listener-lifecycle + rendering coverage (#112).
 *
 * Contract (mirrors test/unit/webview/panel-listener-cleanup.test.ts):
 * the panel must NOT register window listeners at module import time;
 * it registers exactly one "message" listener on mount and removes the
 * identical handler reference on unmount.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, screen, waitFor } from "@testing-library/preact";

type Handler = EventListenerOrEventListenerObject;

describe("RulesEditorPanel message-listener lifecycle", () => {
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;
  let registered: Map<string, Handler[]>;

  const loadPanel = async () => await import("../components/RulesEditorPanel");

  beforeEach(() => {
    vi.resetModules();
    registered = new Map();

    addSpy = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type: string, handler: Handler) => {
        const existing = registered.get(type) ?? [];
        registered.set(type, [...existing, handler]);
      });

    removeSpy = vi
      .spyOn(window, "removeEventListener")
      .mockImplementation((type: string, handler: Handler) => {
        const existing = registered.get(type) ?? [];
        registered.set(
          type,
          existing.filter((h) => h !== handler),
        );
      });
  });

  afterEach(() => {
    cleanup();
    addSpy.mockRestore();
    removeSpy.mockRestore();
    vi.resetModules();
  });

  it("registers no listeners at module import time (no module-level leak)", async () => {
    await loadPanel();
    expect(registered.get("message") ?? []).toHaveLength(0);
  });

  it("mount adds exactly one message listener; unmount removes the identical handler", async () => {
    const { RulesEditorPanel } = await loadPanel();

    const { unmount } = render(<RulesEditorPanel />);
    const listeners = registered.get("message") ?? [];
    expect(listeners).toHaveLength(1);
    const mountedHandler = listeners[0];

    unmount();
    expect(registered.get("message") ?? []).toHaveLength(0);

    // The removed handler must be the same reference that was added
    void mountedHandler;
  });

  it("remount after unmount re-registers a fresh listener (no accumulation)", async () => {
    const { RulesEditorPanel } = await loadPanel();

    const first = render(<RulesEditorPanel />);
    first.unmount();
    const second = render(<RulesEditorPanel />);
    second.unmount();

    expect(registered.get("message") ?? []).toHaveLength(0);
  });
});

describe("RulesEditorPanel rendering", () => {
  const loadPanelFresh = async () => {
    vi.resetModules();
    return await import("../components/RulesEditorPanel");
  };

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).vscode = {
      postMessage: vi.fn(),
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as Record<string, unknown>).vscode;
    vi.resetModules();
  });

  it("shows empty-state hint when no rulesList has arrived", async () => {
    const { RulesEditorPanel } = await loadPanelFresh();
    render(<RulesEditorPanel />);
    expect(screen.getByText(/No rules yet/)).toBeTruthy();
  });

  it("populates the rule list when a rulesList message is delivered to the mounted handler", async () => {
    // Listeners are NOT mocked in this block, so the mount-scoped effect
    // wires a real DOM listener; dispatch through jsdom reaches it.
    const { RulesEditorPanel } = await loadPanelFresh();
    render(<RulesEditorPanel />);

    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "rulesList",
          rules: [
            {
              name: "no-console",
              content: "Never use console.log in shipped code.",
              type: "always",
            },
          ],
        },
      }),
    );

    await waitFor(() => expect(screen.getByText("no-console")).toBeTruthy());
  });
});
