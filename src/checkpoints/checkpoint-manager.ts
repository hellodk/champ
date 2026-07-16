/**
 * CheckpointManager: persistent shadow-copy snapshot and restore.
 *
 * Before any destructive agent action (file edit, create, delete,
 * terminal command), the agent layer creates a checkpoint by capturing
 * the current contents of affected files. If the user later clicks
 * "Restore" on a prior message in the chat, we walk back from the
 * current checkpoint to the requested one, restoring file state as we go.
 *
 * Checkpoints are persisted to disk (.champ/checkpoints/) and automatically
 * restored on extension startup, enabling session history across restarts.
 *
 * Shadow-copy is preferred over `git stash` because:
 *   - Works in non-git repositories.
 *   - Doesn't clutter the user's stash stack.
 *   - Captures both modifications AND creations (deleting files that
 *     were created after the checkpoint).
 */
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
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

export interface SessionHistoryEntry {
  id: string;
  label: string;
  timestamp: number;
  snapshotCount: number;
  formattedTime: string;
}

export interface CheckpointMetadata {
  id: string;
  label: string;
  timestamp: number;
  fileCount: number;
  totalBytes: number;
}

export class CheckpointManager {
  private static readonly MAX_CHECKPOINTS = 10;
  private static readonly MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024; // 50MB total per checkpoint
  private static readonly MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB per file
  private static readonly MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  private static readonly CHECKPOINT_DIR = ".champ/checkpoints";

  private checkpoints: Checkpoint[] = [];
  private readonly storageDir: string;

  constructor(private readonly workspaceRoot: string) {
    this.storageDir = path.join(
      workspaceRoot,
      CheckpointManager.CHECKPOINT_DIR,
    );
  }

  /**
   * Initialize by loading checkpoints from disk.
   * This should be called during extension activation.
   */
  async initialize(): Promise<void> {
    await this.loadFromDisk();
    await this.enforceRetentionPolicy();
  }

  /**
   * Create a checkpoint capturing the current state of the given files.
   * Files that don't exist yet are recorded as "not existed" so a
   * restore can delete them. Checkpoint is persisted to disk.
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

    // Add to in-memory list
    this.checkpoints.push(checkpoint);

    // Persist to disk
    await this.persistCheckpoint(checkpoint);

    // Enforce retention
    await this.enforceRetentionPolicy();

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

    // Delete discarded checkpoints from disk
    for (let i = idx; i < this.checkpoints.length; i++) {
      const cp = this.checkpoints[i];
      await this.deleteCheckpointFromDisk(cp.id);
    }

    // Drop the restored checkpoint and everything after it.
    this.checkpoints = this.checkpoints.slice(0, idx);

    // Persist the pruned list
    await this.persistCheckpointList();
  }

  /** List all checkpoints in chronological order (oldest first). */
  list(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** Discard all checkpoints without restoring anything. */
  async clear(): Promise<void> {
    this.checkpoints = [];
    await this.clearDisk();
  }

  /**
   * Get session history with formatted timestamps and summaries.
   */
  getSessionHistory(): SessionHistoryEntry[] {
    return this.checkpoints.map((cp) => ({
      id: cp.id,
      label: cp.label,
      timestamp: cp.timestamp,
      snapshotCount: cp.snapshots.length,
      formattedTime: this.formatTime(cp.timestamp),
    }));
  }

  /**
   * Get metadata for a specific checkpoint.
   */
  getCheckpointMetadata(checkpointId: string): CheckpointMetadata | undefined {
    const cp = this.checkpoints.find((c) => c.id === checkpointId);
    if (!cp) return undefined;

    let totalBytes = 0;
    for (const snap of cp.snapshots) {
      if (snap.content) {
        totalBytes += snap.content.byteLength;
      }
    }

    return {
      id: cp.id,
      label: cp.label,
      timestamp: cp.timestamp,
      fileCount: cp.snapshots.length,
      totalBytes,
    };
  }

  /**
   * Enforce retention policy: remove old checkpoints.
   */
  async enforceRetentionPolicy(): Promise<void> {
    const now = Date.now();
    const maxAge = CheckpointManager.MAX_AGE_MS;

    // Remove by age
    const beforeCount = this.checkpoints.length;
    this.checkpoints = this.checkpoints.filter((cp) => {
      return now - cp.timestamp < maxAge;
    });

    // Remove excess (keep only latest MAX_CHECKPOINTS)
    while (this.checkpoints.length > CheckpointManager.MAX_CHECKPOINTS) {
      const removed = this.checkpoints.shift();
      if (removed) {
        // Delete from disk
        this.deleteCheckpointFromDisk(removed.id).catch((err) => {
          console.warn(`Failed to delete checkpoint ${removed.id}:`, err);
        });
      }
    }

    // Persist if anything changed
    if (this.checkpoints.length !== beforeCount) {
      await this.persistCheckpointList();
    }

    // Clean up orphaned directories
    await this.cleanupOrphanedDirectories();
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private async loadFromDisk(): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });

      const entries = await fs.readdir(this.storageDir);
      const checkpoints: Checkpoint[] = [];

      for (const entry of entries) {
        if (entry === ".DS_Store") continue; // Skip macOS metadata

        const checkpointDir = path.join(this.storageDir, entry);
        const stat = await fs.stat(checkpointDir);

        if (!stat.isDirectory()) continue;

        try {
          const checkpoint = await this.loadCheckpointFromDirectory(
            checkpointDir,
          );
          if (checkpoint) {
            checkpoints.push(checkpoint);
          }
        } catch (error) {
          console.warn(`Failed to load checkpoint from ${checkpointDir}:`, error);
        }
      }

      // Sort by timestamp
      checkpoints.sort((a, b) => a.timestamp - b.timestamp);
      this.checkpoints = checkpoints;
    } catch (error) {
      console.warn("Failed to load checkpoints from disk:", error);
      this.checkpoints = [];
    }
  }

  private async loadCheckpointFromDirectory(
    checkpointDir: string,
  ): Promise<Checkpoint | null> {
    try {
      const metadataPath = path.join(checkpointDir, "metadata.json");
      const metadataContent = await fs.readFile(metadataPath, "utf-8");
      const metadata = JSON.parse(metadataContent);

      // Load snapshot content from binary files
      const snapshots: FileSnapshot[] = [];
      for (let i = 0; i < metadata.snapshots.length; i++) {
        const snap = metadata.snapshots[i];
        let content: Uint8Array | null = null;

        if (snap.hasContent) {
          const snapshotPath = path.join(checkpointDir, `snapshot-${i}.bin`);
          try {
            content = await fs.readFile(snapshotPath);
          } catch (error) {
            console.warn(
              `Failed to load snapshot file ${snapshotPath}:`,
              error,
            );
            content = null;
          }
        }

        snapshots.push({
          filePath: snap.filePath,
          content,
          existed: snap.existed,
        });
      }

      return {
        id: metadata.id,
        label: metadata.label,
        timestamp: metadata.timestamp,
        snapshots,
      };
    } catch (error) {
      console.warn(`Failed to parse checkpoint metadata:`, error);
      return null;
    }
  }

  private async persistCheckpoint(checkpoint: Checkpoint): Promise<void> {
    try {
      const checkpointDir = path.join(this.storageDir, checkpoint.id);
      await fs.mkdir(checkpointDir, { recursive: true });

      // Write metadata (without binary content to keep it readable)
      const metadata = {
        id: checkpoint.id,
        label: checkpoint.label,
        timestamp: checkpoint.timestamp,
        snapshots: checkpoint.snapshots.map((snap) => ({
          filePath: snap.filePath,
          existed: snap.existed,
          hasContent: snap.content !== null,
          contentSize: snap.content?.byteLength || 0,
        })),
      };

      const metadataPath = path.join(checkpointDir, "metadata.json");
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf-8");

      // Write snapshot files
      for (let i = 0; i < checkpoint.snapshots.length; i++) {
        const snap = checkpoint.snapshots[i];
        if (snap.content) {
          const snapshotPath = path.join(checkpointDir, `snapshot-${i}.bin`);
          await fs.writeFile(snapshotPath, snap.content);
        }
      }
    } catch (error) {
      console.warn(`Failed to persist checkpoint ${checkpoint.id}:`, error);
    }
  }

  private async persistCheckpointList(): Promise<void> {
    // The list is maintained by individual checkpoint files
    // This method ensures all are synchronized
    try {
      for (const cp of this.checkpoints) {
        const checkpointDir = path.join(this.storageDir, cp.id);
        const metadataPath = path.join(checkpointDir, "metadata.json");

        const exists = await fs
          .access(metadataPath)
          .then(() => true)
          .catch(() => false);

        if (!exists) {
          await this.persistCheckpoint(cp);
        }
      }
    } catch (error) {
      console.warn("Failed to persist checkpoint list:", error);
    }
  }

  private async deleteCheckpointFromDisk(checkpointId: string): Promise<void> {
    try {
      const checkpointDir = path.join(this.storageDir, checkpointId);
      await fs.rm(checkpointDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Failed to delete checkpoint directory ${checkpointId}:`, error);
    }
  }

  private async clearDisk(): Promise<void> {
    try {
      await fs.rm(this.storageDir, { recursive: true, force: true });
    } catch (error) {
      console.warn("Failed to clear checkpoint storage:", error);
    }
  }

  private async cleanupOrphanedDirectories(): Promise<void> {
    try {
      const entries = await fs.readdir(this.storageDir);
      const trackedIds = new Set(this.checkpoints.map((c) => c.id));

      for (const entry of entries) {
        if (entry === ".DS_Store") continue;
        if (!trackedIds.has(entry)) {
          // This is an orphaned directory
          const orphanPath = path.join(this.storageDir, entry);
          try {
            await fs.rm(orphanPath, { recursive: true, force: true });
          } catch (error) {
            console.warn(`Failed to cleanup orphaned checkpoint ${entry}:`, error);
          }
        }
      }
    } catch (error) {
      console.warn("Failed to cleanup orphaned directories:", error);
    }
  }

  private generateId(): string {
    return `cp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
  }

  private formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  }
}
