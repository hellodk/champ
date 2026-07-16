/**
 * Unit tests for TransactionManager - atomic multi-file edits with rollback
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { TransactionManager } from "../transaction-manager";

describe("TransactionManager", () => {
  let tempDir: string;
  let testFile1: string;
  let testFile2: string;
  let testFile3: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "txn-test-"));
    testFile1 = path.join(tempDir, "file1.txt");
    testFile2 = path.join(tempDir, "file2.txt");
    testFile3 = path.join(tempDir, "file3.txt");

    // Create test files with initial content
    await fs.writeFile(testFile1, "initial content 1");
    await fs.writeFile(testFile2, "initial content 2");
    await fs.writeFile(testFile3, "initial content 3");
  });

  afterEach(async () => {
    // Cleanup temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // =========================================================================
  // Test: queue() accepts and stages edits
  // =========================================================================

  describe("queue()", () => {
    it("accepts a single file edit and stages it", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("test transaction");

      manager.queue(
        txnId,
        testFile1,
        "initial content 1",
        "modified content 1",
      );

      const txn = manager.getTransaction(txnId);
      expect(txn).toBeDefined();
      expect(txn?.edits).toHaveLength(1);
      expect(txn?.edits[0].filePath).toBe(testFile1);
      expect(txn?.edits[0].oldContent).toBe("initial content 1");
      expect(txn?.edits[0].newContent).toBe("modified content 1");
      expect(txn?.status).toBe("pending");
    });

    it("accepts multiple edits to different files", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("multi-file transaction");

      manager.queue(txnId, testFile1, "initial content 1", "modified 1");
      manager.queue(txnId, testFile2, "initial content 2", "modified 2");
      manager.queue(txnId, testFile3, "initial content 3", "modified 3");

      const txn = manager.getTransaction(txnId);
      expect(txn?.edits).toHaveLength(3);
      expect(txn?.status).toBe("pending");
    });

    it("accepts multiple edits to the same file", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("same file multi-edit");

      manager.queue(txnId, testFile1, "initial content 1", "first change");
      manager.queue(txnId, testFile1, "first change", "second change");

      const txn = manager.getTransaction(txnId);
      expect(txn?.edits).toHaveLength(2);
    });

    it("throws error for non-existent transaction", () => {
      const manager = new TransactionManager();
      expect(() => {
        manager.queue("non-existent-id", testFile1, "old", "new");
      }).toThrow();
    });
  });

  // =========================================================================
  // Test: apply() - all succeed scenario
  // =========================================================================

  describe("apply() - all edits succeed", () => {
    it("applies a single edit successfully", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("single edit");

      manager.queue(
        txnId,
        testFile1,
        "initial content 1",
        "modified content 1",
      );
      const result = await manager.apply(txnId);

      expect(result.success).toBe(true);
      expect(result.filesModified).toHaveLength(1);

      const content = await fs.readFile(testFile1, "utf-8");
      expect(content).toBe("modified content 1");
    });

    it("applies multiple edits to different files", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("multi file");

      manager.queue(txnId, testFile1, "initial content 1", "new 1");
      manager.queue(txnId, testFile2, "initial content 2", "new 2");
      manager.queue(txnId, testFile3, "initial content 3", "new 3");

      const result = await manager.apply(txnId);

      expect(result.success).toBe(true);
      expect(result.filesModified).toHaveLength(3);

      const c1 = await fs.readFile(testFile1, "utf-8");
      const c2 = await fs.readFile(testFile2, "utf-8");
      const c3 = await fs.readFile(testFile3, "utf-8");

      expect(c1).toBe("new 1");
      expect(c2).toBe("new 2");
      expect(c3).toBe("new 3");
    });

    it("marks transaction as success after apply", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("success test");

      manager.queue(txnId, testFile1, "initial content 1", "modified");
      await manager.apply(txnId);

      const txn = manager.getTransaction(txnId);
      expect(txn?.status).toBe("success");
    });

    it("sets timestamp and filesAffected metadata", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("metadata test");

      manager.queue(txnId, testFile1, "initial content 1", "modified");
      const beforeTime = Date.now();
      await manager.apply(txnId);
      const afterTime = Date.now();

      const txn = manager.getTransaction(txnId);
      expect(txn?.timestamp).toBeDefined();
      expect(txn?.timestamp!.getTime()).toBeGreaterThanOrEqual(beforeTime);
      expect(txn?.timestamp!.getTime()).toBeLessThanOrEqual(afterTime);
      expect(txn?.filesAffected).toHaveLength(1);
      expect(txn?.filesAffected).toContain(testFile1);
    });
  });

  // =========================================================================
  // Test: apply() - rollback on failure
  // =========================================================================

  describe("apply() - rollback on failure", () => {
    it("reverts all files when a single edit fails", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("rollback test");

      // Queue two edits: one valid, one with invalid old content
      manager.queue(txnId, testFile1, "initial content 1", "modified 1");
      manager.queue(txnId, testFile2, "WRONG CONTENT", "modified 2"); // Will fail

      const result = await manager.apply(txnId);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Both files should remain unchanged
      const c1 = await fs.readFile(testFile1, "utf-8");
      const c2 = await fs.readFile(testFile2, "utf-8");

      expect(c1).toBe("initial content 1");
      expect(c2).toBe("initial content 2");
    });

    it("marks transaction as failed after rollback", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("failed txn");

      manager.queue(txnId, testFile1, "initial content 1", "modified 1");
      manager.queue(txnId, testFile2, "WRONG CONTENT", "modified 2");

      await manager.apply(txnId);

      const txn = manager.getTransaction(txnId);
      expect(txn?.status).toBe("failed");
    });

    it("includes error details in failed transaction", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("error details");

      manager.queue(txnId, testFile1, "initial content 1", "modified 1");
      manager.queue(txnId, testFile2, "WRONG CONTENT", "modified 2");

      await manager.apply(txnId);

      const txn = manager.getTransaction(txnId);
      expect(txn?.error).toBeDefined();
      expect(txn?.error?.message).toContain("Could not find");
    });

    it("preserves pre-transaction state in metadata", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("state preservation");

      manager.queue(txnId, testFile1, "initial content 1", "modified 1");
      manager.queue(txnId, testFile2, "WRONG CONTENT", "modified 2");

      await manager.apply(txnId);

      const txn = manager.getTransaction(txnId);
      expect(txn?.rollbackData).toBeDefined();
      if (txn?.rollbackData) {
        expect(txn.rollbackData[testFile1]).toBe("initial content 1");
        expect(txn.rollbackData[testFile2]).toBe("initial content 2");
      }
    });
  });

  // =========================================================================
  // Test: Transaction metadata and tracking
  // =========================================================================

  describe("Transaction metadata", () => {
    it("creates transaction with unique ID", () => {
      const manager = new TransactionManager();
      const txnId1 = manager.createTransaction("txn 1");
      const txnId2 = manager.createTransaction("txn 2");

      expect(txnId1).not.toBe(txnId2);
      expect(manager.getTransaction(txnId1)).toBeDefined();
      expect(manager.getTransaction(txnId2)).toBeDefined();
    });

    it("tracks transaction description", () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("my description");

      const txn = manager.getTransaction(txnId);
      expect(txn?.description).toBe("my description");
    });

    it("returns all transactions", async () => {
      const manager = new TransactionManager();
      const txnId1 = manager.createTransaction("txn 1");
      const txnId2 = manager.createTransaction("txn 2");

      manager.queue(txnId1, testFile1, "initial content 1", "modified 1");
      await manager.apply(txnId1);

      const allTxns = manager.getAllTransactions();
      expect(allTxns).toHaveLength(2);
      expect(allTxns.map((t) => t.id)).toContain(txnId1);
      expect(allTxns.map((t) => t.id)).toContain(txnId2);
    });
  });

  // =========================================================================
  // Test: Abort transaction
  // =========================================================================

  describe("abort()", () => {
    it("cancels a pending transaction without applying changes", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("abort test");

      manager.queue(txnId, testFile1, "initial content 1", "modified 1");
      manager.abort(txnId);

      const txn = manager.getTransaction(txnId);
      expect(txn?.status).toBe("aborted");

      const content = await fs.readFile(testFile1, "utf-8");
      expect(content).toBe("initial content 1");
    });

    it("throws error when aborting non-existent transaction", () => {
      const manager = new TransactionManager();
      expect(() => {
        manager.abort("non-existent");
      }).toThrow();
    });
  });

  // =========================================================================
  // Test: Edit validation (fuzzy matching)
  // =========================================================================

  describe("Edit validation", () => {
    it("accepts exact match for old content", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("exact match");

      manager.queue(txnId, testFile1, "initial content 1", "modified");
      const result = await manager.apply(txnId);

      expect(result.success).toBe(true);
    });

    it("rejects edit when old content not found", async () => {
      const manager = new TransactionManager();
      const txnId = manager.createTransaction("not found");

      manager.queue(txnId, testFile1, "non-existent content", "modified");
      const result = await manager.apply(txnId);

      expect(result.success).toBe(false);
      expect(result.error?.message).toContain("Could not find");
    });
  });

  // =========================================================================
  // Test: Clear transaction history
  // =========================================================================

  describe("clearHistory()", () => {
    it("clears completed transactions but keeps pending", async () => {
      const manager = new TransactionManager();
      const txnId1 = manager.createTransaction("completed");
      const txnId2 = manager.createTransaction("pending");

      manager.queue(txnId1, testFile1, "initial content 1", "modified");
      await manager.apply(txnId1);

      manager.clearHistory();

      expect(manager.getTransaction(txnId1)).toBeUndefined();
      expect(manager.getTransaction(txnId2)).toBeDefined();
      expect(manager.getTransaction(txnId2)?.status).toBe("pending");
    });
  });
});
