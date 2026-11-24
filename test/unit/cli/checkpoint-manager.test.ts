import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "child_process";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { CliCheckpointManager } from "@/cli/checkpoint-manager";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

describe("CLI checkpoints in a real git repository", () => {
  let ws: string;
  let store: string;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "champ-cp-ws-"));
    store = await fs.mkdtemp(path.join(os.tmpdir(), "champ-cp-store-"));
    git(ws, ["init", "-q"]);
    git(ws, ["config", "user.email", "test@example.com"]);
    git(ws, ["config", "user.name", "Test"]);
    await fs.writeFile(path.join(ws, "a.ts"), "original\n");
    git(ws, ["add", "a.ts"]);
    git(ws, ["commit", "-qm", "initial"]);
  });

  afterEach(async () => {
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(store, { recursive: true, force: true });
  });

  it("snapshots a file before mutation and restores it afterwards", async () => {
    const manager = new CliCheckpointManager(ws, store);
    const cp = await manager.create("before edit", ["a.ts"]);
    await fs.writeFile(path.join(ws, "a.ts"), "mutated\n");

    await manager.restore(cp.id);
    expect(await fs.readFile(path.join(ws, "a.ts"), "utf8")).toBe("original\n");
    expect(manager.list()).toHaveLength(0);
  });

  it("records a non-existent file as absent so restore deletes it", async () => {
    const manager = new CliCheckpointManager(ws, store);
    const cp = await manager.create("before create", ["new.ts"]);
    await fs.writeFile(path.join(ws, "new.ts"), "created\n");
    await manager.restore(cp.id);
    await expect(fs.stat(path.join(ws, "new.ts"))).rejects.toThrow();
  });

  it("refuses paths outside the workspace", async () => {
    const manager = new CliCheckpointManager(ws, store);
    const cp = await manager.create("traversal", ["../outside.ts"]);
    expect(cp.snapshots).toHaveLength(0);
  });
});
