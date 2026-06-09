/**
 * TeamRunStore: persists team run state to disk.
 *
 * Mirrors WorkflowStore: stores runs as JSON files in
 * .champ/team-runs/<runId>.json, auto-prunes to MAX_RUNS.
 */
import * as fs from "fs/promises";
import * as path from "path";
import type { TeamRunState } from "../agent/team-definition";

const MAX_RUNS = 50;

export interface TeamRunRecord {
  state: TeamRunState;
  savedAt: number;
}

export class TeamRunStore {
  private readonly dir: string;

  constructor(workspaceRoot: string) {
    this.dir = path.join(workspaceRoot, ".champ", "team-runs");
  }

  async save(state: TeamRunState): Promise<boolean> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const record: TeamRunRecord = { state, savedAt: Date.now() };
      await fs.writeFile(
        path.join(this.dir, `${state.runId}.json`),
        JSON.stringify(record, null, 2),
        "utf-8",
      );
      await this.pruneIfNeeded();
      return true;
    } catch (error) {
      console.warn(
        `Champ TeamRunStore: failed to save run ${state.runId}:`,
        error,
      );
      return false;
    }
  }

  async loadAll(): Promise<TeamRunRecord[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const records: TeamRunRecord[] = [];
    for (const file of entries) {
      if (!file.endsWith(".json")) continue;
      const filePath = path.join(this.dir, file);
      if (!path.resolve(filePath).startsWith(path.resolve(this.dir) + path.sep))
        continue;
      try {
        const content = await fs.readFile(filePath, "utf-8");
        records.push(JSON.parse(content) as TeamRunRecord);
      } catch {
        console.warn(`Champ TeamRunStore: skipping corrupt file ${file}`);
      }
    }
    return records.sort((a, b) => b.savedAt - a.savedAt);
  }

  async load(runId: string): Promise<TeamRunRecord | null> {
    try {
      const filePath = path.join(this.dir, `${runId}.json`);
      if (!path.resolve(filePath).startsWith(path.resolve(this.dir) + path.sep))
        return null;
      const content = await fs.readFile(filePath, "utf-8");
      return JSON.parse(content) as TeamRunRecord;
    } catch {
      return null;
    }
  }

  private async pruneIfNeeded(): Promise<void> {
    try {
      const files = (await fs.readdir(this.dir)).filter((f) =>
        f.endsWith(".json"),
      );
      if (files.length <= MAX_RUNS) return;
      const records: Array<{ savedAt: number; file: string }> = [];
      for (const file of files) {
        try {
          const content = await fs.readFile(path.join(this.dir, file), "utf-8");
          const rec = JSON.parse(content) as TeamRunRecord;
          records.push({ savedAt: rec.savedAt, file });
        } catch {
          await fs.unlink(path.join(this.dir, file)).catch(() => {});
        }
      }
      records.sort((a, b) => a.savedAt - b.savedAt);
      for (let i = 0; i < records.length - MAX_RUNS; i++) {
        const runId = records[i].file.slice(0, -5); // strip .json
        await fs.unlink(path.join(this.dir, records[i].file)).catch(() => {});
        // Also delete checkpoint subdirectory if it exists
        await fs
          .rm(path.join(this.dir, runId), { recursive: true, force: true })
          .catch(() => {});
      }
    } catch {
      // Pruning failure is non-fatal
    }
  }
}
