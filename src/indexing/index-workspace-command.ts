/**
 * Shared implementation of the `champ.indexWorkspace` command.
 *
 * Kept out of extension.ts so the command contract is testable without
 * activating VS Code. The host supplies progress, dialogs, the live indexing
 * service, and a status refresh callback.
 */
import type { IndexingService, IndexingStats } from "./indexing-service";

export interface IndexWorkspaceProgress {
  report(value: { message?: string; increment?: number }): void;
}

export interface IndexWorkspaceCommandDeps {
  getService: () => IndexingService | undefined;
  ensureService?: () => Promise<IndexingService | undefined>;
  withProgress: (
    options: { title: string },
    task: (progress: IndexWorkspaceProgress) => Promise<void>,
  ) => Promise<void>;
  showInformation: (message: string) => Promise<void> | void;
  showWarning: (message: string) => Promise<void> | void;
  showError: (message: string) => Promise<void> | void;
  refreshStatus: (stats: IndexingStats | null) => void;
  chooseRebuild?: () => Promise<boolean>;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Execute one `champ.indexWorkspace` invocation. */
export async function executeIndexWorkspaceCommand(
  deps: IndexWorkspaceCommandDeps,
): Promise<void> {
  const service =
    deps.getService() ?? (await deps.ensureService?.()) ?? undefined;
  if (!service) {
    await deps.showWarning("Champ: no workspace open.");
    deps.refreshStatus(null);
    return;
  }

  const rebuild = deps.chooseRebuild ? await deps.chooseRebuild() : false;
  try {
    await deps.withProgress(
      { title: "Champ: Indexing workspace" },
      async (progress) => {
        progress.report({
          message: rebuild
            ? "Rebuilding index from scratch…"
            : "Initializing embedding model…",
        });
        const stats = await service.initialize({ force: rebuild });
        if (!stats || !service.getEmbeddingModel()) {
          await deps.showWarning(
            "Champ: no working embedding model is available. Configure an embedding model before indexing the workspace.",
          );
          deps.refreshStatus(null);
          return;
        }

        progress.report({
          message: `Indexed ${stats.filesIndexed} files, ${stats.chunksIndexed} chunks`,
        });
        await deps.showInformation(
          `Champ: indexed ${stats.filesIndexed} files, ${stats.chunksIndexed} chunks with ${stats.embeddingModel}.`,
        );
        deps.refreshStatus(stats);
      },
    );
  } catch (err) {
    await deps.showError(`Champ: indexing failed: ${messageOf(err)}`);
    deps.refreshStatus(null);
  }
}
