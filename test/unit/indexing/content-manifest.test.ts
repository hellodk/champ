/**
 * Content-hash index freshness: mtime must never be the source of truth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { IndexingService } from "@/indexing/indexing-service";
import {
  checkManifestFreshness,
  ignoreFingerprint,
  manifestPathFor,
  readIndexManifest,
  sha256,
} from "@/indexing/index-manifest";

const MODEL_ID = "content-hash-model";

function makeService(ws: string, cache: string): IndexingService {
  return new IndexingService(
    ws,
    {
      select: vi.fn().mockReturnValue({
        model: { id: MODEL_ID, providerType: "ollama" },
        provider: { config: { baseUrl: "http://127.0.0.1:1" } },
      }),
    } as never,
    {} as never,
    cache,
  );
}

async function writeSource(ws: string, text: string): Promise<string> {
  const file = path.join(ws, "alpha.ts");
  await fs.writeFile(file, text, "utf8");
  return file;
}

describe("content-addressed index manifest", () => {
  let ws: string;
  let cache: string;
  let fetchCalls: number;
  let previousHome: string | undefined;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(os.tmpdir(), "champ-hash-ws-"));
    cache = await fs.mkdtemp(path.join(os.tmpdir(), "champ-hash-cache-"));
    previousHome = process.env.CHAMP_HOME;
    process.env.CHAMP_HOME = cache;
    fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls++;
        return {
          ok: true,
          json: async () => ({ embedding: [0.25, 0.5] }),
        } as unknown as Response;
      }),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (previousHome === undefined) delete process.env.CHAMP_HOME;
    else process.env.CHAMP_HOME = previousHome;
    await fs.rm(ws, { recursive: true, force: true });
    await fs.rm(cache, { recursive: true, force: true });
  });

  it("stores model, ignore fingerprint and per-file SHA256", async () => {
    const text = "export function alpha() { return 1; }\n";
    await writeSource(ws, text);
    const svc = makeService(ws, cache);
    try {
      expect(await svc.initialize()).not.toBeNull();
      const hash = crypto
        .createHash("sha1")
        .update(ws)
        .digest("hex")
        .slice(0, 12);
      const manifest = await readIndexManifest(path.join(cache, `${hash}.idx`));
      expect(manifest).not.toBeNull();
      expect(manifest!.embeddingModelId).toBe(MODEL_ID);
      expect(manifest!.files["alpha.ts"].sha256).toBe(sha256(text));
      expect(manifest!.files["alpha.ts"].size).toBe(Buffer.byteLength(text));
      expect(manifest!.files["alpha.ts"].chunks).toBeGreaterThan(0);
    } finally {
      svc.dispose();
    }
  });

  it("reuses the index after a touch, even when the cache file is old", async () => {
    await writeSource(ws, "export function alpha() { return 1; }\n");
    const first = makeService(ws, cache);
    let indexPath = "";
    try {
      await first.initialize();
      indexPath = (await first.indexStatus()).indexPath;
    } finally {
      first.dispose();
    }

    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await fs.utimes(indexPath, old, old);
    fetchCalls = 0;

    const second = makeService(ws, cache);
    try {
      const status = await second.indexStatus();
      expect(status.fresh).toBe(true);
      expect(await second.initialize()).not.toBeNull();
      expect(fetchCalls).toBe(0);
    } finally {
      second.dispose();
    }
  });

  it("rebuilds when content changes without a size or mtime change", async () => {
    const v1 = "export function alpha() { return 1; }\n";
    const file = await writeSource(ws, v1);
    const first = makeService(ws, cache);
    try {
      await first.initialize();
    } finally {
      first.dispose();
    }
    const before = await fs.stat(file);

    // Same length, same timestamps — only the content hash differs.
    const v2 = "export function alpha() { return 2; }\n";
    expect(v2.length).toBe(v1.length);
    await fs.writeFile(file, v2, "utf8");
    await fs.utimes(file, before.atime, before.mtime);
    fetchCalls = 0;

    const second = makeService(ws, cache);
    try {
      const status = await second.indexStatus();
      expect(status.fresh).toBe(false);
      expect(status.reason).toContain("alpha.ts");
      const stats = await second.initialize();
      expect(stats?.filesIndexed).toBe(1);
      expect(fetchCalls).toBeGreaterThan(0);
      const manifest = await readIndexManifest(status.indexPath);
      expect(manifest!.files["alpha.ts"].sha256).toBe(sha256(v2));
    } finally {
      second.dispose();
    }
  });

  it("clear removes both the vector cache and the manifest", async () => {
    await writeSource(ws, "export function alpha() { return 1; }\n");
    const svc = makeService(ws, cache);
    try {
      await svc.initialize();
      const indexPath = (await svc.indexStatus()).indexPath;
      await expect(fs.access(indexPath)).resolves.toBeUndefined();
      await expect(
        fs.access(manifestPathFor(indexPath)),
      ).resolves.toBeUndefined();
      await svc.invalidateIndex();
      await expect(fs.access(indexPath)).rejects.toThrow();
      await expect(fs.access(manifestPathFor(indexPath))).rejects.toThrow();
    } finally {
      svc.dispose();
    }
  });

  it("reports precise invalidation reasons", () => {
    const manifest = {
      version: 2 as const,
      embeddingModelId: MODEL_ID,
      ignoreFingerprint: ignoreFingerprint(["dist/**"]),
      chunkCount: 1,
      files: { "a.ts": { sha256: "abc", size: 3, chunks: 1 } },
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      checkManifestFreshness(manifest, {
        modelId: "other",
        ignoreFingerprint: manifest.ignoreFingerprint,
        files: new Map([["a.ts", { sha256: "abc", size: 3 }]]),
      }).reason,
    ).toContain("embedding model changed");
    expect(
      checkManifestFreshness(manifest, {
        modelId: MODEL_ID,
        ignoreFingerprint: ignoreFingerprint(["out/**"]),
        files: new Map([["a.ts", { sha256: "abc", size: 3 }]]),
      }).reason,
    ).toBe("index ignore patterns changed");
    expect(
      checkManifestFreshness(manifest, {
        modelId: MODEL_ID,
        ignoreFingerprint: manifest.ignoreFingerprint,
        files: new Map(),
      }).reason,
    ).toBe("set of indexable files changed");
  });
});
