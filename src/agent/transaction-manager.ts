/**
 * TransactionManager: Atomic multi-file edits with all-or-nothing rollback.
 *
 * Problem: When an agent generates code changes spanning multiple files,
 * individual edits can fail, leaving the workspace in an inconsistent state
 * ("5 of 10 files edited").
 *
 * Solution: Queue all edits in a transaction, validate them all, then apply
 * atomically. If any edit fails, rollback all changes and report which file
 * failed and why.
 *
 * Features:
 * - Atomic apply/rollback: all edits succeed together or all fail together
 * - Metadata tracking: transaction ID, timestamp, files affected, error details
 * - Pre-transaction state preservation: for audit and recovery
 * - Support for multiple transactions in parallel (each with independent state)
 */

import * as fs from "fs/promises";

/**
 * A single file edit: search for oldContent, replace with newContent.
 */
export interface FileEdit {
  filePath: string;
  oldContent: string;
  newContent: string;
}

/**
 * Status of a transaction through its lifecycle.
 */
export type TransactionStatus =
  | "pending"
  | "in-progress"
  | "success"
  | "failed"
  | "aborted";

/**
 * Error details if a transaction fails.
 */
export interface TransactionError {
  message: string;
  filePath?: string;
  index?: number; // which edit in the queue failed
}

/**
 * A single transaction: a group of file edits to apply atomically.
 */
export interface Transaction {
  id: string;
  description: string;
  status: TransactionStatus;
  edits: FileEdit[];
  timestamp?: Date;
  filesAffected: string[];
  error?: TransactionError;
  rollbackData?: Record<string, string>; // pre-transaction state for recovery
}

/**
 * Result of applying a transaction.
 */
export interface ApplyResult {
  success: boolean;
  filesModified: string[];
  error?: TransactionError;
}

/**
 * Manages atomic multi-file transactions.
 */
export class TransactionManager {
  private transactions = new Map<string, Transaction>();
  private transactionCounter = 0;

  /**
   * Create a new transaction and return its ID.
   * The transaction starts in "pending" state with no edits.
   */
  createTransaction(description: string): string {
    const id = `txn-${Date.now()}-${++this.transactionCounter}`;
    this.transactions.set(id, {
      id,
      description,
      status: "pending",
      edits: [],
      filesAffected: [],
    });
    return id;
  }

  /**
   * Get a transaction by ID, or undefined if not found.
   */
  getTransaction(id: string): Transaction | undefined {
    return this.transactions.get(id);
  }

  /**
   * Get all transactions (for audit / history).
   */
  getAllTransactions(): Transaction[] {
    return Array.from(this.transactions.values());
  }

  /**
   * Queue a file edit in a transaction.
   * Throws if the transaction does not exist.
   */
  queue(
    txnId: string,
    filePath: string,
    oldContent: string,
    newContent: string,
  ): void {
    const txn = this.transactions.get(txnId);
    if (!txn) {
      throw new Error(`Transaction ${txnId} not found`);
    }

    if (txn.status !== "pending") {
      throw new Error(
        `Cannot queue edits on transaction in ${txn.status} state`,
      );
    }

    txn.edits.push({
      filePath,
      oldContent,
      newContent,
    });

    // Track unique files affected
    if (!txn.filesAffected.includes(filePath)) {
      txn.filesAffected.push(filePath);
    }
  }

  /**
   * Apply a transaction: validate all edits, then write atomically.
   * On any failure, roll back all changes.
   *
   * Returns ApplyResult with success status and list of modified files.
   */
  async apply(txnId: string): Promise<ApplyResult> {
    const txn = this.transactions.get(txnId);
    if (!txn) {
      return {
        success: false,
        filesModified: [],
        error: { message: `Transaction ${txnId} not found` },
      };
    }

    if (txn.edits.length === 0) {
      return {
        success: true,
        filesModified: [],
      };
    }

    txn.status = "in-progress";

    try {
      // Step 1: Read current state of all affected files for rollback preservation
      const rollbackData: Record<string, string> = {};
      for (const edit of txn.edits) {
        if (!rollbackData[edit.filePath]) {
          try {
            rollbackData[edit.filePath] = await fs.readFile(
              edit.filePath,
              "utf-8",
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return this.failTransaction(txn, {
              message: `Failed to read ${edit.filePath}: ${message}`,
              filePath: edit.filePath,
            });
          }
        }
      }
      txn.rollbackData = rollbackData;

      // Step 2: Validate all edits (check old_content exists)
      for (let i = 0; i < txn.edits.length; i++) {
        const edit = txn.edits[i];
        const currentContent = rollbackData[edit.filePath];

        if (!this.validateEdit(currentContent, edit.oldContent)) {
          return this.failTransaction(txn, {
            message: `Could not find the specified old_content in ${edit.filePath}. Check that the content matches exactly.`,
            filePath: edit.filePath,
            index: i,
          });
        }
      }

      // Step 3: Apply all edits in sequence (now that all are validated)
      const appliedEdits: FileEdit[] = [];
      for (const edit of txn.edits) {
        try {
          await this.applyEdit(edit, rollbackData[edit.filePath]);
          appliedEdits.push(edit);
        } catch (err) {
          // On failure, rollback all applied edits
          const message = err instanceof Error ? err.message : String(err);
          await this.rollback(rollbackData, appliedEdits);
          return this.failTransaction(txn, {
            message: `Failed to apply edit to ${edit.filePath}: ${message}`,
            filePath: edit.filePath,
          });
        }
      }

      // Success: mark transaction complete
      txn.timestamp = new Date();
      txn.status = "success";
      return {
        success: true,
        filesModified: appliedEdits.map((e) => e.filePath),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.failTransaction(txn, {
        message: `Transaction error: ${message}`,
      });
    }
  }

  /**
   * Abort a pending transaction without applying any changes.
   */
  abort(txnId: string): void {
    const txn = this.transactions.get(txnId);
    if (!txn) {
      throw new Error(`Transaction ${txnId} not found`);
    }

    if (txn.status !== "pending") {
      throw new Error(
        `Cannot abort transaction in ${txn.status} state (only pending transactions can be aborted)`,
      );
    }

    txn.status = "aborted";
  }

  /**
   * Clear completed (success/failed/aborted) transactions, keeping pending ones.
   * Useful for cleanup without losing audit trail during a session.
   */
  clearHistory(): void {
    const keysToDelete: string[] = [];
    for (const [id, txn] of this.transactions) {
      if (txn.status !== "pending") {
        keysToDelete.push(id);
      }
    }
    for (const key of keysToDelete) {
      this.transactions.delete(key);
    }
  }

  /**
   * Private helper: validate that oldContent exists in current file content.
   * Supports exact match only (no fuzzy matching at transaction level).
   */
  private validateEdit(currentContent: string, oldContent: string): boolean {
    return currentContent.includes(oldContent);
  }

  /**
   * Private helper: apply a single edit to a file.
   */
  private async applyEdit(
    edit: FileEdit,
    currentContent: string,
  ): Promise<void> {
    const newContent = currentContent.replace(edit.oldContent, edit.newContent);
    await fs.writeFile(edit.filePath, newContent, "utf-8");
  }

  /**
   * Private helper: rollback applied edits after a failure.
   */
  private async rollback(
    rollbackData: Record<string, string>,
    appliedEdits: FileEdit[],
  ): Promise<void> {
    for (const edit of appliedEdits) {
      try {
        await fs.writeFile(edit.filePath, rollbackData[edit.filePath], "utf-8");
      } catch (err) {
        console.error(
          `TransactionManager: failed to rollback ${edit.filePath}:`,
          err,
        );
      }
    }
  }

  /**
   * Private helper: mark transaction as failed and record error.
   */
  private failTransaction(
    txn: Transaction,
    error: TransactionError,
  ): ApplyResult {
    txn.status = "failed";
    txn.error = error;
    txn.timestamp = new Date();
    return {
      success: false,
      filesModified: [],
      error,
    };
  }
}
