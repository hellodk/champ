/**
 * TDD: Tests for CheckpointStore persistence.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CheckpointStore } from "@/checkpoints/checkpoint-store";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Checkpoint } from "@/checkpoints/checkpoint-manager";

describe("CheckpointStore", () => {
  let tempDir: string;
  let store: CheckpointStore;

  beforeEach(async () => {
    // Create a temporary directory for tests
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "checkpoint-store-test-"));
    store = new CheckpointStore(tempDir);
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.promises.rm(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should save and load a checkpoint", async () => {
    const checkpoint: Checkpoint = {
      id: "cp_test_1",
      label: "Test Checkpoint",
      timestamp: Date.now(),
      snapshots: [
        {
          filePath: "src/test.ts",
          content: new Uint8Array([1, 2, 3, 4, 5]),
          existed: true,
        },
      ],
    };

    await store.save(checkpoint);

    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("cp_test_1");
    expect(loaded[0].label).toBe("Test Checkpoint");
    expect(loaded[0].snapshots[0].filePath).toBe("src/test.ts");
    expect(loaded[0].snapshots[0].content).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("should handle checkpoints with null content (deleted files)", async () => {
    const checkpoint: Checkpoint = {
      id: "cp_test_deleted",
      label: "Deleted File",
      timestamp: Date.now(),
      snapshots: [
        {
          filePath: "deleted.ts",
          content: null,
          existed: false,
        },
      ],
    };

    await store.save(checkpoint);

    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].snapshots[0].content).toBeNull();
    expect(loaded[0].snapshots[0].existed).toBe(false);
  });

  it("should load multiple checkpoints", async () => {
    const cp1: Checkpoint = {
      id: "cp_1",
      label: "Checkpoint 1",
      timestamp: Date.now(),
      snapshots: [],
    };

    const cp2: Checkpoint = {
      id: "cp_2",
      label: "Checkpoint 2",
      timestamp: Date.now() + 1000,
      snapshots: [],
    };

    await store.save(cp1);
    await store.save(cp2);

    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(2);
    expect(loaded.map(c => c.id)).toContain("cp_1");
    expect(loaded.map(c => c.id)).toContain("cp_2");
  });

  it("should delete a checkpoint", async () => {
    const checkpoint: Checkpoint = {
      id: "cp_to_delete",
      label: "To Delete",
      timestamp: Date.now(),
      snapshots: [],
    };

    await store.save(checkpoint);
    await store.delete("cp_to_delete");

    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(0);
  });

  it("should skip corrupted files", async () => {
    // Save a valid checkpoint
    const checkpoint: Checkpoint = {
      id: "cp_valid",
      label: "Valid",
      timestamp: Date.now(),
      snapshots: [],
    };
    await store.save(checkpoint);

    // Write a corrupted JSON file
    const corruptedPath = path.join(tempDir, "corrupted.json");
    await fs.promises.writeFile(corruptedPath, "{ invalid json", "utf-8");

    // loadAll should skip the corrupted file
    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("cp_valid");
  });

  it("should handle missing storage directory gracefully", async () => {
    const nonexistentDir = path.join(tempDir, "nonexistent");
    const storeNonexistent = new CheckpointStore(nonexistentDir);

    const loaded = await storeNonexistent.loadAll();
    expect(loaded).toHaveLength(0);
  });

  it("should handle large file content (base64 encoding)", async () => {
    // Create a larger buffer (1MB)
    const largeContent = new Uint8Array(1024 * 1024);
    for (let i = 0; i < largeContent.length; i++) {
      largeContent[i] = i % 256;
    }

    const checkpoint: Checkpoint = {
      id: "cp_large",
      label: "Large File",
      timestamp: Date.now(),
      snapshots: [
        {
          filePath: "large.bin",
          content: largeContent,
          existed: true,
        },
      ],
    };

    await store.save(checkpoint);

    const loaded = await store.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].snapshots[0].content).toEqual(largeContent);
  });
});
