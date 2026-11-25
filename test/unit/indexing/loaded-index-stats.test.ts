/**
 * TDD: loading a persisted index must report the number of files it covers,
 * not a hard-coded zero.
 */
import { describe, expect, it } from "vitest";
import { VectorStore } from "@/indexing/vector-store";

describe("VectorStore file reporting", () => {
  it("lists the distinct files covered by loaded entries", () => {
    const store = new VectorStore("embed", "test-model");
    const vector = new Float32Array([1, 0]);
    store.upsert({
      filePath: "/ws/src/a.ts",
      chunkText: "a1",
      startLine: 1,
      endLine: 2,
      chunkType: "block",
      embedding: vector,
    });
    store.upsert({
      filePath: "/ws/src/a.ts",
      chunkText: "a2",
      startLine: 3,
      endLine: 4,
      chunkType: "block",
      embedding: vector,
    });
    store.upsert({
      filePath: "/ws/src/b.ts",
      chunkText: "b1",
      startLine: 1,
      endLine: 2,
      chunkType: "block",
      embedding: vector,
    });

    expect(store.filePaths().sort()).toEqual(["/ws/src/a.ts", "/ws/src/b.ts"]);
  });
});
