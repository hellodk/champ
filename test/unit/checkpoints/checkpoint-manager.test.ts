/**
 * TDD: Tests for CheckpointManager.
 * Shadow-copy snapshot and restore.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { CheckpointManager } from "@/checkpoints/checkpoint-manager";
import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("CheckpointManager", () => {
  let manager: CheckpointManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    manager = new CheckpointManager("/test-workspace");
    // Initialize to load from disk (no-op for in-memory tests)
    await manager.initialize();
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

describe("CheckpointManager - Persistence", () => {
  let tempDir: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    // Create a temporary directory for tests
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "checkpoint-manager-test-"),
    );
    manager = new CheckpointManager("/test-workspace", tempDir);
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.promises.rm(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should save checkpoints to disk", async () => {
    const fileContent = new TextEncoder().encode("original content");
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(fileContent);

    // Wait for async initialization to complete
    await manager.waitForLoad();

    const checkpoint = await manager.create("Persistent CP", ["src/main.ts"]);

    // Check that the file was saved to disk
    const files = await fs.promises.readdir(tempDir);
    expect(files).toContain(`${checkpoint.id}.json`);
  });

  it("should load checkpoints from disk on initialization", async () => {
    const fileContent = new TextEncoder().encode("original content");
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(fileContent);

    // Wait for async initialization to complete
    await manager.waitForLoad();

    // Create a checkpoint with the first manager
    const checkpoint = await manager.create("CP 1", ["src/main.ts"]);
    const cpId = checkpoint.id;

    // Create a new manager instance (simulating extension restart)
    const newManager = new CheckpointManager("/test-workspace", tempDir);
    // Wait for async initialization to complete
    await newManager.waitForLoad();

    // The new manager should have loaded the checkpoint from disk
    const list = newManager.list();
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((c) => c.id === cpId)).toBe(true);
  });

  it("should restore checkpoints persisted to disk", async () => {
    const fileContent = new TextEncoder().encode("original");
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(fileContent);
    (
      vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(undefined);

    // Wait for async initialization to complete
    await manager.waitForLoad();

    // Create a checkpoint
    const checkpoint = await manager.create("Before edit", ["main.ts"]);

    // Create a new manager and restore
    const newManager = new CheckpointManager("/test-workspace", tempDir);
    // Wait for async initialization to complete
    await newManager.waitForLoad();
    await newManager.restore(checkpoint.id);

    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
      expect.anything(),
      fileContent,
    );
  });

  it("should persist multiple checkpoints", async () => {
    const fileContent = new TextEncoder().encode("content");
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(fileContent);

    // Wait for async initialization to complete
    await manager.waitForLoad();

    await manager.create("CP 1", ["a.ts"]);
    await manager.create("CP 2", ["b.ts"]);

    // Load a new manager instance
    const newManager = new CheckpointManager("/test-workspace", tempDir);
    // Wait for async initialization to complete
    await newManager.waitForLoad();
    const list = newManager.list();

    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("should delete persisted checkpoints from memory immediately", async () => {
    const fileContent = new TextEncoder().encode("content");
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(fileContent);

    // Wait for async initialization to complete
    await manager.waitForLoad();

    const checkpoint = await manager.create("CP to delete", ["test.ts"]);
    const cpId = checkpoint.id;

    // Verify checkpoint exists in memory
    expect(manager.list()).toContainEqual(
      expect.objectContaining({ id: cpId }),
    );

    // Delete via clear - should clear from memory immediately
    manager.clear();

    // Memory should be cleared immediately
    expect(manager.list()).toHaveLength(0);

    // Files should be deleted asynchronously (within 2 seconds)
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const files = await fs.promises.readdir(tempDir);
    expect(files).not.toContain(`${cpId}.json`);
  });
});
