/**
 * Repository context for the headless CLI: the same grounding the VS Code
 * extension attaches to its controllers, built from plain filesystem calls.
 *
 * The repo map is lazy — nothing is read until the first turn asks for it —
 * and both memory banks are loaded once before the agent starts. All paths
 * are relative to the CLI workspace or to `CHAMP_HOME`, never to a compiled-in
 * location.
 */
import * as fsp from "fs/promises";
import * as path from "path";
import type { RepoMapProvider } from "../agent/agent-controller";
import { ChunkingService } from "../indexing/chunking-service";
import { isIndexableTextFile } from "../indexing/indexing-service";
import { RepoMapBuilder } from "../indexing/repo-map-builder";
import { GlobalMemoryBank } from "../memory/global-memory-bank";
import { MemoryBank } from "../memory/memory-bank";

/** Hard caps keep an accidental huge workspace out of a model's prompt. */
const MAX_FILES = 200;
const MAX_BYTES_PER_FILE = 64 * 1024;

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  "test-reports",
  ".champ",
]);

/** Collect a bounded set of source files for the repo map. */
export async function collectRepoMapFiles(
  workspaceRoot: string,
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = [];

  const walk = async (dir: string): Promise<void> => {
    if (files.length >= MAX_FILES) return;
    let entries: import("fs").Dirent[];
    try {
      entries = (await fsp.readdir(dir, {
        withFileTypes: true,
      })) as import("fs").Dirent[];
    } catch {
      return;
    }
    // Stable ordering makes the prompt deterministic across machines.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile() || !isIndexableTextFile(full)) continue;
      try {
        const stat = await fsp.stat(full);
        if (stat.size > MAX_BYTES_PER_FILE) continue;
        const content = await fsp.readFile(full, "utf8");
        files.push({ path: path.relative(workspaceRoot, full), content });
      } catch {
        // Unreadable file — skip it rather than failing the turn.
      }
    }
  };

  await walk(workspaceRoot);
  return files;
}

/** Build a lazy repo-map provider identical in shape to the extension's. */
export function createCliRepoMapProvider(
  workspaceRoot: string,
  builder: RepoMapBuilder = new RepoMapBuilder(new ChunkingService()),
): RepoMapProvider {
  let cached: Promise<string> | undefined;
  return {
    getRepoMap() {
      cached ??= (async () => {
        try {
          return await builder.buildFromFiles(
            await collectRepoMapFiles(workspaceRoot),
          );
        } catch {
          return "";
        }
      })();
      return cached;
    },
  };
}

export interface CliContext {
  memoryBank: MemoryBank;
  globalMemoryBank: GlobalMemoryBank;
  repoMapProvider: RepoMapProvider;
}

/**
 * Construct (but do not yet read) the CLI's repository context. Loading the
 * banks is explicit so callers can decide when disk I/O happens.
 */
export function createCliContext(workspaceRoot: string): CliContext {
  return {
    memoryBank: new MemoryBank(workspaceRoot),
    globalMemoryBank: new GlobalMemoryBank(),
    repoMapProvider: createCliRepoMapProvider(workspaceRoot),
  };
}
