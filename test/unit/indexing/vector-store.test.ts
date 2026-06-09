/**
 * TDD: Tests for VectorStore.
 * sqlite-vec based vector storage and KNN search.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { VectorStore } from "@/indexing/vector-store";

describe("VectorStore", () => {
  let store: VectorStore;

  beforeEach(() => {
    // Use in-memory database for testing
    store = new VectorStore(":memory:");
  });

  afterEach(() => {
    store.dispose();
  });

  it("should insert and retrieve a chunk by similarity", async () => {
    const embedding = new Float32Array(384).fill(0.1);
    store.upsert({
      filePath: "src/main.ts",
      chunkText: 'function hello() { return "world"; }',
      startLine: 1,
      endLine: 1,
      symbolName: "hello",
      chunkType: "function",
      embedding,
    });

    const queryEmbedding = new Float32Array(384).fill(0.1); // same vector = high similarity
    const results = await store.search(queryEmbedding, 5);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filePath).toBe("src/main.ts");
    expect(results[0].chunkText).toContain("hello");
  });

  it("should return results ordered by similarity", async () => {
    // Insert two chunks with different embeddings
    const close = new Float32Array(384).fill(0.9);
    const far = new Float32Array(384).fill(0.1);

    store.upsert({
      filePath: "close.ts",
      chunkText: "close match",
      startLine: 1,
      endLine: 1,
      symbolName: "close",
      chunkType: "function",
      embedding: close,
    });
    store.upsert({
      filePath: "far.ts",
      chunkText: "far match",
      startLine: 1,
      endLine: 1,
      symbolName: "far",
      chunkType: "function",
      embedding: far,
    });

    const query = new Float32Array(384).fill(0.9); // closer to 'close'
    const results = await store.search(query, 2);

    expect(results[0].filePath).toBe("close.ts");
  });

  it("should delete chunks by file path", async () => {
    const embedding = new Float32Array(384).fill(0.5);
    store.upsert({
      filePath: "delete-me.ts",
      chunkText: "to be deleted",
      startLine: 1,
      endLine: 1,
      symbolName: "test",
      chunkType: "function",
      embedding,
    });

    store.deleteByFile("delete-me.ts");

    const results = await store.search(embedding, 5);
    const found = results.find((r) => r.filePath === "delete-me.ts");
    expect(found).toBeUndefined();
  });

  it("should upsert (update existing chunks for same file)", async () => {
    const emb1 = new Float32Array(384).fill(0.3);
    const emb2 = new Float32Array(384).fill(0.7);

    store.upsert({
      filePath: "src/main.ts",
      chunkText: "version 1",
      startLine: 1,
      endLine: 1,
      symbolName: "main",
      chunkType: "function",
      embedding: emb1,
    });
    store.upsert({
      filePath: "src/main.ts",
      chunkText: "version 2",
      startLine: 1,
      endLine: 1,
      symbolName: "main",
      chunkType: "function",
      embedding: emb2,
    });

    const results = await store.search(emb2, 10);
    const mainResults = results.filter((r) => r.filePath === "src/main.ts");
    // Should not have duplicates
    expect(mainResults.length).toBeLessThanOrEqual(1);
  });

  it("should return empty results for empty store", async () => {
    const query = new Float32Array(384).fill(0.5);
    const results = await store.search(query, 5);
    expect(results).toHaveLength(0);
  });

  it("should respect topK limit", async () => {
    const embedding = new Float32Array(384).fill(0.5);
    for (let i = 0; i < 20; i++) {
      store.upsert({
        filePath: `file${i}.ts`,
        chunkText: `chunk ${i}`,
        startLine: 1,
        endLine: 1,
        symbolName: `fn${i}`,
        chunkType: "function",
        embedding,
      });
    }

    const results = await store.search(embedding, 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("search results include a similarity field", async () => {
    const embedding = new Float32Array(384).fill(0.5);
    store.upsert({
      filePath: "sim.ts",
      chunkText: "similarity test",
      startLine: 1,
      endLine: 1,
      symbolName: "sim",
      chunkType: "function",
      embedding,
    });
    const results = await store.search(embedding, 1);
    expect(results[0]).toHaveProperty("similarity");
    expect(typeof results[0].similarity).toBe("number");
    // identical vector → distance ≈ 0 → similarity ≈ 1
    expect(results[0].similarity).toBeGreaterThan(0.9);
  });
});

describe("VectorStore model ID validation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vs-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects cached index built with different embedding model", async () => {
    const idxPath = path.join(tmpDir, "test.idx");

    // Save with model-a
    const saveStore = new VectorStore(":memory:", "model-a");
    saveStore.upsert({
      filePath: "f.ts",
      chunkText: "text",
      startLine: 1,
      endLine: 1,
      chunkType: "function",
      embedding: new Float32Array(4).fill(0.1),
    });
    await saveStore.save(idxPath);
    saveStore.dispose();

    // Load with model-b → should reject (return 0)
    const loadStore = new VectorStore(":memory:", "model-b");
    const loaded = await loadStore.load(idxPath);
    expect(loaded).toBe(0);
    loadStore.dispose();
  });

  it("accepts cached index built with same embedding model", async () => {
    const idxPath = path.join(tmpDir, "test.idx");

    const saveStore = new VectorStore(":memory:", "model-x");
    saveStore.upsert({
      filePath: "f.ts",
      chunkText: "text",
      startLine: 1,
      endLine: 1,
      chunkType: "function",
      embedding: new Float32Array(4).fill(0.1),
    });
    await saveStore.save(idxPath);
    saveStore.dispose();

    const loadStore = new VectorStore(":memory:", "model-x");
    const loaded = await loadStore.load(idxPath);
    expect(loaded).toBe(1);
    loadStore.dispose();
  });

  it("accepts cached index when no model ID is set on loader (backward compat)", async () => {
    const idxPath = path.join(tmpDir, "test.idx");

    // Save without model ID (old-style store)
    const saveStore = new VectorStore(":memory:");
    saveStore.upsert({
      filePath: "f.ts",
      chunkText: "text",
      startLine: 1,
      endLine: 1,
      chunkType: "function",
      embedding: new Float32Array(4).fill(0.1),
    });
    await saveStore.save(idxPath);
    saveStore.dispose();

    // Load without model ID → should succeed (no validation possible)
    const loadStore = new VectorStore(":memory:");
    const loaded = await loadStore.load(idxPath);
    expect(loaded).toBe(1);
    loadStore.dispose();
  });
});
