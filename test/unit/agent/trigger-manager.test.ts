import { describe, it, expect, vi, beforeEach } from "vitest";
import { TriggerManager } from "@/agent/trigger-manager";
import type { TriggerDefinition } from "@/config/config-loader";

vi.mock("vscode", () => ({
  workspace: {
    createFileSystemWatcher: vi.fn(() => ({
      onDidSave: vi.fn(() => ({ dispose: vi.fn() })),
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
    })),
  },
}));

describe("TriggerManager", () => {
  let manager: TriggerManager;
  let agentFn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new TriggerManager();
    agentFn = vi.fn().mockResolvedValue(undefined);
  });

  it("creates one watcher per trigger", async () => {
    const { workspace } = await import("vscode");
    const defs: TriggerDefinition[] = [
      {
        name: "t1",
        glob: "**/*.ts",
        on: "save",
        run: "my-agent",
        debounceMs: 0,
      },
      {
        name: "t2",
        glob: "**/*.py",
        on: "save",
        run: "other-agent",
        debounceMs: 0,
      },
    ];
    manager.loadTriggers(defs, agentFn);
    expect(workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2);
  });

  it("disposeAll clears all watchers", async () => {
    const { workspace } = await import("vscode");
    const mockDispose = vi.fn();
    const mockWatcher = {
      onDidSave: vi.fn(() => ({ dispose: mockDispose })),
      onDidChange: vi.fn(() => ({ dispose: mockDispose })),
      dispose: mockDispose,
    };
    vi.mocked(workspace.createFileSystemWatcher).mockReturnValue(
      mockWatcher as any,
    );
    const defs: TriggerDefinition[] = [
      { name: "t1", glob: "**/*.ts", on: "save", run: "agent", debounceMs: 0 },
    ];
    manager.loadTriggers(defs, agentFn);
    manager.disposeAll();
    expect(mockDispose).toHaveBeenCalled();
  });

  it("loadTriggers replaces previous watchers on second call", async () => {
    const { workspace } = await import("vscode");
    const defs: TriggerDefinition[] = [
      { name: "t1", glob: "**/*.ts", on: "save", run: "agent", debounceMs: 0 },
    ];
    manager.loadTriggers(defs, agentFn);
    manager.loadTriggers(defs, agentFn);
    // createFileSystemWatcher called twice total (once per loadTriggers call)
    expect(workspace.createFileSystemWatcher).toHaveBeenCalledTimes(2);
  });
});
