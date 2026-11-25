/**
 * Representative retrieval benchmark over this repository's real source tree.
 *
 * Unlike the synthetic eval, this measures whether hybrid retrieval still
 * ranks the defining file first when the workspace contains hundreds of
 * unrelated declarations. Results are written to
 * test-reports/eval/retrieval-benchmark.json.
 */
import { describe, expect, it, beforeAll } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { hybridRetrieve } from "@/retrieval/hybrid-retrieval";

const ROOT = process.cwd();
const SOURCE_ROOT = path.join(ROOT, "src");

interface SourceFile {
  relative: string;
  absolute: string;
  lines: string[];
}

let files: SourceFile[] = [];

beforeAll(async () => {
  const walk = async (dir: string): Promise<string[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await walk(full)));
      else if (entry.isFile() && /\.(ts|tsx|mjs)$/.test(entry.name))
        out.push(full);
    }
    return out;
  };
  files = await Promise.all(
    (await walk(SOURCE_ROOT)).map(async (absolute) => ({
      absolute,
      relative: path.relative(ROOT, absolute).split(path.sep).join("/"),
      lines: (await fs.readFile(absolute, "utf8")).split("\n"),
    })),
  );
});

function keywordRunner(needle: string) {
  // File-level benchmark: one strongest hit per file avoids rewarding files
  // merely for mentioning a symbol many times.
  return {
    hits: files.flatMap((file) => {
      const index = file.lines.findIndex((line) =>
        line.toLowerCase().includes(needle),
      );
      return index < 0
        ? []
        : [
            {
              filePath: file.relative,
              line: index + 1,
              text: file.lines[index],
            },
          ];
    }),
  };
}

const CASES = [
  {
    query: "initializeCliRouter",
    expected: "src/cli/smart-router-init.ts",
  },
  {
    query: "probeEmbeddingProvider",
    expected: "src/indexing/embedding-probe.ts",
  },
  {
    query: "executeIndexWorkspaceCommand",
    expected: "src/indexing/index-workspace-command.ts",
  },
  {
    query: "reciprocal rank fusion",
    expected: "src/retrieval/hybrid-retrieval.ts",
  },
  {
    query: "detectBrowserRuntime",
    expected: "src/tools/browser-runtime.ts",
  },
  {
    query: "browserUnavailableMessage",
    expected: "src/tools/browser-runtime.ts",
  },
  {
    query: "cliVersion",
    expected: "src/cli.ts",
  },
  {
    query: "ChunkingService",
    expected: "src/indexing/chunking-service.ts",
  },
  {
    query: "SSHConnectionPool",
    expected: "src/ssh/ssh-connection-pool.ts",
  },
  {
    query: "WebSourceRegistry",
    expected: "src/tools/web-sources.ts",
  },
];

describe("representative retrieval benchmark", () => {
  it("uses a corpus with enough unrelated files to be meaningful", () => {
    expect(files.length).toBeGreaterThan(150);
  });

  it("keeps recall@3 above 0.8 on real source files", async () => {
    const results: Array<{
      query: string;
      expected: string;
      found: string | null;
      rank: number | null;
    }> = [];

    for (const testCase of CASES) {
      const result = await hybridRetrieve(testCase.query, ROOT, undefined, {
        topK: 3,
        keywordRunner: (query) => keywordRunner(query.toLowerCase()),
        enableSymbolChannel: false,
      });
      const rank = result.hits.findIndex(
        (hit) =>
          path.relative(ROOT, hit.filePath).split(path.sep).join("/") ===
          testCase.expected,
      );
      results.push({
        query: testCase.query,
        expected: testCase.expected,
        found: rank >= 0 ? testCase.expected : null,
        rank: rank >= 0 ? rank + 1 : null,
      });
    }

    const hits = results.filter((row) => row.found !== null).length;
    const recallAt3 = hits / results.length;
    await fs.mkdir(path.join(ROOT, "test-reports/eval"), { recursive: true });
    await fs.writeFile(
      path.join(ROOT, "test-reports/eval/retrieval-benchmark.json"),
      JSON.stringify(
        {
          corpusFiles: files.length,
          queries: results.length,
          recallAt3,
          results,
        },
        null,
        2,
      ),
    );

    expect(recallAt3).toBeGreaterThanOrEqual(0.8);
  });
});
