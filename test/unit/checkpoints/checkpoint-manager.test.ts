/**
 * TDD: Tests for CheckpointManager.
 * Shadow-copy snapshot and restore.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CheckpointManager } from "@/checkpoints/checkpoint-manager";
import * as vscode from "vscode";

describe("CheckpointManager", () => {
  let manager: CheckpointManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new CheckpointManager("/test-workspace");
  });

  it("should create a checkpoint before file modification", async () => {
    const fileContent = new TextEncoder().encode("original content");
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(fileContent);

    const checkpoint = await manager.create("Before edit", ["src/main.ts"]);
    expect(checkpoint.id).toBeDefined();
    expect(checkpoint.label).toBe("Before edit");
    expect(checkpoint.snapshots).toHaveLength(1);
    expect(checkpoint.snapshots[0].filePath).toBe("src/main.ts");
  });

  it("should restore files to checkpoint state", async () => {
    const original = new TextEncoder().encode("original");
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(original);

    const cp = await manager.create("Before edit", ["main.ts"]);

    // Simulate file was modified
    (
      vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(undefined);

    await manager.restore(cp.id);

    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
      expect.anything(),
      original,
    );
  });

  it("should delete files that were created after checkpoint", async () => {
    // File did not exist at checkpoint time
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("Not found"));

    const cp = await manager.create("Before create", ["new-file.ts"]);

    (vscode.workspace.fs.delete as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    await manager.restore(cp.id);

    expect(vscode.workspace.fs.delete).toHaveBeenCalled();
  });

  it("should list all checkpoints", async () => {
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(new TextEncoder().encode("content"));

    await manager.create("CP 1", ["a.ts"]);
    await manager.create("CP 2", ["b.ts"]);

    const list = manager.list();
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe("CP 1");
    expect(list[1].label).toBe("CP 2");
  });

  it("should restore to a middle checkpoint and discard later ones", async () => {
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(new TextEncoder().encode("content"));
    (
      vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(undefined);

    const cp1 = await manager.create("CP 1", ["a.ts"]);
    await manager.create("CP 2", ["b.ts"]);
    await manager.create("CP 3", ["c.ts"]);

    await manager.restore(cp1.id);

    // Should only have checkpoints up to cp1 (exclusive)
    expect(manager.list().length).toBeLessThan(3);
  });

  it("should throw for unknown checkpoint id", async () => {
    await expect(manager.restore("nonexistent")).rejects.toThrow();
  });
});
