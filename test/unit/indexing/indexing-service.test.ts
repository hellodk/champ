/**
 * TDD: Tests for IndexingService.search() minSimilarity filtering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Minimal mock of the dependencies IndexingService needs at construction time.
const mockSmartRouter = {
  select: vi.fn().mockReturnValue(null),
};
const mockConfig = {};

// We import IndexingService after setting up the mock env.
import { IndexingService } from "@/indexing/indexing-service";

function makeService(): IndexingService {
  return new IndexingService(
    "/tmp/workspace",
    mockSmartRouter as never,
    mockConfig as never,
  );
}

describe("IndexingService.search minSimilarity", () => {
  it("returns empty array when all results are below threshold", async () => {
    const svc = makeService();

    // Inject a working embeddingService and a populated vectorStore via
    // the public surface: we reach into private fields through a cast.
    const inner = svc as unknown as Record<string, unknown>;

    inner["embeddingService"] = {
      embed: vi.fn().mockResolvedValue(new Float32Array(3).fill(0.5)),
    };

    // vectorStore.search returns a result with similarity 0.3 — below default 0.65
    const fakeStore = {
      size: () => 1,
      search: vi.fn().mockResolvedValue([
        {
          filePath: "a.ts",
          chunkText: "irrelevant",
          startLine: 1,
          endLine: 2,
          chunkType: "function",
          distance: 2.0,
          similarity: 0.3,
        },
      ]),
    };
    inner["vectorStore"] = fakeStore;

    const results = await svc.search("some query");
    expect(results).toHaveLength(0);
  });

  it("returns only results at or above threshold", async () => {
    const svc = makeService();
    const inner = svc as unknown as Record<string, unknown>;

    inner["embeddingService"] = {
      embed: vi.fn().mockResolvedValue(new Float32Array(3).fill(0.5)),
    };

    const fakeStore = {
      size: () => 2,
      search: vi.fn().mockResolvedValue([
        {
          filePath: "high.ts",
          chunkText: "relevant",
          startLine: 1,
          endLine: 2,
          chunkType: "function",
          distance: 0.2,
          similarity: 0.8,
        },
        {
          filePath: "low.ts",
          chunkText: "irrelevant",
          startLine: 1,
          endLine: 2,
          chunkType: "function",
          distance: 2.0,
          similarity: 0.4,
        },
      ]),
    };
    inner["vectorStore"] = fakeStore;

    const results = await svc.search("some query");
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe("high.ts");
  });

  it("accepts a custom minSimilarity override", async () => {
    const svc = makeService();
    const inner = svc as unknown as Record<string, unknown>;

    inner["embeddingService"] = {
      embed: vi.fn().mockResolvedValue(new Float32Array(3).fill(0.5)),
    };

    const fakeStore = {
      size: () => 2,
      search: vi.fn().mockResolvedValue([
        {
          filePath: "medium.ts",
          chunkText: "medium",
          startLine: 1,
          endLine: 2,
          chunkType: "function",
          distance: 1.0,
          similarity: 0.5,
        },
        {
          filePath: "low.ts",
          chunkText: "low",
          startLine: 1,
          endLine: 2,
          chunkType: "function",
          distance: 2.0,
          similarity: 0.2,
        },
      ]),
    };
    inner["vectorStore"] = fakeStore;

    // minSimilarity lowered to 0.4 — medium (0.5) should pass, low (0.2) should not
    const results = await svc.search("query", 10, 0.4);
    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe("medium.ts");
  });

  it("returns empty array when embeddingService is not ready", async () => {
    const svc = makeService();
    const results = await svc.search("query");
    expect(results).toHaveLength(0);
  });
});
