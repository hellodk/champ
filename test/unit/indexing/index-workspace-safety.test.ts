/**
 * TDD: index workspace must distinguish a cancelled Quick Pick from a Build
 * selection, surface setup/dialog failures through the command's error path,
 * and expose a cancellable progress notification.
 */
import { describe, expect, it, vi } from "vitest";
import { executeIndexWorkspaceCommand } from "@/indexing/index-workspace-command";
import type { IndexWorkspaceCommandDeps } from "@/indexing/index-workspace-command";

const STATS = {
  filesIndexed: 3,
  chunksIndexed: 9,
  embeddingModel: "embed",
};

function harness(overrides: Partial<IndexWorkspaceCommandDeps> = {}) {
  const service = {
    initialize: vi.fn(async () => STATS),
    getEmbeddingModel: vi.fn(() => STATS.embeddingModel),
  };
  const options: Array<{ title: string; cancellable?: boolean }> = [];
  const deps: IndexWorkspaceCommandDeps = {
    getService: () => service as never,
    withProgress: async (opts, task) => {
      options.push(opts);
      await task({ report: vi.fn() });
    },
    showInformation: vi.fn(async () => undefined),
    showWarning: vi.fn(async () => undefined),
    showError: vi.fn(async () => undefined),
    refreshStatus: vi.fn(),
    chooseRebuild: async () => false,
    ...overrides,
  };
  return { deps, service, options };
}

describe("executeIndexWorkspaceCommand safety", () => {
  it("treats a cancelled action pick as a cancellation, not Build / update", async () => {
    const { deps, service } = harness({ chooseRebuild: async () => null });

    await executeIndexWorkspaceCommand(deps);

    expect(service.initialize).not.toHaveBeenCalled();
    expect(deps.showInformation).not.toHaveBeenCalled();
    expect(deps.showWarning).not.toHaveBeenCalled();
    expect(deps.refreshStatus).not.toHaveBeenCalledWith(STATS);
  });

  it("surfaces a failure from ensureService", async () => {
    const { deps } = harness({
      getService: () => undefined,
      ensureService: async () => {
        throw new Error("service init failed");
      },
    });

    await executeIndexWorkspaceCommand(deps);

    expect(deps.showError).toHaveBeenCalledWith(
      "Champ: indexing failed: service init failed",
    );
    expect(deps.showWarning).not.toHaveBeenCalled();
  });

  it("surfaces a failure from the action pick", async () => {
    const { deps } = harness({
      chooseRebuild: async () => {
        throw new Error("picker crashed");
      },
    });

    await executeIndexWorkspaceCommand(deps);

    expect(deps.showError).toHaveBeenCalledWith(
      "Champ: indexing failed: picker crashed",
    );
  });

  it("requests a cancellable progress notification", async () => {
    const { deps, options } = harness();

    await executeIndexWorkspaceCommand(deps);

    expect(options[0]?.cancellable).toBe(true);
  });
});
