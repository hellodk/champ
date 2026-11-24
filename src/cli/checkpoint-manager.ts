/**
 * Headless checkpoint manager for the CLI.
 *
 * Mirrors the extension's CheckpointManager contract without importing
 * `vscode`, so the standalone CLI bundle stays vscode-free. Persistence is
 * delegated to the existing CheckpointStore.
 */
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { CheckpointStore } from "../checkpoints/checkpoint-store";
import { resolveInWorkspace } from "../utils/workspace-path";

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

const MAX_CHECKPOINTS = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

export class CliCheckpointManager {
  private readonly store: CheckpointStore;
  private checkpoints: Checkpoint[] = [];
  private loaded: Promise<void>;

  constructor(
    private readonly workspaceRoot: string,
    storageRoot: string,
  ) {
    this.store = new CheckpointStore(storageRoot);
    this.loaded = this.loadFromDisk();
  }

  private async loadFromDisk(): Promise<void> {
    const loaded = await this.store.loadAll();
    loaded.sort((a, b) => a.timestamp - b.timestamp);
    this.checkpoints = loaded.slice(-MAX_CHECKPOINTS);
  }

  async create(label: string, filePaths: string[]): Promise<Checkpoint> {
    await this.loaded;
    const snapshots: FileSnapshot[] = [];
    let totalBytes = 0;
    for (const relPath of [...new Set(filePaths)]) {
      const resolved = resolveInWorkspace(this.workspaceRoot, relPath);
      if (!resolved) continue;
      try {
        const stat = await fs.stat(resolved);
        if (stat.size > MAX_FILE_BYTES) continue;
        if (totalBytes + stat.size > MAX_SNAPSHOT_BYTES) break;
        const content = await fs.readFile(resolved);
        totalBytes += content.byteLength;
        snapshots.push({ filePath: relPath, content, existed: true });
      } catch {
        snapshots.push({ filePath: relPath, content: null, existed: false });
      }
    }

    const checkpoint: Checkpoint = {
      id: crypto.randomUUID(),
      label,
      timestamp: Date.now(),
      snapshots,
    };
    while (this.checkpoints.length >= MAX_CHECKPOINTS) {
      const oldest = this.checkpoints.shift();
      if (oldest) await this.store.delete(oldest.id);
    }
    this.checkpoints.push(checkpoint);
    await this.store.save(checkpoint);
    return checkpoint;
  }

  async restore(checkpointId: string): Promise<void> {
    await this.loaded;
    const idx = this.checkpoints.findIndex((c) => c.id === checkpointId);
    if (idx === -1) throw new Error(`Checkpoint ${checkpointId} not found`);

    for (let i = this.checkpoints.length - 1; i >= idx; i--) {
      for (const snap of this.checkpoints[i].snapshots) {
        const resolved = resolveInWorkspace(this.workspaceRoot, snap.filePath);
        if (!resolved) continue;
        if (snap.existed && snap.content) {
          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, snap.content);
        } else {
          await fs.rm(resolved, { force: true });
        }
      }
    }
    for (const cp of this.checkpoints.slice(idx)) {
      await this.store.delete(cp.id);
    }
    this.checkpoints = this.checkpoints.slice(0, idx);
  }

  list(): Checkpoint[] {
    return [...this.checkpoints];
  }
}
