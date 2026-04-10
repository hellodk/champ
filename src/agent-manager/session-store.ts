/**
 * SessionStore: filesystem persistence for agent sessions.
 *
 * Each session is stored as a JSON file under the storage root
 * directory (typically <workspace>/.aidev/sessions/). Files are
 * human-readable and git-trackable.
 */
import * as fs from "fs";
import * as path from "path";
import type { SerializedSession } from "./types";

export class SessionStore {
  constructor(private readonly storageRoot: string) {}

  /**
   * Persist a session to <storageRoot>/<id>.json.
   * Creates the storage directory if it doesn't exist.
   */
  async save(session: SerializedSession): Promise<void> {
    await fs.promises.mkdir(this.storageRoot, { recursive: true });
    const filePath = this.sessionPath(session.metadata.id);
    const json = JSON.stringify(session, null, 2);
    // Write to temp file then rename for atomic writes.
    const tmpPath = `${filePath}.tmp`;
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    await fs.promises.rename(tmpPath, filePath);
  }

  /**
   * Load all sessions from disk. Corrupted files are skipped with
   * a console warning rather than crashing.
   */
  async loadAll(): Promise<SerializedSession[]> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(this.storageRoot);
    } catch {
      return [];
    }

    const sessions: SerializedSession[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(this.storageRoot, entry);
      try {
        const data = await fs.promises.readFile(filePath, "utf-8");
        const parsed = JSON.parse(data) as SerializedSession;
        if (parsed.metadata?.id && Array.isArray(parsed.history)) {
          sessions.push(parsed);
        }
      } catch (err) {
        console.warn(
          `AIDev: skipping corrupted session file ${filePath}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return sessions;
  }

  /**
   * Delete a session file.
   */
  async delete(id: string): Promise<void> {
    const filePath = this.sessionPath(id);
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // File may already be deleted.
    }
  }

  /**
   * Prune sessions older than `days` days based on lastActivityAt.
   * Returns the number of pruned sessions.
   */
  async pruneOlderThan(days: number): Promise<number> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const sessions = await this.loadAll();
    let pruned = 0;
    for (const session of sessions) {
      if (session.metadata.lastActivityAt < cutoff) {
        await this.delete(session.metadata.id);
        pruned++;
      }
    }
    return pruned;
  }

  private sessionPath(id: string): string {
    return path.join(this.storageRoot, `${id}.json`);
  }
}
