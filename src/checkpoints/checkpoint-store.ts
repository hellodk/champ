/**
 * CheckpointStore: filesystem persistence for checkpoints.
 *
 * Each checkpoint is stored as a JSON file under the storage root
 * directory. Files are human-readable and can be tracked in version control.
 */
import * as fs from "fs";
import * as path from "path";
import type { Checkpoint } from "./checkpoint-manager";

export class CheckpointStore {
  constructor(private readonly storageRoot: string) {}

  /**
   * Persist a checkpoint to <storageRoot>/<id>.json.
   * Creates the storage directory if it doesn't exist.
   */
  async save(checkpoint: Checkpoint): Promise<void> {
    await fs.promises.mkdir(this.storageRoot, { recursive: true });
    const filePath = this.checkpointPath(checkpoint.id);

    // Convert Uint8Array to base64 strings for JSON serialization
    const serialized = {
      ...checkpoint,
      snapshots: checkpoint.snapshots.map(snap => ({
        filePath: snap.filePath,
        content: snap.content ? Buffer.from(snap.content).toString('base64') : null,
        existed: snap.existed,
      })),
    };

    const json = JSON.stringify(serialized, null, 2);
    // Write to temp file then rename for atomic writes.
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    await fs.promises.rename(tmpPath, filePath);
  }

  /**
   * Load all checkpoints from disk. Corrupted files are skipped with
   * a console warning rather than crashing.
   */
  async loadAll(): Promise<Checkpoint[]> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.storageRoot);
    } catch {
      return [];
    }

    const checkpoints: Checkpoint[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(this.storageRoot, entry);
      try {
        const data = await fs.promises.readFile(filePath, "utf-8");
        const parsed = JSON.parse(data) as any;
        if (parsed.id && parsed.label && Array.isArray(parsed.snapshots)) {
          // Convert base64 strings back to Uint8Array
          const checkpoint: Checkpoint = {
            id: parsed.id,
            label: parsed.label,
            timestamp: parsed.timestamp,
            snapshots: parsed.snapshots.map((snap: any) => ({
              filePath: snap.filePath,
              content: snap.content ? new Uint8Array(Buffer.from(snap.content, 'base64')) : null,
              existed: snap.existed,
            })),
          };
          checkpoints.push(checkpoint);
        }
      } catch (err) {
        console.warn(
          `Champ: skipping corrupted checkpoint file ${filePath}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return checkpoints;
  }

  /**
   * Delete a checkpoint file.
   */
  async delete(id: string): Promise<void> {
    const filePath = this.checkpointPath(id);
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // File may already be deleted.
    }
  }

  private checkpointPath(id: string): string {
    return path.join(this.storageRoot, `${id}.json`);
  }
}
