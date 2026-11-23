/**
 * Content-addressed freshness manifest for persisted workspace indexes.
 *
 * Freshness is decided by SHA256 of every indexable file, not by mtime: a
 * checkout, copy or touch must not invalidate a perfectly good index, and an
 * edit that preserves size and mtime must never leave a stale one. The index
 * file itself is only a cache of vectors; the manifest is the source of truth.
 */
import * as crypto from "crypto";
import * as fsp from "fs/promises";
import * as path from "path";
import type { ChampConfig } from "../config/config-loader";

export const INDEX_MANIFEST_VERSION = 2;

export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  "node_modules/**",
  "dist/**",
  ".git/**",
  "*.min.js",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

export function indexingIgnorePatterns(config: ChampConfig): string[] {
  return config.indexing?.ignore
    ? [...config.indexing.ignore]
    : [...DEFAULT_IGNORE_PATTERNS];
}

export interface IndexFileState {
  sha256: string;
  size: number;
  /** Number of vector chunks produced from this file. */
  chunks: number;
}

export interface IndexManifest {
  version: typeof INDEX_MANIFEST_VERSION;
  embeddingModelId: string;
  /** SHA256 of the sorted ignore-pattern list. */
  ignoreFingerprint: string;
  chunkCount: number;
  files: Record<string, IndexFileState>;
  createdAt: string;
}

export function sha256(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function ignoreFingerprint(patterns: readonly string[]): string {
  return sha256([...patterns].sort().join("\n"));
}

export function manifestPathFor(indexPath: string): string {
  return `${indexPath}.manifest.json`;
}

export function readIndexManifest(
  indexPath: string,
): Promise<IndexManifest | null> {
  return (async () => {
    try {
      const raw = await fsp.readFile(manifestPathFor(indexPath), "utf8");
      const parsed = JSON.parse(raw) as Partial<IndexManifest>;
      if (
        parsed.version !== INDEX_MANIFEST_VERSION ||
        typeof parsed.embeddingModelId !== "string" ||
        typeof parsed.ignoreFingerprint !== "string" ||
        typeof parsed.chunkCount !== "number" ||
        typeof parsed.files !== "object" ||
        parsed.files === null ||
        Array.isArray(parsed.files)
      ) {
        return null;
      }
      for (const state of Object.values(parsed.files)) {
        if (
          !state ||
          typeof state.sha256 !== "string" ||
          typeof state.size !== "number" ||
          typeof state.chunks !== "number"
        ) {
          return null;
        }
      }
      return parsed as IndexManifest;
    } catch {
      return null;
    }
  })();
}

export async function writeIndexManifest(
  indexPath: string,
  manifest: IndexManifest,
): Promise<void> {
  const target = manifestPathFor(indexPath);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
  await fsp.rename(tmp, target);
}

export interface FreshnessInput {
  modelId: string;
  ignoreFingerprint: string;
  /** Current on-disk state, keyed by workspace-relative path. */
  files: Map<string, { sha256: string; size: number }>;
}

export interface FreshnessResult {
  fresh: boolean;
  reason?: string;
}

/** Explain precisely why a cached index cannot be reused. */
export function checkManifestFreshness(
  manifest: IndexManifest,
  input: FreshnessInput,
): FreshnessResult {
  if (manifest.embeddingModelId !== input.modelId) {
    return {
      fresh: false,
      reason: `embedding model changed (${manifest.embeddingModelId} → ${input.modelId})`,
    };
  }
  if (manifest.ignoreFingerprint !== input.ignoreFingerprint) {
    return { fresh: false, reason: "index ignore patterns changed" };
  }

  const saved = manifest.files;
  const savedNames = Object.keys(saved).sort();
  const currentNames = [...input.files.keys()].sort();
  if (savedNames.length !== currentNames.length) {
    return { fresh: false, reason: "set of indexable files changed" };
  }
  for (let i = 0; i < savedNames.length; i++) {
    if (savedNames[i] !== currentNames[i]) {
      return { fresh: false, reason: "set of indexable files changed" };
    }
  }
  for (const name of currentNames) {
    const prev = saved[name];
    const now = input.files.get(name)!;
    if (prev.sha256 !== now.sha256) {
      return { fresh: false, reason: `file content changed: ${name}` };
    }
    if (prev.size !== now.size) {
      return { fresh: false, reason: `file size changed: ${name}` };
    }
  }
  return { fresh: true };
}
