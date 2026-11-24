/**
 * Hybrid retrieval contract: three independent channels fused into one ranked,
 * de-duplicated list. Channels are injected so tests stay deterministic and
 * never need a real ripgrep, embedding model or filesystem.
 */
import { describe, it, expect, vi } from "vitest";
import * as path from "path";
import {
  deduplicateHits,
  hybridRetrieve,
  parseRgJson,
  queryTerms,
  type RetrievalHit,
} from "@/retrieval/hybrid-retrieval";
import type { CodeChunk } from "@/indexing/chunking-service";

const ROOT = path.resolve("/ws");

function chunk(overrides: Partial<CodeChunk> = {}): CodeChunk {
  return {
    filePath: path.join(ROOT, "src/auth.ts"),
    text: "function verifyToken() {}",
    startLine: 10,
    endLine: 12,
    chunkType: "function",
    symbolName: "verifyToken",
    ...overrides,
  };
}

describe("queryTerms", () => {
  it("splits camelCase and drops stop words", () => {
    expect(queryTerms("find verifyToken logic in the code")).toEqual([
      "verify",
      "token",
    ]);
  });

  it("deduplicates repeated terms", () => {
    expect(queryTerms("auth auth auth")).toEqual(["auth"]);
  });
});

describe("parseRgJson", () => {
  it("parses ripgrep match events and ignores progress lines", () => {
    const raw = [
      JSON.stringify({
        type: "begin",
        data: { path: { text: "src/auth.ts" } },
      }),
      JSON.stringify({
        type: "match",
        data: {
          path: { text: "src/auth.ts" },
          line_number: 10,
          lines: { text: "const verifyToken = 1;\n" },
        },
      }),
      "not json",
      "",
    ].join("\n");
    expect(parseRgJson(raw)).toEqual([
      {
        filePath: "src/auth.ts",
        line: 10,
        text: "const verifyToken = 1;",
      },
    ]);
  });
});

describe("deduplicateHits", () => {
  it("merges overlapping ranges and records every contributing channel", () => {
    const hits: RetrievalHit[] = [
      {
        filePath: path.join(ROOT, "src/auth.ts"),
        startLine: 10,
        endLine: 12,
        snippet: "function verifyToken() {}",
        score: 0.8,
        sources: ["semantic"],
      },
      {
        filePath: path.join(ROOT, "src/auth.ts"),
        startLine: 11,
        endLine: 11,
        snippet: "verifyToken(token)",
        score: 0.7,
        sources: ["keyword"],
      },
    ];
    const merged = deduplicateHits(hits);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources.sort()).toEqual(["keyword", "semantic"]);
    expect(merged[0].startLine).toBe(10);
    expect(merged[0].endLine).toBe(12);
    expect(merged[0].score).toBeGreaterThan(0.8);
  });

  it("never merges hits from different files", () => {
    const hits: RetrievalHit[] = [
      {
        filePath: path.join(ROOT, "a.ts"),
        startLine: 1,
        endLine: 3,
        snippet: "a",
        score: 0.5,
        sources: ["keyword"],
      },
      {
        filePath: path.join(ROOT, "b.ts"),
        startLine: 1,
        endLine: 3,
        snippet: "b",
        score: 0.5,
        sources: ["keyword"],
      },
    ];
    expect(deduplicateHits(hits)).toHaveLength(2);
  });
});

describe("hybridRetrieve", () => {
  it("fuses semantic, keyword and symbol channels into one hit", async () => {
    const index = {
      isReady: () => true,
      search: vi.fn().mockResolvedValue([
        {
          filePath: "src/auth.ts",
          chunkText: "function verifyToken() {}",
          startLine: 10,
          endLine: 12,
          chunkType: "function",
          symbolName: "verifyToken",
          similarity: 0.9,
        },
      ]),
    };
    const result = await hybridRetrieve(
      "verify token",
      ROOT,
      async () => index,
      {
        keywordRunner: () => ({
          hits: [
            {
              filePath: path.join(ROOT, "src/auth.ts"),
              line: 11,
              text: "return verifyToken(input);",
            },
          ],
        }),
        chunker: { chunkFile: async () => [chunk()] },
        readFile: async () => "function verifyToken() {}",
      },
    );

    expect(result.semanticUsed).toBe(true);
    expect(result.keywordUsed).toBe(true);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].symbolName).toBe("verifyToken");
    expect(result.hits[0].sources.sort()).toEqual([
      "keyword",
      "semantic",
      "symbol",
    ]);
  });

  it("keeps keyword-only retrieval when no semantic index exists", async () => {
    const result = await hybridRetrieve("verify token", ROOT, () => null, {
      keywordRunner: () => ({
        hits: [
          {
            filePath: path.join(ROOT, "src/auth.ts"),
            line: 11,
            text: "verifyToken(input)",
          },
        ],
      }),
      enableSymbolChannel: false,
    });

    expect(result.semanticUsed).toBe(false);
    expect(result.keywordUsed).toBe(true);
    expect(result.hits[0].sources).toEqual(["keyword"]);
  });

  it("surfaces non-fatal channel failures as warnings", async () => {
    const result = await hybridRetrieve(
      "query",
      ROOT,
      async () => ({
        isReady: () => true,
        search: async () => {
          throw new Error("model offline");
        },
      }),
      {
        keywordRunner: () => ({
          hits: [],
          error: "ripgrep is not installed; used the built-in keyword scanner",
        }),
        enableSymbolChannel: false,
      },
    );

    expect(result.semanticUsed).toBe(false);
    expect(result.warnings.some((w) => w.includes("model offline"))).toBe(true);
    expect(
      result.warnings.some((w) => w.includes("built-in keyword scanner")),
    ).toBe(true);
  });

  it("rejects keyword hits that escape the workspace", async () => {
    const result = await hybridRetrieve("query", ROOT, () => null, {
      keywordRunner: () => ({
        hits: [
          {
            filePath: path.join(ROOT, "..", "outside.ts"),
            line: 1,
            text: "secret",
          },
        ],
      }),
      enableSymbolChannel: false,
    });
    expect(result.hits).toHaveLength(0);
  });

  it("returns an empty result for a blank query without invoking channels", async () => {
    const runner = vi.fn();
    const result = await hybridRetrieve("   ", ROOT, () => null, {
      keywordRunner: runner,
    });
    expect(result.hits).toHaveLength(0);
    expect(runner).not.toHaveBeenCalled();
  });
});
