/**
 * TDD: hybrid retrieval must fuse channels with reciprocal rank fusion so a
 * hit confirmed by two independent channels outranks a higher raw score from
 * a single channel.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import { hybridRetrieve } from "@/retrieval/hybrid-retrieval";
import type { CodeChunk } from "@/indexing/chunking-service";

const ROOT = path.resolve("/ws");

function chunk(filePath: string, symbolName: string): CodeChunk {
  return {
    filePath,
    text: `function ${symbolName}() {}`,
    startLine: 10,
    endLine: 12,
    chunkType: "function",
    symbolName,
  };
}

describe("reciprocal rank fusion", () => {
  it("ranks a multi-channel hit above a higher-scoring single-channel hit", async () => {
    const result = await hybridRetrieve(
      "verify token cache",
      ROOT,
      async () => ({
        isReady: () => true,
        search: async () => [
          {
            filePath: "src/a.ts",
            chunkText: "function verifyToken() {}",
            startLine: 1,
            endLine: 3,
            chunkType: "function",
            symbolName: "verifyToken",
            similarity: 0.99,
          },
        ],
      }),
      {
        keywordRunner: () => ({
          hits: [
            { filePath: "src/b.ts", line: 11, text: "verifyToken(input)" },
          ],
        }),
        chunker: {
          chunkFile: async (file: string) =>
            file.endsWith("b.ts")
              ? [chunk(path.join(ROOT, "src/b.ts"), "verifyToken")]
              : [],
        },
        readFile: async () => "function verifyToken() {}",
      },
    );

    expect(result.hits[0]?.filePath).toBe(path.join(ROOT, "src/b.ts"));
    expect(result.hits[0]?.sources.sort()).toEqual(["keyword", "symbol"]);
    expect(result.hits[0]?.score).toBeGreaterThan(result.hits[1]?.score ?? 0);
  });
});
