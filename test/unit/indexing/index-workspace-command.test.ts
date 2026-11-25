/**
 * TDD: `champ.indexWorkspace` must be a real command with progress, rebuild,
 * a useful report, explicit missing-embedding handling, and status refresh.
 */
import { describe, expect, it, vi } from "vitest";
import type { IndexingStats } from "@/indexing/indexing-service";
import {
  executeIndexWorkspaceCommand,
  type IndexWorkspaceCommandDeps,
  type IndexWorkspaceProgress,
} from "@/indexing/index-workspace-command";

const STATS: IndexingStats = {
  filesIndexed: 12,
  chunksIndexed: 48,
  embeddingModel: "nomic-embed-text",
};

function harness(overrides: Partial<IndexWorkspaceCommandDeps> = {}) {
  const progress: IndexWorkspaceProgress = { report: vi.fn() };
  const service = {
    initialize: vi.fn(async () => STATS),
    getEmbeddingModel: vi.fn(() => STATS.embeddingModel),
  };
  const deps: IndexWorkspaceCommandDeps = {
    getService: () => service as never,
    withProgress: async (_options, task) => task(progress),
    showInformation: vi.fn(async () => undefined),
    showWarning: vi.fn(async () => undefined),
    showError: vi.fn(async () => undefined),
    refreshStatus: vi.fn(),
    chooseRebuild: async () => false,
    ...overrides,
  };
  return { deps, progress, service };
}

describe("executeIndexWorkspaceCommand", () => {
  it("initializes the index with progress and reports files, chunks and model", async () => {
    const { deps, progress, service } = harness();

    await executeIndexWorkspaceCommand(deps);

    expect(service.initialize).toHaveBeenCalledWith({ force: false });
    expect(progress.report).toHaveBeenCalledWith({
      message: "Initializing embedding model…",
    });
    expect(progress.report).toHaveBeenCalledWith({
      message: "Indexed 12 files, 48 chunks",
    });
    expect(deps.showInformation).toHaveBeenCalledWith(
      "Champ: indexed 12 files, 48 chunks with nomic-embed-text.",
    );
    expect(deps.refreshStatus).toHaveBeenCalledWith(STATS);
    expect(deps.showWarning).not.toHaveBeenCalled();
  });

  it("rebuilds from scratch when selected", async () => {
    const { deps, service } = harness({ chooseRebuild: async () => true });

    await executeIndexWorkspaceCommand(deps);

    expect(service.initialize).toHaveBeenCalledWith({ force: true });
    expect(deps.refreshStatus).toHaveBeenCalledWith(STATS);
  });

  it("reports a missing embedding model without claiming success", async () => {
    const initialize = vi.fn(async () => null);
    const { deps } = harness({
      getService: () => ({ initialize, getEmbeddingModel: () => null }) as never,
    });

    await executeIndexWorkspaceCommand(deps);

    expect(deps.showWarning).toHaveBeenCalledWith(
      expect.stringContaining("embedding model"),
    );
    expect(deps.showInformation).not.toHaveBeenCalled();
    expect(deps.refreshStatus).toHaveBeenCalledWith(null);
  });

  it("warns when no workspace service is available", async () => {
    const { deps } = harness({ getService: () => undefined });

    await executeIndexWorkspaceCommand(deps);

    expect(deps.showWarning).toHaveBeenCalledWith(
      "Champ: no workspace open.",
    );
    expect(deps.refreshStatus).toHaveBeenCalledWith(null);
  });

  it("surfaces initialization failures", async () => {
    const { deps } = harness({
      getService: () =>
        ({
          initialize: vi.fn(async () => {
            throw new Error("embedding provider offline");
          }),
          getEmbeddingModel: () => null,
        }) as never,
    });

    await executeIndexWorkspaceCommand(deps);

    expect(deps.showError).toHaveBeenCalledWith(
      "Champ: indexing failed: embedding provider offline",
    );
    expect(deps.refreshStatus).toHaveBeenCalledWith(null);
  });
});
