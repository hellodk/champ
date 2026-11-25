/**
 * Hybrid retrieval: fuse vector similarity, exact keyword matches and symbol
 * metadata into one ranked, de-duplicated result list.
 *
 * The three channels are deliberately independent:
 *  - semantic: IndexingService vector search (when an embedding model works)
 *  - keyword: ripgrep fixed-string search, with a portable in-process fallback
 *    when rg is not installed
 *  - symbol: ChunkingService declarations in the candidate files
 *
 * Results that point at the same file and overlapping line ranges are merged;
 * the surviving hit records every channel that found it. Channel results are
 * fused with reciprocal rank fusion (RRF, k=60) because raw similarity,
 * keyword and symbol scores are not comparable across channels.
 */
import { spawnSync } from "child_process";
import * as fsp from "fs/promises";
import * as path from "path";
import { ChunkingService, type CodeChunk } from "../indexing/chunking-service";

export type RetrievalSource = "semantic" | "keyword" | "symbol";

export interface RetrievalHit {
  /** Absolute path to the matched file. */
  filePath: string;
  startLine: number;
  endLine: number;
  snippet: string;
  symbolName?: string;
  chunkType?: string;
  /** Fused relevance in [0, 1]. */
  score: number;
  /** Channels that independently found this location. */
  sources: RetrievalSource[];
}

export interface SemanticHit {
  filePath: string;
  chunkText: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  chunkType: string;
  similarity: number;
}

export interface SemanticIndex {
  isReady(): boolean;
  search(query: string, topK: number): PromiseLike<SemanticHit[]>;
}

export type SemanticIndexGetter = () =>
  | SemanticIndex
  | null
  | PromiseLike<SemanticIndex | null>;

export interface KeywordHit {
  filePath: string;
  line: number;
  text: string;
}

export interface KeywordRun {
  hits: KeywordHit[];
  /** Non-fatal problem (for example: rg missing) surfaced to the caller. */
  error?: string;
}

export type KeywordRunner = (
  query: string,
  workspaceRoot: string,
  terms: string[],
) => PromiseLike<KeywordRun> | KeywordRun;

export interface HybridRetrievalOptions {
  topK?: number;
  semanticTopK?: number;
  minSimilarity?: number;
  maxKeywordHitsPerFile?: number;
  /** Disable the symbol channel to measure a semantic/keyword baseline. */
  enableSymbolChannel?: boolean;
  /** Injectable for tests; defaults to ripgrep with a Node fallback. */
  keywordRunner?: KeywordRunner;
  chunker?: Pick<ChunkingService, "chunkFile">;
  readFile?: (filePath: string) => Promise<string>;
  /** Workspace file listing for independent symbol discovery. */
  listFiles?: (workspaceRoot: string) => PromiseLike<string[]> | string[];
  /** Cap on files parsed by the symbol channel (default 64). */
  maxSymbolFiles?: number;
  now?: () => number;
}

export interface HybridRetrievalResult {
  hits: RetrievalHit[];
  terms: string[];
  /** True when vector search contributed at least one hit. */
  semanticUsed: boolean;
  /** True when ripgrep (or its fallback) contributed at least one hit. */
  keywordUsed: boolean;
  warnings: string[];
}

const KEYWORD_FILE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".cs",
  ".cpp",
  ".c",
  ".h",
  ".yaml",
  ".yml",
  ".json",
  ".toml",
  ".md",
  ".sh",
  ".bash",
]);

function isIndexableTextFileLike(filePath: string): boolean {
  return KEYWORD_FILE_EXTS.has(path.extname(filePath).toLowerCase());
}

const STOP_WORDS = new Set([
  "about",
  "across",
  "after",
  "again",
  "against",
  "code",
  "could",
  "does",
  "file",
  "files",
  "find",
  "from",
  "function",
  "how",
  "into",
  "logic",
  "many",
  "more",
  "search",
  "should",
  "some",
  "that",
  "the",
  "their",
  "this",
  "through",
  "using",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

/** Split natural language and camelCase identifiers into searchable terms. */
export function queryTerms(query: string): string[] {
  const expanded = query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  return [...new Set(expanded)].slice(0, 8);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** RRF damping constant; larger values give more weight to top ranks. */
const RRF_K = 60;
const RRF_CHANNELS = 3;
const RRF_NORMALISER = RRF_CHANNELS / (RRF_K + 1);

/**
 * Replace per-channel scores with normalised reciprocal-rank scores. Ranking
 * within a channel is preserved (hits arrive sorted by their native score),
 * while scores become comparable across channels.
 */
function applyReciprocalRankFusion(hits: RetrievalHit[]): void {
  const ordered = [...hits].sort(
    (a, b) =>
      b.score - a.score ||
      a.filePath.localeCompare(b.filePath) ||
      a.startLine - b.startLine,
  );
  ordered.forEach((hit, index) => {
    hit.score = clamp(1 / (RRF_K + index + 1) / RRF_NORMALISER);
  });
}

function insideWorkspace(workspaceRoot: string, filePath: string): boolean {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(filePath);
  // Semantic indexes may store workspace-relative paths; resolving them
  // against the root first keeps traversal attempts outside the workspace.
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** Parse ripgrep's newline-delimited JSON match events. */
export function parseRgJson(raw: string): KeywordHit[] {
  const hits: KeywordHit[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        data?: {
          path?: { text?: string };
          line_number?: number;
          lines?: { text?: string };
        };
      };
      if (
        event.type !== "match" ||
        !event.data?.path?.text ||
        !event.data.line_number
      ) {
        continue;
      }
      hits.push({
        filePath: event.data.path.text,
        line: event.data.line_number,
        text: (event.data.lines?.text ?? "").replace(/\r?\n$/, ""),
      });
    } catch {
      // Ignore non-JSON progress lines.
    }
  }
  return hits;
}

/** Enumerate indexable files in a workspace for symbol discovery. */
export async function listWorkspaceFiles(
  workspaceRoot: string,
): Promise<string[]> {
  const root = path.resolve(workspaceRoot);
  const skip = new Set([
    ".git",
    "node_modules",
    "dist",
    "out",
    "coverage",
    "test-reports",
  ]);
  const files: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || files.length >= 2000) return;
    let entries: import("fs").Dirent[];
    try {
      entries = (await fsp.readdir(dir, {
        withFileTypes: true,
      })) as import("fs").Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile() && isIndexableTextFileLike(full)) {
        files.push(full);
      }
    }
  };
  await walk(root, 0);
  return files;
}

/** Built-in keyword scan used when ripgrep is unavailable. */
export async function nodeKeywordSearch(
  workspaceRoot: string,
  terms: string[],
  readFile: (filePath: string) => Promise<string>,
  maxPerFile = 5,
): Promise<KeywordHit[]> {
  const hits: KeywordHit[] = [];
  const root = path.resolve(workspaceRoot);
  const skip = new Set([
    ".git",
    "node_modules",
    "dist",
    "out",
    "coverage",
    "test-reports",
  ]);
  const files: string[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 12 || files.length >= 2000) return;
    let entries: import("fs").Dirent[];
    try {
      entries = (await fsp.readdir(dir, {
        withFileTypes: true,
      })) as import("fs").Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) await walk(full, depth + 1);
      } else if (entry.isFile() && isIndexableTextFileLike(full)) {
        files.push(full);
      }
    }
  };
  await walk(root, 0);

  await Promise.all(
    files.map(async (filePath) => {
      try {
        const content = await readFile(filePath);
        const lines = content.split("\n");
        let added = 0;
        for (let i = 0; i < lines.length && added < maxPerFile; i++) {
          const lower = lines[i].toLowerCase();
          if (!terms.some((term) => lower.includes(term))) continue;
          hits.push({ filePath, line: i + 1, text: lines[i] });
          added++;
        }
      } catch {
        // Unreadable files cannot contribute keyword hits.
      }
    }),
  );
  return hits;
}

/** Default keyword runner: real ripgrep when installed, portable scan otherwise. */
export const defaultKeywordRunner: KeywordRunner = async (
  _query,
  workspaceRoot,
  terms,
) => {
  if (terms.length === 0) return { hits: [] };
  const rg = spawnSync(
    "rg",
    [
      "--json",
      "--fixed-strings",
      ...terms.flatMap((term) => ["-e", term]),
      "--line-number",
      "--max-count=5",
      "--max-filesize=500K",
      "--type-not=lock",
      "-g",
      "!node_modules/**",
      "-g",
      "!dist/**",
      "-g",
      "!.git/**",
      workspaceRoot,
    ],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    },
  );

  if (rg.error) {
    const reason =
      (rg.error as NodeJS.ErrnoException).code === "ENOENT"
        ? "ripgrep is not installed; used the built-in keyword scanner"
        : `ripgrep failed (${rg.error.message}); used the built-in keyword scanner`;
    return {
      hits: await nodeKeywordSearch(workspaceRoot, terms, (file) =>
        fsp.readFile(file, "utf8"),
      ),
      error: reason,
    };
  }
  // rg exits 1 for "no matches", which is not an error for retrieval.
  if (rg.status !== 0 && rg.status !== 1) {
    return {
      hits: await nodeKeywordSearch(workspaceRoot, terms, (file) =>
        fsp.readFile(file, "utf8"),
      ),
      error: `ripgrep exited ${rg.status}; used the built-in keyword scanner`,
    };
  }
  return { hits: parseRgJson(rg.stdout ?? "") };
};

function keywordScore(text: string, terms: string[]): number {
  if (terms.length === 0) return 0.5;
  const lower = text.toLowerCase();
  const matched = terms.filter((term) => lower.includes(term)).length;
  return clamp(0.4 + (matched / terms.length) * 0.6);
}

function overlaps(
  a: Pick<RetrievalHit, "filePath" | "startLine" | "endLine">,
  b: Pick<RetrievalHit, "filePath" | "startLine" | "endLine">,
): boolean {
  return (
    a.filePath === b.filePath &&
    a.startLine <= b.endLine &&
    b.startLine <= a.endLine
  );
}

/** Merge overlapping hits, keeping the strongest snippet and all source labels. */
export function deduplicateHits(hits: RetrievalHit[]): RetrievalHit[] {
  const merged: RetrievalHit[] = [];
  for (const hit of [...hits].sort(
    (a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath),
  )) {
    const existing = merged.find((candidate) => overlaps(candidate, hit));
    if (!existing) {
      merged.push({ ...hit, sources: [...hit.sources] });
      continue;
    }
    const sources = [...new Set([...existing.sources, ...hit.sources])];
    const stronger = hit.score > existing.score ? hit : existing;
    const wider =
      hit.endLine - hit.startLine > existing.endLine - existing.startLine
        ? hit
        : existing;
    existing.startLine = Math.min(existing.startLine, hit.startLine);
    existing.endLine = Math.max(existing.endLine, hit.endLine);
    existing.snippet = stronger.snippet || wider.snippet || existing.snippet;
    existing.symbolName ??= hit.symbolName;
    existing.chunkType ??= hit.chunkType;
    existing.sources = sources;
    existing.score = clamp(
      Math.max(existing.score, hit.score) + 0.05 * (sources.length - 1),
    );
  }
  return merged;
}

/**
 * Run all three retrieval channels and return a ranked result set.
 * No network or embedding call is made when the semantic index is absent.
 */
export async function hybridRetrieve(
  query: string,
  workspaceRoot: string,
  getIndex: SemanticIndexGetter | undefined,
  options: HybridRetrievalOptions = {},
): Promise<HybridRetrievalResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      hits: [],
      terms: [],
      semanticUsed: false,
      keywordUsed: false,
      warnings: [],
    };
  }
  const topK = Math.max(1, Math.min(options.topK ?? 8, 20));
  const terms = queryTerms(trimmed);
  const warnings: string[] = [];
  const hits: RetrievalHit[] = [];
  const root = path.resolve(workspaceRoot);
  const relative = (filePath: string): string =>
    path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath;

  let semanticUsed = false;
  let keywordUsed = false;
  const index = (await getIndex?.()) ?? null;
  if (index?.isReady()) {
    try {
      const results = await index.search(
        trimmed,
        options.semanticTopK ?? topK * 2,
      );
      for (const result of results) {
        const filePath = path.resolve(root, relative(result.filePath));
        if (!insideWorkspace(root, filePath)) continue;
        if (result.similarity < (options.minSimilarity ?? 0.55)) continue;
        semanticUsed = true;
        hits.push({
          filePath,
          startLine: result.startLine,
          endLine: result.endLine,
          snippet: result.chunkText,
          symbolName: result.symbolName,
          chunkType: result.chunkType,
          score: clamp(result.similarity),
          sources: ["semantic"],
        });
      }
      applyReciprocalRankFusion(
        hits.filter((hit) => hit.sources[0] === "semantic"),
      );
    } catch (error) {
      warnings.push(
        `semantic search unavailable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const keyword = await (options.keywordRunner ?? defaultKeywordRunner)(
    trimmed,
    root,
    terms,
  );
  if (keyword.error) warnings.push(keyword.error);
  const perFile = new Map<string, number>();
  for (const hit of keyword.hits) {
    const filePath = path.resolve(root, hit.filePath);
    if (!insideWorkspace(root, filePath)) continue;
    const count = perFile.get(filePath) ?? 0;
    if (count >= (options.maxKeywordHitsPerFile ?? 5)) continue;
    perFile.set(filePath, count + 1);
    if (hit.text.trim()) keywordUsed = true;
    hits.push({
      filePath,
      startLine: hit.line,
      endLine: hit.line,
      snippet: hit.text,
      score: keywordScore(hit.text, terms),
      sources: ["keyword"],
    });
  }
  applyReciprocalRankFusion(hits.filter((hit) => hit.sources[0] === "keyword"));

  // ── Symbol metadata channel ────────────────────────────────────────────
  if (options.enableSymbolChannel !== false) {
    const chunker = options.chunker ?? new ChunkingService();
    const readFile =
      options.readFile ?? ((file: string) => fsp.readFile(file, "utf8"));
    const chunksByFile = new Map<string, CodeChunk[]>();
    const discovered = options.listFiles
      ? await options.listFiles(root)
      : await listWorkspaceFiles(root);
    const discoveredFiles = discovered
      .map((file) => path.resolve(root, file))
      .filter(
        (file) => insideWorkspace(root, file) && isIndexableTextFileLike(file),
      );
    const hitFiles = new Set(hits.map((hit) => hit.filePath));
    const relevance = (file: string): number => {
      const name = path.basename(file).toLowerCase();
      const score = terms.reduce(
        (sum, term) =>
          sum +
          (name.includes(term) ? 2 : file.toLowerCase().includes(term) ? 1 : 0),
        0,
      );
      return score + (hitFiles.has(file) ? 3 : 0);
    };
    const candidateFiles = [...new Set([...hitFiles, ...discoveredFiles])]
      .sort((a, b) => relevance(b) - relevance(a))
      .slice(0, options.maxSymbolFiles ?? 64);
    for (const filePath of candidateFiles) {
      if (!insideWorkspace(root, filePath)) continue;
      try {
        chunksByFile.set(
          filePath,
          await chunker.chunkFile(filePath, await readFile(filePath)),
        );
      } catch {
        // A candidate disappearing between channels is not fatal.
      }
    }
    for (const hit of hits) {
      const chunks = chunksByFile.get(hit.filePath) ?? [];
      const containing = chunks.find(
        (chunk) =>
          chunk.startLine <= hit.startLine && hit.endLine <= chunk.endLine,
      );
      if (containing?.symbolName) {
        hit.symbolName ??= containing.symbolName;
        hit.chunkType ??= containing.chunkType;
      }
    }
    const symbolHits: RetrievalHit[] = [];
    for (const [filePath, chunks] of chunksByFile) {
      for (const chunk of chunks) {
        if (!chunk.symbolName) continue;
        const symbol = chunk.symbolName.toLowerCase();
        const matched =
          terms.some(
            (term) =>
              symbol.includes(term) ||
              symbol.replace(/[^a-z0-9]/g, "").includes(term),
          ) || trimmed.toLowerCase().includes(symbol);
        if (!matched) continue;
        symbolHits.push({
          filePath,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          snippet: chunk.text,
          symbolName: chunk.symbolName,
          chunkType: chunk.chunkType,
          score: 0.82,
          sources: ["symbol"],
        });
      }
    }
    applyReciprocalRankFusion(symbolHits);
    hits.push(...symbolHits);
  }

  // An exact occurrence of the query phrase is strong evidence of relevance.
  // Rank scores differ by only a few thousandths between neighbouring ranks,
  // so weight that evidence above them before falling back to path order.
  const phrase = trimmed.toLowerCase();
  const exactBonus = (hit: RetrievalHit): number =>
    hit.snippet.toLowerCase().includes(phrase) ||
    hit.symbolName?.toLowerCase().includes(phrase)
      ? 0.02
      : 0;
  const ranked = deduplicateHits(hits)
    .sort(
      (a, b) =>
        b.score + exactBonus(b) - (a.score + exactBonus(a)) ||
        a.filePath.localeCompare(b.filePath) ||
        a.startLine - b.startLine,
    )
    .slice(0, topK);

  return {
    hits: ranked,
    terms,
    semanticUsed,
    keywordUsed,
    warnings,
  };
}
