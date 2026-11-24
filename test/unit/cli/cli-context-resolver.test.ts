import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";

import { createCliContextResolver } from "@/cli/context-resolver";

describe("headless @-reference resolution (#146)", () => {
  it("resolves @Web through the registered web_search tool", async () => {
    const execute = vi.fn(async () => ({
      success: true,
      output: "web result [S1]",
    }));
    const { resolve } = createCliContextResolver({
      workspaceRoot: await mkdtemp(join(tmpdir(), "champ-ctx-")),
      webSearchTool: { execute },
      indexingService: { search: async () => [] },
    });

    const enriched = await resolve("@Web champ cli release notes");

    expect(execute).toHaveBeenCalledWith({ query: "champ cli release notes" });
    expect(enriched).toContain("@Web champ cli release notes");
    expect(enriched).toContain("web result [S1]");
  });

  it("resolves @Files from the workspace without VS Code", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "champ-ctx-"));
    await writeFile(join(workspace, "note.txt"), "hello from file", "utf8");
    const { resolve } = createCliContextResolver({
      workspaceRoot: workspace,
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      indexingService: { search: async () => [] },
    });

    const enriched = await resolve("@Files(note.txt) summarize this");

    expect(enriched).toContain("hello from file");
  });

  it("leaves plain messages untouched", async () => {
    const { resolve } = createCliContextResolver({
      workspaceRoot: await mkdtemp(join(tmpdir(), "champ-ctx-")),
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      indexingService: { search: async () => [] },
    });
    expect(await resolve("just a normal task")).toBe("just a normal task");
  });
});
