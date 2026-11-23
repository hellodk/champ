/**
 * `champ index` — inspect and manage the content-addressed semantic index.
 *
 * Status is provider-free. Rebuild and watch reuse the same IndexingService the
 * agent uses; no second indexing implementation is introduced here.
 */
import type { ChampConfig } from "../config/config-loader";
import type { Endpoint } from "../config/provider-model";
import type { SecretReader } from "../providers/factory";
import { SmartRouter } from "../providers/smart-router";
import { createCliIndexingService } from "../indexing/cli-indexing";
import { IndexingService } from "../indexing/indexing-service";

export type IndexCommand = {
  name: "status" | "rebuild" | "clear" | "watch";
};

export interface IndexStatusReport {
  indexPath: string;
  model: string | null;
  files: number;
  chunks: number;
  lastIndexed: string | null;
  fresh: boolean;
  reason: string;
}

export interface IndexCommandDeps {
  workspace: string;
  config: ChampConfig;
  endpoints?: Endpoint[];
  credentials?: SecretReader;
  embeddingAssignment?: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Injectable so watch mode can be tested without real time. */
  wait?: (ms: number) => Promise<void>;
  /** Injectable cycle bound for tests; unlimited for the real CLI. */
  maxCycles?: number;
  /** Injectable service factory for tests; defaults to CLI provider wiring. */
  serviceFactory?: () => Promise<IndexingService>;
}

function ist(iso: string | null): string {
  if (!iso) return "never";
  return (
    new Date(iso).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " IST"
  );
}

/** Stable human-readable status, shared by the CLI and its tests. */
export function formatIndexStatus(s: IndexStatusReport): string {
  return [
    `Index: ${s.indexPath}`,
    `Model: ${s.model ?? "none"}`,
    `Files: ${s.files}`,
    `Chunks: ${s.chunks}`,
    `Last indexed: ${ist(s.lastIndexed)}`,
    `Status: ${s.fresh ? "fresh" : "stale"}`,
    `Reason: ${s.reason}`,
  ].join("\n");
}

async function makeService(deps: IndexCommandDeps): Promise<IndexingService> {
  if (deps.serviceFactory) return deps.serviceFactory();
  const configured = await createCliIndexingService({
    workspaceRoot: deps.workspace,
    config: deps.config,
    endpoints: deps.endpoints,
    credentials: deps.credentials,
    embeddingAssignment: deps.embeddingAssignment,
    logger: (message) => deps.stderr(`[rag] ${message}\n`),
  });
  // Status and --clear still work with no embedding endpoint available.
  return (
    configured ??
    new IndexingService(deps.workspace, new SmartRouter(), deps.config)
  );
}

export async function runIndexCommand(
  command: IndexCommand,
  deps: IndexCommandDeps,
): Promise<number> {
  const service = await makeService(deps);
  try {
    if (command.name === "clear") {
      await service.invalidateIndex();
      deps.stdout("Index cache cleared.\n");
      return 0;
    }

    if (command.name === "status") {
      deps.stdout(`${formatIndexStatus(await service.indexStatus())}\n`);
      return 0;
    }

    if (deps.config.indexing?.enabled === false) {
      deps.stderr("champ: indexing is disabled in configuration\n");
      return 1;
    }

    const before = await service.indexStatus();
    if (!before.model) {
      deps.stderr(
        "champ: no embedding model configured — run `champ model assign embedding <id>`\n",
      );
      return 1;
    }

    if (command.name === "rebuild") {
      const stats = await service.rebuildIndex();
      if (!stats) {
        deps.stderr("champ: index rebuild failed\n");
        return 1;
      }
      deps.stdout(
        `${formatIndexStatus(await service.indexStatus())}\n` +
          `Rebuilt ${stats.filesIndexed} files, ${stats.chunksIndexed} chunks with ${stats.embeddingModel}.\n`,
      );
      return 0;
    }

    // Watch: poll content hashes and rebuild only when the manifest says stale.
    const wait =
      deps.wait ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const abort = new AbortController();
    const onSigint = () => abort.abort();
    process.once("SIGINT", onSigint);
    const maxCycles = deps.maxCycles ?? Number.POSITIVE_INFINITY;
    try {
      for (let cycle = 0; cycle < maxCycles && !abort.signal.aborted; cycle++) {
        const status = await service.indexStatus();
        if (!status.fresh) {
          deps.stderr(`[index] stale: ${status.reason} — rebuilding\n`);
          const stats = await service.rebuildIndex();
          if (!stats) {
            deps.stderr(
              "champ: index rebuild failed — retrying on next cycle\n",
            );
          } else {
            deps.stderr(
              `[index] rebuilt ${stats.filesIndexed} files, ${stats.chunksIndexed} chunks\n`,
            );
          }
        }
        if (cycle + 1 < maxCycles) await wait(2000);
      }
    } finally {
      process.off("SIGINT", onSigint);
    }
    return 0;
  } finally {
    service.dispose();
  }
}
