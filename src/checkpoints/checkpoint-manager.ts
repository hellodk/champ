/**
 * CheckpointManager: shadow-copy snapshot and restore.
 *
 * Before any destructive agent action (file edit, create, delete,
 * terminal command), the agent layer creates a checkpoint by capturing
 * the current contents of affected files. If the user later clicks
 * "Restore" on a prior message in the chat, we walk back from the
 * current checkpoint to the requested one, restoring file state as we go.
 *
 * Shadow-copy is preferred over `git stash` because:
 *   - Works in non-git repositories.
 *   - Doesn't clutter the user's stash stack.
 *   - Captures both modifications AND creations (deleting files that
 *     were created after the checkpoint).
 *
 * Checkpoints are persisted to disk via CheckpointStore, allowing
 * restoration across extension restarts.
 */
import * as vscode from "vscode";
import { resolveInWorkspace } from "../utils/workspace-path";
import { CheckpointStore } from "./checkpoint-store";

/**
 * A single file snapshot within a checkpoint. `content === null` means
 * the file did not exist at checkpoint time, so restoring it means
 * deleting the current file (it was created by the agent afterward).
 */
export interface FileSnapshot {
  filePath: string;
  content: Uint8Array | null;
  existed: boolean;
}

export interface Checkpoint {
  id: string;
  label: string;
  timestamp: number;
  snapshots: FileSnapshot[];
}

export class CheckpointManager {
  private static readonly MAX_CHECKPOINTS = 10;
  private static readonly MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024; // 50MB total per checkpoint
  private static readonly MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB per file

  private checkpoints: Checkpoint[] = [];
  private store: CheckpointStore | null;
  private loadPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspaceRoot: string,
    storagePath?: string,
  ) {
    if (storagePath) {
      this.store = new CheckpointStore(storagePath);
      // Load checkpoints from disk on initialization
      this.loadPromise = this.loadFromDisk().catch((err) => {
        console.warn("Champ: failed to load checkpoints from disk:", err);
      });
    } else {
      this.store = null;
    }
  }

  /**
   * Wait for checkpoints to load from disk. Useful for testing and
   * scenarios where checkpoint state must be ready before proceeding.
   */
  async waitForLoad(): Promise<void> {
    await this.loadPromise;
  }

  /**
   * Load checkpoints from disk and populate the in-memory list.
   * This is called during initialization to restore session state.
   */
  private async loadFromDisk(): Promise<void> {
    if (!this.store) return;
    try {
      const loaded = await this.store.loadAll();
      // Sort by timestamp to maintain chronological order
      loaded.sort((a, b) => a.timestamp - b.timestamp);
      this.checkpoints = loaded;
    } catch (err) {
      console.warn("Champ: error loading checkpoints from disk:", err);
    }
  }

  /**
   * Create a checkpoint capturing the current state of the given files.
   * Files that don't exist yet are recorded as "not existed" so a
   * restore can delete them. Checkpoints are persisted to disk if a
   * storage path was configured.
   */
  async create(label: string, filePaths: string[]): Promise<Checkpoint> {
    const snapshots: FileSnapshot[] = [];
    let totalBytes = 0;

    for (const relPath of filePaths) {
      const resolved = resolveInWorkspace(this.workspaceRoot, relPath);
      if (!resolved) continue;

      const uri = vscode.Uri.file(resolved);
      try {
        const data = await vscode.workspace.fs.readFile(uri);
        const bytes = data.byteLength;
        if (bytes > CheckpointManager.MAX_FILE_BYTES) continue; // skip very large files
        if (totalBytes + bytes > CheckpointManager.MAX_SNAPSHOT_BYTES) break; // total cap
        totalBytes += bytes;
        snapshots.push({
          filePath: relPath,
          content:
            data instanceof Uint8Array
              ? data
              : new Uint8Array(data as ArrayBufferLike),
          existed: true,
        });
      } catch {
        // File does not exist at checkpoint time.
        snapshots.push({
          filePath: relPath,
          content: null,
          existed: false,
        });
      }
    }

    const checkpoint: Checkpoint = {
      id: this.generateId(),
      label,
      timestamp: Date.now(),
      snapshots,
    };

    // Prune oldest if we exceed the checkpoint count limit.
    while (this.checkpoints.length >= CheckpointManager.MAX_CHECKPOINTS) {
      const oldest = this.checkpoints.shift();
      if (oldest && this.store) {
        // Delete the oldest checkpoint from disk as well
        await this.store.delete(oldest.id).catch((err) => {
          console.warn(
            "Champ: failed to delete old checkpoint from disk:",
            err,
          );
        });
      }
    }

    this.checkpoints.push(checkpoint);

    // Persist to disk if storage is configured
    if (this.store) {
      await this.store.save(checkpoint).catch((err) => {
        console.warn("Champ: failed to save checkpoint to disk:", err);
      });
    }

    return checkpoint;
  }

  /**
   * Restore to the given checkpoint. All later checkpoints are
   * discarded; the requested checkpoint becomes the most recent one
   * (inclusive on index, but we drop it and everything after so the
   * restore "becomes" the new latest state).
   *
   * Deleted checkpoints are also removed from disk if storage is configured.
   */
  async restore(checkpointId: string): Promise<void> {
    const idx = this.checkpoints.findIndex((c) => c.id === checkpointId);
    if (idx === -1) {
      throw new Error(`Checkpoint ${checkpointId} not found`);
    }

    // Walk from newest checkpoint back to (and including) the target,
    // restoring file state from each snapshot.
    for (let i = this.checkpoints.length - 1; i >= idx; i--) {
      const cp = this.checkpoints[i];
      for (const snap of cp.snapshots) {
        const resolved = resolveInWorkspace(this.workspaceRoot, snap.filePath);
        if (!resolved) continue;
        const uri = vscode.Uri.file(resolved);

        if (snap.existed && snap.content) {
          try {
            await vscode.workspace.fs.writeFile(uri, snap.content);
          } catch (err) {
            console.warn(
              `Champ checkpoint: failed to restore "${snap.filePath}":`,
              err,
            );
          }
        } else {
          // File didn't exist at checkpoint time — delete it now.
          try {
            await vscode.workspace.fs.delete(uri);
          } catch (err) {
            console.warn(
              `Champ checkpoint: failed to delete "${snap.filePath}" during restore:`,
              err,
            );
          }
        }
      }
    }

    // Delete discarded checkpoints from disk
    const discarded = this.checkpoints.slice(idx + 1);
    for (const cp of discarded) {
      if (this.store) {
        await this.store.delete(cp.id).catch((err) => {
          console.warn(
            "Champ: failed to delete discarded checkpoint from disk:",
            err,
          );
        });
      }
    }

    // Drop the restored checkpoint and everything after it.
    this.checkpoints = this.checkpoints.slice(0, idx);
  }

  /** List all checkpoints in chronological order (oldest first). */
  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** Discard all checkpoints without restoring anything. Clears disk asynchronously in background. */
  clear(): void {
    const toDelete = [...this.checkpoints];
    this.checkpoints = [];

    // Delete checkpoints from disk asynchronously in the background
    if (this.store && toDelete.length > 0) {
      Promise.all(
        toDelete.map((cp) =>
          this.store!.delete(cp.id).catch((err) => {
            console.warn(
              "Champ: failed to delete checkpoint from disk during clear:",
              err,
            );
          }),
        ),
      ).catch((err) => {
        console.warn("Champ: error during checkpoint cleanup:", err);
      });
    }
  }

  private generateId(): string {
    return `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }
}
