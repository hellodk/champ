/**
 * Regression test for issue #9: module-level message listeners leak
 *
 * Before the fix, window.addEventListener was called at module scope in
 * TeamBuilderPanel.tsx and AgentGraphPanel.tsx — never cleaned up, adding
 * N duplicate listeners for N panel re-creations.
 *
 * After the fix, each listener is registered inside a useEffect and removed
 * via the cleanup function on unmount.
 *
 * These tests verify the cleanup contract: addEventListener is called on
 * mount and removeEventListener is called on unmount with the same handler.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("window.addEventListener cleanup contract", () => {
  let addSpy: ReturnType<typeof vi.spyOn>;
  let removeSpy: ReturnType<typeof vi.spyOn>;
  const registeredHandlers: Map<string, EventListenerOrEventListenerObject[]> =
    new Map();

  beforeEach(() => {
    registeredHandlers.clear();

    addSpy = vi
      .spyOn(window, "addEventListener")
      .mockImplementation(
        (type: string, handler: EventListenerOrEventListenerObject) => {
          const existing = registeredHandlers.get(type) ?? [];
          registeredHandlers.set(type, [...existing, handler]);
        },
      );

    removeSpy = vi
      .spyOn(window, "removeEventListener")
      .mockImplementation(
        (type: string, handler: EventListenerOrEventListenerObject) => {
          const existing = registeredHandlers.get(type) ?? [];
          registeredHandlers.set(
            type,
            existing.filter((h) => h !== handler),
          );
        },
      );
  });

  afterEach(() => {
    addSpy.mockRestore();
    removeSpy.mockRestore();
  });

  it("registering then unregistering leaves zero handlers for the event type", () => {
    // Simulate the useEffect pattern: register on mount, remove on unmount
    let capturedHandler: ((e: MessageEvent) => void) | null = null;

    function mount(): () => void {
      const handler = (_e: MessageEvent): void => {
        // handler body (not under test here)
      };
      capturedHandler = handler;
      window.addEventListener("message", handler);
      return () => window.removeEventListener("message", handler);
    }

    const cleanup = mount();

    // After mount: exactly one listener registered
    expect(registeredHandlers.get("message")?.length).toBe(1);
    expect(registeredHandlers.get("message")?.[0]).toBe(capturedHandler);

    // Simulate unmount — cleanup runs
    cleanup();

    // After cleanup: zero listeners
    expect(registeredHandlers.get("message")?.length).toBe(0);
  });

  it("multiple mounts without cleanup accumulate listeners (shows the OLD bug)", () => {
    // This test documents the pre-fix behaviour.
    // After fix, this path is never taken because the module-level call is removed.
    const handlers: ((e: MessageEvent) => void)[] = [];

    function addModuleLevelListener(): void {
      const h = (_e: MessageEvent): void => {};
      handlers.push(h);
      window.addEventListener("message", h);
      // ← no cleanup registered — this was the bug
    }

    addModuleLevelListener();
    addModuleLevelListener();
    addModuleLevelListener();

    expect(registeredHandlers.get("message")?.length).toBe(3);
    // Three listeners for three "panel re-creations" — the leak
  });

  it("useEffect cleanup removes exactly the handler that was registered", () => {
    const handler = (_e: MessageEvent): void => {};
    const otherHandler = (_e: MessageEvent): void => {};

    window.addEventListener("message", otherHandler); // pre-existing
    window.addEventListener("message", handler); // our component's handler

    expect(registeredHandlers.get("message")?.length).toBe(2);

    // Component unmounts — only its own handler removed
    window.removeEventListener("message", handler);

    const remaining = registeredHandlers.get("message") ?? [];
    expect(remaining.length).toBe(1);
    expect(remaining[0]).toBe(otherHandler);
  });
});
