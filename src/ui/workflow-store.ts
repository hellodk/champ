import * as path from "path";
import * as fs from "fs/promises";

export type WorkflowStatus =
  | "running"
  | "awaiting-approval"
  | "completed"
  | "failed"
  | "stopped";
export type WorkflowMode = "auto" | "safe" | "audit";

export interface StepRecord {
  agentName: string;
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "skipped"
    | "awaiting-approval";
  startTime?: number;
  endTime?: number;
  output?: string;
  error?: string;
}

export interface FileChange {
  filePath: string;
  oldContent: string;
  newContent: string;
  status: "pending" | "accepted" | "rejected";
}

export interface WorkflowRun {
  id: string;
  name: string;
  status: WorkflowStatus;
  mode: WorkflowMode;
  startTime: number;
  endTime?: number;
  steps: StepRecord[];
  filesChanged: FileChange[];
}

const MAX_RUNS = 20;

export class WorkflowStore {
  private readonly dir: string;

  constructor(workspaceRoot: string) {
    this.dir = path.join(workspaceRoot, ".champ", "workflows");
  }

  async save(run: WorkflowRun): Promise<void> {
    try {
      await fs.mkdir(this.dir, { recursive: true });
      const filePath = path.join(this.dir, `${run.id}.json`);
      await fs.writeFile(filePath, JSON.stringify(run), "utf-8");
    } catch (error) {
      console.warn(`Failed to save workflow run ${run.id}:`, error);
    }
  }

  async loadAll(): Promise<WorkflowRun[]> {
    try {
      const files = await fs.readdir(this.dir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      const runs: WorkflowRun[] = [];
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.dir, file);
          const content = await fs.readFile(filePath, "utf-8");
          const run = JSON.parse(content) as WorkflowRun;
          runs.push(run);
        } catch (error) {
          console.warn(`Failed to parse workflow file ${file}:`, error);
        }
      }

      // Sort by startTime descending
      runs.sort((a, b) => b.startTime - a.startTime);
      return runs;
    } catch (error: any) {
      // Silently return empty array if directory doesn't exist
      if (error?.code === "ENOENT") {
        return [];
      }
      console.warn("Failed to load workflow runs:", error);
      return [];
    }
  }

  async pruneIfNeeded(): Promise<void> {
    try {
      const files = await fs.readdir(this.dir);
      const jsonFiles = files.filter((f) => f.endsWith(".json"));

      if (jsonFiles.length <= MAX_RUNS) {
        return;
      }

      // Load all runs to sort by startTime
      const runs: WorkflowRun[] = [];
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(this.dir, file);
          const content = await fs.readFile(filePath, "utf-8");
          const run = JSON.parse(content) as WorkflowRun;
          runs.push(run);
        } catch (error) {
          console.warn(`Failed to parse workflow file ${file}:`, error);
        }
      }

      // Sort by startTime ascending (oldest first)
      runs.sort((a, b) => a.startTime - b.startTime);

      // Delete oldest files
      const numToDelete = runs.length - MAX_RUNS;
      for (let i = 0; i < numToDelete; i++) {
        const filePath = path.join(this.dir, `${runs[i].id}.json`);
        try {
          await fs.unlink(filePath);
        } catch (error) {
          console.warn(
            `Failed to delete workflow file ${runs[i].id}.json:`,
            error,
          );
        }
      }
    } catch (error) {
      console.warn("Failed to prune workflow runs:", error);
    }
  }
}
