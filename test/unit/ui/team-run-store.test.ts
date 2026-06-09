import { describe, it, expect, vi, beforeEach } from "vitest";
import { TeamRunStore, type TeamRunRecord } from "@/ui/team-run-store";
import * as fs from "fs/promises";

vi.mock("fs/promises");

function makeRecord(runId: string, savedAt: number): TeamRunRecord {
  return {
    state: {
      runId,
      agents: [],
      memory: {},
      status: "completed" as const,
      totalTokens: 100,
      message: "",
    },
    savedAt,
  };
}

describe("TeamRunStore", () => {
  let store: TeamRunStore;

  beforeEach(() => {
    store = new TeamRunStore("/workspace");
    vi.resetAllMocks();
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.readdir).mockResolvedValue([] as any);
    vi.mocked(fs.readFile).mockResolvedValue("{}" as any);
    vi.mocked(fs.unlink).mockResolvedValue(undefined);
    vi.mocked(fs.rm).mockResolvedValue(undefined);
  });

  it("saves a team run to disk as JSON", async () => {
    const record = makeRecord("r1", Date.now());
    await store.save(record.state);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("r1.json"),
      expect.stringContaining('"runId": "r1"'),
      "utf-8",
    );
  });

  it("loads all runs from disk sorted by savedAt desc", async () => {
    const older = makeRecord("old", 1000);
    const newer = makeRecord("new", 2000);
    vi.mocked(fs.readdir).mockResolvedValue(["old.json", "new.json"] as any);
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce(JSON.stringify(older) as any)
      .mockResolvedValueOnce(JSON.stringify(newer) as any);
    const runs = await store.loadAll();
    expect(runs[0].state.runId).toBe("new");
    expect(runs[1].state.runId).toBe("old");
  });

  it("prunes checkpoint subdirectories when evicting old runs", async () => {
    // Simulate 52 run files (over MAX_RUNS=50)
    const files = Array.from({ length: 52 }, (_, i) => `run${i}.json`);
    vi.mocked(fs.readdir).mockResolvedValue(files as any);
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify(makeRecord("x", 1000)) as any,
    );

    await store.save(makeRecord("current", Date.now()).state);

    // The oldest 2 runs should be deleted along with their checkpoint subdirs.
    // Check that fs.unlink was called for run0.json and run1.json
    // and fs.rm was called for run0/ and run1/ checkpoint directories.
    expect(fs.unlink).toHaveBeenCalled();
    expect(fs.rm).toHaveBeenCalled();

    // Verify fs.rm was called with recursive: true, force: true
    const rmCalls = vi.mocked(fs.rm).mock.calls;
    expect(rmCalls.length).toBeGreaterThan(0);
    rmCalls.forEach((call) => {
      const [, options] = call;
      expect(options).toEqual({ recursive: true, force: true });
    });
  });

  it("silently handles missing checkpoint subdirectories during pruning", async () => {
    const files = Array.from({ length: 52 }, (_, i) => `run${i}.json`);
    vi.mocked(fs.readdir).mockResolvedValue(files as any);
    vi.mocked(fs.readFile).mockResolvedValue(
      JSON.stringify(makeRecord("x", 1000)) as any,
    );
    // fs.rm fails for non-existent directories
    vi.mocked(fs.rm).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );

    // Should not throw — error is caught and ignored
    await expect(
      store.save(makeRecord("current", Date.now()).state),
    ).resolves.toBe(true);
  });

  it("silently returns [] when directory does not exist", async () => {
    vi.mocked(fs.readdir).mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    const runs = await store.loadAll();
    expect(runs).toEqual([]);
  });
});
