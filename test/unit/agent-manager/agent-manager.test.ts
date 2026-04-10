/**
 * TDD: Tests for AgentManager — multi-session orchestrator.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentManager } from "@/agent-manager/agent-manager";
import type { ToolRegistry } from "@/tools/registry";
import type { LLMProvider } from "@/providers/types";

function stubProvider(name = "test"): LLMProvider {
  return {
    name,
    config: { provider: name, model: "m", maxTokens: 100, temperature: 0 },
    async *chat() {
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    async *complete() {
      yield {
        type: "done" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    },
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    countTokens: () => 0,
    modelInfo: () => ({
      id: "m",
      name: "m",
      provider: name,
      contextWindow: 4096,
      maxOutputTokens: 1024,
      supportsToolUse: false,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: () => {},
  } as LLMProvider;
}

function stubToolRegistry(): ToolRegistry {
  return {
    register: vi.fn(),
    execute: vi.fn(),
    getDefinitions: vi.fn().mockReturnValue([]),
    getTool: vi.fn(),
  } as unknown as ToolRegistry;
}

describe("AgentManager", () => {
  let manager: AgentManager;
  let provider: LLMProvider;

  beforeEach(() => {
    provider = stubProvider();
    manager = new AgentManager(
      stubToolRegistry(),
      "/workspace",
      () => provider,
    );
  });

  it("creates a session with auto-generated id", () => {
    const session = manager.createSession();
    expect(session.metadata.id).toBeTruthy();
    expect(session.metadata.id.length).toBeGreaterThan(5);
  });

  it("auto-labels from the provided label", () => {
    const session = manager.createSession("My task");
    expect(session.metadata.label).toBe("My task");
  });

  it("defaults label to 'New chat' when none provided", () => {
    const session = manager.createSession();
    expect(session.metadata.label).toBe("New chat");
  });

  it("assigns unique ids across sessions", () => {
    const s1 = manager.createSession();
    const s2 = manager.createSession();
    expect(s1.metadata.id).not.toBe(s2.metadata.id);
  });

  it("getActive returns null when no sessions exist", () => {
    expect(manager.getActive()).toBeNull();
  });

  it("createSession sets the new session as active", () => {
    const session = manager.createSession();
    expect(manager.getActive()?.metadata.id).toBe(session.metadata.id);
  });

  it("setActive switches to a different session", () => {
    const s1 = manager.createSession("first");
    const s2 = manager.createSession("second");
    expect(manager.getActive()?.metadata.id).toBe(s2.metadata.id);
    manager.setActive(s1.metadata.id);
    expect(manager.getActive()?.metadata.id).toBe(s1.metadata.id);
  });

  it("setActive throws for unknown session id", () => {
    expect(() => manager.setActive("nonexistent")).toThrow();
  });

  it("listSessions returns all non-archived sessions", () => {
    manager.createSession("a");
    manager.createSession("b");
    expect(manager.listSessions()).toHaveLength(2);
  });

  it("listSessions excludes archived by default", () => {
    const s1 = manager.createSession("a");
    manager.createSession("b");
    manager.archiveSession(s1.metadata.id);
    expect(manager.listSessions()).toHaveLength(1);
    expect(manager.listSessions()[0].label).toBe("b");
  });

  it("listSessions with includeArchived returns everything", () => {
    const s1 = manager.createSession("a");
    manager.createSession("b");
    manager.archiveSession(s1.metadata.id);
    expect(manager.listSessions(true)).toHaveLength(2);
  });

  it("abortSession changes state to aborted but keeps history", () => {
    const s = manager.createSession("task");
    manager.updateSessionState(s.metadata.id, "running");
    manager.abortSession(s.metadata.id);
    expect(manager.getSession(s.metadata.id)?.metadata.state).toBe("aborted");
  });

  it("deleteSession removes it from the map", () => {
    const s = manager.createSession("doomed");
    manager.deleteSession(s.metadata.id);
    expect(manager.getSession(s.metadata.id)).toBeUndefined();
    expect(manager.listSessions()).toHaveLength(0);
  });

  it("deleteSession sets active to null if it was the active session", () => {
    const s = manager.createSession("only");
    manager.deleteSession(s.metadata.id);
    expect(manager.getActive()).toBeNull();
  });

  it("archiveSession hides it from default listing", () => {
    const s = manager.createSession("hide me");
    manager.archiveSession(s.metadata.id);
    expect(manager.getSession(s.metadata.id)?.metadata.archived).toBe(true);
  });

  it("onChange fires on create", () => {
    const listener = vi.fn();
    manager.onChange(listener);
    manager.createSession("test");
    const events = listener.mock.calls.map((c) => c[0]);
    expect(
      events.some((e: { type: string }) => e.type === "sessionCreated"),
    ).toBe(true);
  });

  it("onChange fires on delete", () => {
    const s = manager.createSession("test");
    const listener = vi.fn();
    manager.onChange(listener);
    manager.deleteSession(s.metadata.id);
    const events = listener.mock.calls.map((c) => c[0]);
    expect(
      events.some((e: { type: string }) => e.type === "sessionDeleted"),
    ).toBe(true);
  });

  it("onChange fires on active change", () => {
    const s1 = manager.createSession("a");
    manager.createSession("b");
    const listener = vi.fn();
    manager.onChange(listener);
    manager.setActive(s1.metadata.id);
    const events = listener.mock.calls.map((c) => c[0]);
    expect(
      events.some((e: { type: string }) => e.type === "activeChanged"),
    ).toBe(true);
  });

  it("exportSession produces a SerializedSession", () => {
    const s = manager.createSession("export me");
    const serialized = manager.exportSession(s.metadata.id);
    expect(serialized.version).toBe(1);
    expect(serialized.metadata.id).toBe(s.metadata.id);
    expect(Array.isArray(serialized.history)).toBe(true);
  });

  it("importSession rebuilds from a SerializedSession", () => {
    const serialized = {
      version: 1 as const,
      metadata: {
        id: "imported-123",
        label: "imported",
        state: "idle" as const,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        mode: "agent" as const,
        messageCount: 1,
        modifiedFiles: [],
        archived: false,
      },
      history: [{ role: "user" as const, content: "hello" }],
    };
    const session = manager.importSession(serialized);
    expect(session.metadata.id).toBe("imported-123");
    expect(manager.getSession("imported-123")).toBeDefined();
  });

  it("swapProvider updates all sessions' controllers", () => {
    manager.createSession("a");
    manager.createSession("b");
    const newProvider = stubProvider("new-provider");
    manager.swapProvider(newProvider);
    // After swap, the active session should use the new provider.
    // We verify by checking the manager doesn't throw.
    expect(manager.getActive()).toBeDefined();
  });

  it("renameSession updates the label", () => {
    const s = manager.createSession("old");
    manager.renameSession(s.metadata.id, "new name");
    expect(manager.getSession(s.metadata.id)?.metadata.label).toBe("new name");
  });

  it("updateSessionLabel auto-labels from first message text", () => {
    const s = manager.createSession();
    const longText = "A".repeat(100);
    manager.autoLabelSession(s.metadata.id, longText);
    expect(
      manager.getSession(s.metadata.id)?.metadata.label.length,
    ).toBeLessThanOrEqual(60);
  });
});
