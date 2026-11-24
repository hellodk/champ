/**
 * Retrieval evaluation suite.
 *
 * Runs a fixed query set against a small in-memory corpus and compares
 * recall@3 for a keyword-only baseline versus the full hybrid pipeline
 * (semantic + keyword + symbol). No network, embedding model or ripgrep is
 * used: every channel is injected with deterministic fixtures so the metrics
 * are reproducible on any machine.
 *
 * A machine-readable summary is written to test-reports/eval/retrieval.json.
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as fsp from "fs/promises";
import * as path from "path";
import {
  hybridRetrieve,
  type KeywordRun,
  type SemanticHit,
} from "@/retrieval/hybrid-retrieval";
import type { CodeChunk } from "@/indexing/chunking-service";

const ROOT = path.resolve("/eval-workspace");
/** Fixture keys use POSIX separators; normalise Windows path.relative output. */
const relativeKey = (filePath: string): string =>
  path.relative(ROOT, filePath).split(path.sep).join("/");
const FILES: Record<string, string> = {
  "src/auth/session.ts": [
    "export interface Session { userId: string; expiresAt: number }",
    "",
    "export function verifySession(token: string): Session {",
    "  return decodeToken(token);",
    "}",
    "",
    "function decodeToken(token: string): Session {",
    "  return JSON.parse(token) as Session;",
    "}",
  ].join("\n"),
  "src/api/routes.ts": [
    "export function handleLogin(request: Request): Response {",
    "  const session = verifySession(request.headers.get('token') ?? '');",
    "  return new Response(session.userId);",
    "}",
  ].join("\n"),
  "docs/deployment.md": [
    "# Deployment",
    "",
    "Deploy the service with `kubectl apply -f infra/app.yaml`.",
  ].join("\n"),
};

const CHUNKS: Record<string, CodeChunk[]> = {
  "src/auth/session.ts": [
    {
      filePath: path.join(ROOT, "src/auth/session.ts"),
      text: FILES["src/auth/session.ts"].split("\n").slice(2, 5).join("\n"),
      startLine: 3,
      endLine: 5,
      chunkType: "function",
      symbolName: "verifySession",
    },
    {
      filePath: path.join(ROOT, "src/auth/session.ts"),
      text: FILES["src/auth/session.ts"].split("\n").slice(7, 9).join("\n"),
      startLine: 7,
      endLine: 9,
      chunkType: "function",
      symbolName: "decodeToken",
    },
  ],
  "src/api/routes.ts": [
    {
      filePath: path.join(ROOT, "src/api/routes.ts"),
      text: FILES["src/api/routes.ts"],
      startLine: 1,
      endLine: 3,
      chunkType: "function",
      symbolName: "handleLogin",
    },
  ],
};

/** Semantic hits are fixtures keyed by query — they model a working embedder. */
const SEMANTIC_FIXTURES: Record<string, SemanticHit[]> = {
  "how do we check if someone is logged in": [
    {
      filePath: "src/auth/session.ts",
      chunkText:
        "export function verifySession(token: string): Session { ... }",
      startLine: 3,
      endLine: 5,
      chunkType: "function",
      symbolName: "verifySession",
      similarity: 0.91,
    },
  ],
  "exact verifySession function": [
    {
      filePath: "src/auth/session.ts",
      chunkText:
        "export function verifySession(token: string): Session { ... }",
      startLine: 3,
      endLine: 5,
      chunkType: "function",
      symbolName: "verifySession",
      similarity: 0.95,
    },
  ],
};

interface EvalQuery {
  query: string;
  expected: string[];
}

const QUERIES: EvalQuery[] = [
  {
    query: "how do we check if someone is logged in",
    expected: ["src/auth/session.ts"],
  },
  {
    query: "exact verifySession function",
    expected: ["src/auth/session.ts"],
  },
  {
    query: "login endpoint handler",
    expected: ["src/api/routes.ts"],
  },
];

/** Deterministic in-memory keyword channel over the fixture corpus. */
function fixtureKeywordRunner(query: string): KeywordRun {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4);
  const hits: KeywordRun["hits"] = [];
  for (const [rel, content] of Object.entries(FILES)) {
    content.split("\n").forEach((text, index) => {
      if (terms.some((term) => text.toLowerCase().includes(term))) {
        hits.push({
          filePath: path.join(ROOT, rel),
          line: index + 1,
          text,
        });
      }
    });
  }
  return { hits };
}

function semanticIndexFor(query: string) {
  const hits = SEMANTIC_FIXTURES[query] ?? [];
  return {
    isReady: () => true,
    search: async () => hits,
  };
}

async function recallAt3(query: string, hybrid: boolean): Promise<number> {
  const result = await hybridRetrieve(
    query,
    ROOT,
    hybrid ? async () => semanticIndexFor(query) : () => null,
    {
      topK: 3,
      keywordRunner: (q) => fixtureKeywordRunner(q),
      chunker: {
        chunkFile: async (filePath: string) => {
          const rel = relativeKey(filePath);
          return CHUNKS[rel] ?? [];
        },
      },
      readFile: async (filePath: string) => {
        const rel = relativeKey(filePath);
        if (!(rel in FILES)) throw new Error(`missing fixture: ${rel}`);
        return FILES[rel];
      },
      enableSymbolChannel: hybrid,
    },
  );
  const retrieved = new Set(
    result.hits.map((hit) => relativeKey(hit.filePath)),
  );
  const expected = QUERIES.find((q) => q.query === query)!.expected;
  return (
    expected.filter((file) => retrieved.has(file)).length / expected.length
  );
}

interface EvalReport {
  corpusFiles: number;
  queries: number;
  baselineRecallAt3: number;
  hybridRecallAt3: number;
  delta: number;
  perQuery: Array<{
    query: string;
    expected: string[];
    baseline: number;
    hybrid: number;
  }>;
}

let report: EvalReport;

beforeAll(async () => {
  const perQuery: EvalReport["perQuery"] = [];
  for (const { query, expected } of QUERIES) {
    perQuery.push({
      query,
      expected,
      baseline: await recallAt3(query, false),
      hybrid: await recallAt3(query, true),
    });
  }
  const average = (key: "baseline" | "hybrid") =>
    perQuery.reduce((sum, row) => sum + row[key], 0) / perQuery.length;
  const baselineRecallAt3 = average("baseline");
  const hybridRecallAt3 = average("hybrid");
  report = {
    corpusFiles: Object.keys(FILES).length,
    queries: QUERIES.length,
    baselineRecallAt3,
    hybridRecallAt3,
    delta: hybridRecallAt3 - baselineRecallAt3,
    perQuery,
  };
  const outDir = path.resolve(process.cwd(), "test-reports/eval");
  await fsp.mkdir(outDir, { recursive: true });
  await fsp.writeFile(
    path.join(outDir, "retrieval.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
});

describe("retrieval eval: hybrid vs keyword-only", () => {
  it("never regresses recall@3 relative to the keyword-only baseline", () => {
    expect(report.hybridRecallAt3).toBeGreaterThanOrEqual(
      report.baselineRecallAt3,
    );
  });

  it("recovers a semantically-described file that keyword search misses", () => {
    const row = report.perQuery.find(
      (entry) => entry.query === "how do we check if someone is logged in",
    )!;
    expect(row.baseline).toBe(0);
    expect(row.hybrid).toBe(1);
  });

  it("keeps exact-symbol and keyword hits recall at 1.0", () => {
    for (const query of [
      "exact verifySession function",
      "login endpoint handler",
    ]) {
      expect(report.perQuery.find((row) => row.query === query)!.hybrid).toBe(
        1,
      );
    }
  });

  it("writes the machine-readable eval report", async () => {
    const raw = await fsp.readFile(
      path.resolve(process.cwd(), "test-reports/eval/retrieval.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as EvalReport;
    expect(parsed.queries).toBe(QUERIES.length);
    expect(parsed.hybridRecallAt3).toBe(report.hybridRecallAt3);
  });
});
