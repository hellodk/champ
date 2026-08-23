/**
 * TDD (issue #107): persisted-index reuse and incremental freshness.
 *
 * Covers:
 *  - initialize() reuses a fresh on-disk index with ZERO embedding calls
 *  - stale / model-mismatched indexes fall back to a full rebuild
 *  - deleteByFile removes only the target file's chunks
 *  - reindexFile replaces old chunks for changed content (no duplicates)
 *  - incremental updates are debounced-persisted back to disk
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as crypto from "crypto";
import * as path from "path";

// Redirect os.homedir() to a temp dir so ~/.champ/index writes are isolated.
const homedirHolder = vi.hoisted(() => ({
  home: "/tmp/champ-persistence-home",
}));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => homedirHolder.home };
});

import { IndexingService } from "@/indexing/indexing-service";
import { VectorStore } from "@/indexing/vector-store";
import { EmbeddingService } from "@/indexing/embedding-service";

const MODEL_ID = "test-embed-model";
const SAVE_DEBOUNCE_MS = 500;

function indexCachePathFor(workspaceRoot: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(workspaceRoot)
    .digest("hex")
    .slice(0, 12);
  return path.join(homedirHolder.home, ".champ", "index", `${hash}.idx`);
}

/** Deterministic embedding derived from text content. */
function embedFor(text: string): Float32Array {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum += text.charCodeAt(i);
  return new Float32Array([(sum % 997) / 997]);
}

function makeSmartRouter() {
  return {
    select: vi.fn().mockReturnValue({
      model: { id: MODEL_ID, providerType: "ollama" },
      provider: { config: { baseUrl: "http://127.0.0.1:1" } },
    }),
  };
}

function makeService(
  workspaceRoot: string,
  config: Record<string, unknown> = {},
): IndexingService {
  return new IndexingService(
    workspaceRoot,
    makeSmartRouter() as never,
    config as never,
  );
}

function storeOf(svc: IndexingService): VectorStore {
  return (svc as unknown as Record<string, unknown>)[
    "vectorStore"
  ] as VectorStore;
}

async function seedIndex(
  workspaceRoot: string,
  files: Array<{ filePath: string; text: string }>,
  modelId: string = MODEL_ID,
): Promise<string> {
  const idxPath = indexCachePathFor(workspaceRoot);
  const store = new VectorStore(":memory:", modelId);
  for (const f of files) {
    store.upsert({
      filePath: f.filePath,
      chunkText: f.text,
      startLine: 1,
      endLine: 1,
      symbolName: "sym",
      chunkType: "function",
      embedding: embedFor(f.text),
    });
  }
  await store.save(idxPath);
  store.dispose();
  return idxPath;
}

/** Stub global fetch to answer ollama-style embedding requests. */
let fetchCalls: number;
beforeEach(() => {
  fetchCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      fetchCalls++;
      return {
        ok: true,
        json: async () => ({ embedding: [0.25, 0.5, 0.75] }),
      } as unknown as Response;
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("persisted index reuse (issue #107)", () => {
  let tmpHome: string;
  let wsRoot: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join("/tmp/opencode", "champ-home-"));
    homedirHolder.home = tmpHome;
    wsRoot = await fs.mkdtemp(path.join("/tmp/opencode", "champ-ws-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(wsRoot, { recursive: true, force: true });
  });

  it("initialize() loads a fresh persisted index with zero embedding provider calls and search works", async () => {
    const idxPath = await seedIndex(wsRoot, [
      {
        filePath: path.join(wsRoot, "alpha.ts"),
        text: "export function alpha() { return 1; }",
      },
    ]);

    const embedSpy = vi
      .spyOn(EmbeddingService.prototype, "embed")
      .mockImplementation(async (text: string) => embedFor(text));

    const svc = makeService(wsRoot);
    try {
      const stats = await svc.initialize();

      // Index came from disk — no provider traffic at all during init.
      expect(stats).not.toBeNull();
      expect(stats!.chunksIndexed).toBe(1);
      expect(embedSpy).not.toHaveBeenCalled();
      expect(fetchCalls).toBe(0);

      // Search still works against the loaded chunks.
      const queryText = "export function alpha() { return 1; }";
      const results = await svc.search(queryText, 10, 0);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].filePath).toBe(path.join(wsRoot, "alpha.ts"));
      // Only the search-time query embedding hit the provider spy.
      expect(embedSpy).toHaveBeenCalledTimes(1);
      void idxPath;
    } finally {
      svc.dispose();
    }
  });

  it("falls back to full build when the persisted index is stale (>24h mtime)", async () => {
    const srcFile = path.join(wsRoot, "beta.ts");
    await fs.writeFile(srcFile, "export function beta() {\n  return 2;\n}\n");
    const idxPath = await seedIndex(wsRoot, [
      { filePath: srcFile, text: "stale content" },
    ]);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(idxPath, old, old);

    const svc = makeService(wsRoot);
    try {
      const stats = await svc.initialize();
      expect(stats).not.toBeNull();
      expect(stats!.filesIndexed).toBe(1);
      expect(stats!.chunksIndexed).toBe(1);
      // Full build required provider traffic (ping + chunk embeddings).
      expect(fetchCalls).toBeGreaterThan(0);
      // Fresh index was persisted for next session.
      const stat = await fs.stat(idxPath);
      expect(Date.now() - stat.mtimeMs).toBeLessThan(60_000);
    } finally {
      svc.dispose();
    }
  });

  it("falls back to full build when the persisted index was built by a different model", async () => {
    const srcFile = path.join(wsRoot, "gamma.ts");
    await fs.writeFile(srcFile, "export function gamma() {\n  return 3;\n}\n");
    await seedIndex(
      wsRoot,
      [{ filePath: srcFile, text: "other model content" }],
      "some-other-model",
    );

    const svc = makeService(wsRoot);
    try {
      const stats = await svc.initialize();
      expect(stats).not.toBeNull();
      expect(stats!.filesIndexed).toBe(1);
      expect(fetchCalls).toBeGreaterThan(0);
      expect(svc.getEmbeddingModel()).toBe(MODEL_ID);
    } finally {
      svc.dispose();
    }
  });
});

describe("incremental freshness (issue #107)", () => {
  let tmpHome: string;
  let wsRoot: string;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join("/tmp/opencode", "champ-home-"));
    homedirHolder.home = tmpHome;
    wsRoot = await fs.mkdtemp(path.join("/tmp/opencode", "champ-ws-"));
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
    await fs.rm(wsRoot, { recursive: true, force: true });
  });

  function injectEmbedder(svc: IndexingService): void {
    const inner = svc as unknown as Record<string, unknown>;
    inner["embeddingService"] = {
      embed: vi.fn(async (text: string) => embedFor(text)),
      loadCache: vi.fn().mockResolvedValue(undefined),
      saveCache: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("deleteByFile removes only that file's chunks", async () => {
    const fileA = path.join(wsRoot, "a.ts");
    const fileB = path.join(wsRoot, "b.ts");
    await fs.writeFile(fileA, "export function aOne() {\n  return 1;\n}\n");
    await fs.writeFile(fileB, "export function bOne() {\n  return 2;\n}\n");
    const svc = makeService(wsRoot);
    injectEmbedder(svc);
    try {
      await svc.reindexFile(fileA);
      await svc.reindexFile(fileB);
      const store = storeOf(svc);
      expect(store.size()).toBe(2);

      const removed = await svc.deleteByFile(fileA);
      expect(removed).toBe(1);
      expect(store.size()).toBe(1);

      const results = await store.search(new Float32Array([0]), 10);
      expect(results.some((r) => r.filePath === fileA)).toBe(false);
      expect(results.some((r) => r.filePath === fileB)).toBe(true);

      // Deleting an unknown file removes nothing.
      expect(await svc.deleteByFile(path.join(wsRoot, "nope.ts"))).toBe(0);
    } finally {
      svc.dispose();
    }
  });

  it("reindexFile replaces old chunks for changed content (no duplicates)", async () => {
    const file = path.join(wsRoot, "delta.ts");
    const v1 = "export function deltaV1() {\n  return 1;\n}\n";
    const v2 = "export function deltaV2() {\n  return 2;\n}\n";
    const svc = makeService(wsRoot);
    injectEmbedder(svc);
    try {
      await fs.writeFile(file, v1);
      await svc.reindexFile(file);
      const store = storeOf(svc);
      expect(store.size()).toBe(1);

      await fs.writeFile(file, v2);
      await svc.reindexFile(file);

      // Still exactly one chunk for the file — old version gone.
      expect(store.size()).toBe(1);
      const results = await store.search(embedFor(v2), 10);
      const forFile = results.filter((r) => r.filePath === file);
      expect(forFile).toHaveLength(1);
      expect(forFile[0].chunkText).toContain("deltaV2");
      expect(forFile[0].chunkText).not.toContain("deltaV1");
    } finally {
      svc.dispose();
    }
  });

  it("persists incremental updates after debounce so the next session loads them", async () => {
    const file = path.join(wsRoot, "eps.ts");
    await fs.writeFile(file, "export function eps() {\n  return 9;\n}\n");

    const first = makeService(wsRoot);
    injectEmbedder(first);
    try {
      await first.reindexFile(file);
      // Not persisted immediately — debounced.
      await expect(fs.access(indexCachePathFor(wsRoot))).rejects.toThrow();
      // Wait past the 500ms debounce window.
      await new Promise((r) => setTimeout(r, SAVE_DEBOUNCE_MS + 300));
      const stat = await fs.stat(indexCachePathFor(wsRoot));
      expect(stat.isFile()).toBe(true);
    } finally {
      first.dispose();
    }

    // Next session must warm-start from that file with zero embed calls.
    const embedSpy = vi
      .spyOn(EmbeddingService.prototype, "embed")
      .mockImplementation(async (text: string) => embedFor(text));
    const second = makeService(wsRoot);
    try {
      const stats = await second.initialize();
      expect(stats?.chunksIndexed).toBe(1);
      expect(embedSpy).not.toHaveBeenCalled();
      expect(fetchCalls).toBe(0);
    } finally {
      second.dispose();
    }
  });
});
