/**
 * TDD: the symbol channel must discover declarations outside the 16 files
 * already returned by semantic/keyword search.
 */
import { describe, expect, it } from "vitest";
import * as path from "path";
import { hybridRetrieve } from "@/retrieval/hybrid-retrieval";
import type { CodeChunk } from "@/indexing/chunking-service";

const ROOT = path.resolve("/ws");

function chunk(filePath: string, symbolName: string): CodeChunk {
  return {
    filePath,
    text: `export function ${symbolName}() { return 1; }`,
    startLine: 4,
    endLine: 6,
    chunkType: "function",
    symbolName,
  };
}

describe("independent symbol discovery", () => {
  it("finds a declared symbol in a file no other channel returned", async () => {
    const unrelated = Array.from({ length: 20 }, (_, i) =>
      path.join(ROOT, `src/unrelated-${i}.ts`),
    );
    const target = path.join(ROOT, "src/decode-token.ts");

    const result = await hybridRetrieve(
      "decodeToken",
      ROOT,
      async () => ({
        isReady: () => true,
        search: async () => [
          {
            filePath: "src/seed.ts",
            chunkText: "seed hit",
            startLine: 1,
            endLine: 2,
            chunkType: "block",
            similarity: 0.9,
          },
        ],
      }),
      {
        keywordRunner: () => ({ hits: [] }),
        listFiles: () => [...unrelated, target],
        chunker: {
          chunkFile: async (file: string) =>
            file === target ? [chunk(target, "decodeToken")] : [],
        },
        readFile: async () => "export function decodeToken() { return 1; }",
      },
    );

    expect(result.hits.some((hit) => hit.filePath === target)).toBe(true);
    expect(
      result.hits.find((hit) => hit.filePath === target)?.sources,
    ).toContain("symbol");
  });
});
