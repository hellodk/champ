import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowStore, type WorkflowRun } from "@/ui/workflow-store";
import * as fs from "fs/promises";

vi.mock("fs/promises");

function makeRun(
  id: string,
  status: WorkflowRun["status"] = "completed",
): WorkflowRun {
  return {
    id,
    name: `test run ${id}`,
    status,
    mode: "safe",
    startTime: Date.now(),
    endTime: Date.now() + 1000,
    steps: [],
    filesChanged: [],
  };
}

describe("WorkflowStore", () => {
  let store: WorkflowStore;

  beforeEach(() => {
    store = new WorkflowStore("/workspace");
    vi.resetAllMocks();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([] as any);
    vi.mocked(fs.readFile).mockResolvedValue("{}" as any);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
  });

  it("saves a run to disk as JSON", async () => {
    const run = makeRun("r1");
    await store.save(run);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("r1.json"),
      expect.stringContaining('"id": "r1"'),
      "utf-8",
    );
  });

  it("loads all runs from disk sorted by startTime desc", async () => {
    const older = makeRun("old");
    older.startTime = 1000;
    const newer = makeRun("new");
    newer.startTime = 2000;
    vi.mocked(fs.readdir).mockResolvedValue(["old.json", "new.json"] as any);
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(JSON.stringify(older) as any)
      .mockResolvedValueOnce(JSON.stringify(newer) as any);
    const runs = await store.loadAll();
    expect(runs[0].id).toBe("new");
    expect(runs[1].id).toBe("old");
  });

  it("prunes oldest files when over MAX_RUNS limit", async () => {
    const files = Array.from({ length: 22 }, (_, i) => `run${i}.json`);
    vi.mocked(fs.readdir).mockResolvedValue(files as any);
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify(makeRun("x", "completed")) as any,
    );
    await store.pruneIfNeeded();
    expect(fs.unlink).toHaveBeenCalledTimes(2);
  });

  it("silently returns [] when directory does not exist", async () => {
    vi.mocked(fs.readdir).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const runs = await store.loadAll();
    expect(runs).toEqual([]);
  });
});
