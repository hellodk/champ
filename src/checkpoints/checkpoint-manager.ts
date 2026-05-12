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
 */
import * as vscode from "vscode";
import { resolveInWorkspace } from "../utils/workspace-path";

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

  constructor(private readonly workspaceRoot: string) {}

  /**
   * Create a checkpoint capturing the current state of the given files.
   * Files that don't exist yet are recorded as "not existed" so a
   * restore can delete them.
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
      this.checkpoints.shift();
    }

    this.checkpoints.push(checkpoint);
    return checkpoint;
  }

  /**
   * Restore to the given checkpoint. All later checkpoints are
   * discarded; the requested checkpoint becomes the most recent one
   * (inclusive on index, but we drop it and everything after so the
   * restore "becomes" the new latest state).
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

    // Drop the restored checkpoint and everything after it.
    this.checkpoints = this.checkpoints.slice(0, idx);
  }

  /** List all checkpoints in chronological order (oldest first). */
  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** Discard all checkpoints without restoring anything. */
  clear(): void {
    this.checkpoints = [];
  }

  private generateId(): string {
    return `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }
}
