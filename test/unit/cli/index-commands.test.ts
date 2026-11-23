import { describe, expect, it, vi } from "vitest";
import { formatIndexStatus, runIndexCommand } from "@/cli/index-commands";
import type { IndexingService } from "@/indexing/indexing-service";

describe("champ index status formatting", () => {
  it("reports model, files, chunks, stale reason and IST timestamp", () => {
    const text = formatIndexStatus({
      indexPath: "/tmp/champ/index/abc.idx",
      model: "embed-model",
      files: 12,
      chunks: 48,
      lastIndexed: "2026-06-02T11:00:45.000Z",
      fresh: false,
      reason: "file content changed: src/a.ts",
    });
    expect(text).toContain("Model: embed-model");
    expect(text).toContain("Files: 12");
    expect(text).toContain("Chunks: 48");
    expect(text).toContain("Status: stale");
    expect(text).toContain("Reason: file content changed: src/a.ts");
    expect(text).toContain("02 Jun 2026, 16:30:45 IST");
  });

  it("reports 'never' when no index has been written", () => {
    expect(
      formatIndexStatus({
        indexPath: "/tmp/idx",
        model: null,
        files: 0,
        chunks: 0,
        lastIndexed: null,
        fresh: false,
        reason: "no persisted index",
      }),
    ).toContain("Last indexed: never");
  });

  it("watch rebuilds only on stale status and honours the cycle bound", async () => {
    const stale = {
      indexPath: "/tmp/idx",
      model: "embed-model",
      files: 1,
      chunks: 2,
      lastIndexed: null,
      fresh: false,
      reason: "file content changed: a.ts",
    };
    const fresh = { ...stale, fresh: true, reason: "index is current" };
    const service = {
      indexStatus: vi
        .fn()
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(stale)
        .mockResolvedValue(fresh),
      rebuildIndex: vi.fn().mockResolvedValue({
        filesIndexed: 1,
        chunksIndexed: 2,
        embeddingModel: "embed-model",
      }),
      dispose: vi.fn(),
    } as unknown as IndexingService;
    const stderr = vi.fn();

    const code = await runIndexCommand(
      { name: "watch" },
      {
        workspace: "/tmp/ws",
        config: {},
        stdout: vi.fn(),
        stderr,
        wait: vi.fn().mockResolvedValue(undefined),
        maxCycles: 2,
        serviceFactory: async () => service,
      },
    );

    expect(code).toBe(0);
    expect(service.rebuildIndex).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("file content changed: a.ts"),
    );
    expect(service.dispose).toHaveBeenCalledTimes(1);
  });
});
