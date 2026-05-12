import { describe, it, expect, vi, beforeEach } from "vitest";
import { TriggerManager } from "@/agent/trigger-manager";
import type { TriggerDefinition } from "@/config/config-loader";

vi.mock("vscode", () => ({
  workspace: {
    createFileSystemWatcher: vi.fn(() => ({
      onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
      dispose: vi.fn(),
    })),
    onDidSaveTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
    asRelativePath: vi.fn((uri: { fsPath?: string }) => uri?.fsPath ?? ""),
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

  it("uses onDidSaveTextDocument for save triggers (not FileSystemWatcher)", async () => {
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
    // Save triggers must NOT create FileSystemWatchers — they use onDidSaveTextDocument.
    expect(workspace.createFileSystemWatcher).not.toHaveBeenCalled();
    expect(workspace.onDidSaveTextDocument).toHaveBeenCalledTimes(2);
  });

  it("uses FileSystemWatcher.onDidChange for change triggers", async () => {
    const { workspace } = await import("vscode");
    const defs: TriggerDefinition[] = [
      {
        name: "t1",
        glob: "**/*.ts",
        on: "change",
        run: "my-agent",
        debounceMs: 0,
      },
    ];
    manager.loadTriggers(defs, agentFn);
    expect(workspace.createFileSystemWatcher).toHaveBeenCalledTimes(1);
    expect(workspace.onDidSaveTextDocument).not.toHaveBeenCalled();
  });

  it("disposeAll clears all watchers", async () => {
    const { workspace } = await import("vscode");
    const mockDispose = vi.fn();
    vi.mocked(workspace.onDidSaveTextDocument).mockReturnValue({
      dispose: mockDispose,
    });
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
    // onDidSaveTextDocument called twice total (once per loadTriggers call)
    expect(workspace.onDidSaveTextDocument).toHaveBeenCalledTimes(2);
  });
});
