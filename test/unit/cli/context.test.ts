import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import {
  collectRepoMapFiles,
  createCliContext,
  createCliRepoMapProvider,
} from "@/cli/context";
import { RepoMapBuilder } from "@/indexing/repo-map-builder";
import { ChunkingService } from "@/indexing/chunking-service";

describe("CLI repository context", () => {
  let ws: string;

  beforeEach(async () => {
    ws = await fsp.mkdtemp(path.join(os.tmpdir(), "champ-cli-context-"));
  });

  afterEach(async () => {
    await fsp.rm(ws, { recursive: true, force: true });
  });

  it("collects only indexable files and skips ignored directories", async () => {
    const write = async (rel: string, body: string) => {
      const full = path.join(ws, rel);
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, body, "utf8");
    };
    await write("src/alpha.ts", "export function alpha() {}\n");
    await write("src/notes.md", "# notes\n");
    await write("node_modules/dep.ts", "export function dep() {}\n");
    await write(".git/config.ts", "export function git() {}\n");

    const files = await collectRepoMapFiles(ws);
    const rels = files.map((f) => f.path.split(path.sep).join("/"));
    expect(rels).toContain("src/alpha.ts");
    expect(rels).toContain("src/notes.md");
    expect(rels).not.toContain("node_modules/dep.ts");
    expect(rels).not.toContain(".git/config.ts");
  });

  it("builds and memoises a repo map from the workspace", async () => {
    await fsp.writeFile(
      path.join(ws, "thing.ts"),
      "export function doThing() { return 1; }\n",
      "utf8",
    );
    const builder = new RepoMapBuilder(new ChunkingService());
    const provider = createCliRepoMapProvider(ws, builder);

    const first = await provider.getRepoMap();
    expect(first).toContain("thing.ts");
    expect(first).toContain("doThing");

    await fsp.writeFile(
      path.join(ws, "thing.ts"),
      "export function changed() { return 2; }\n",
      "utf8",
    );
    // Cached for the session: a second call must not re-read the workspace.
    expect(await provider.getRepoMap()).toBe(first);
  });

  it("attaches a workspace bank, a global bank and a repo map", () => {
    const context = createCliContext(ws);
    expect(context.memoryBank).toBeDefined();
    expect(context.globalMemoryBank).toBeDefined();
    expect(context.repoMapProvider).toBeDefined();
  });

  it("scopes the global memory bank to CHAMP_HOME", () => {
    const previous = process.env.CHAMP_HOME;
    process.env.CHAMP_HOME = ws;
    try {
      const bank = createCliContext(ws).globalMemoryBank;
      expect((bank as unknown as { filePath: string }).filePath).toBe(
        path.join(ws, ".champ", "memory.json"),
      );
    } finally {
      if (previous === undefined) delete process.env.CHAMP_HOME;
      else process.env.CHAMP_HOME = previous;
    }
  });
});
