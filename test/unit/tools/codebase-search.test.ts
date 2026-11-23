import { describe, it, expect, vi } from "vitest";
import * as path from "path";
import { createCodebaseSearchTool } from "@/tools/codebase-search";
import type { ToolExecutionContext } from "@/tools/types";

function context(): ToolExecutionContext {
  return {
    workspaceRoot: "/ws",
    abortSignal: new AbortController().signal,
    reportProgress: () => undefined,
    requestApproval: async () => true,
  };
}

describe("createCodebaseSearchTool", () => {
  it("awaits an async indexing-service getter before semantic search", async () => {
    const search = vi.fn().mockResolvedValue([
      {
        filePath: "/ws/src/auth.ts",
        chunkText: "function verifyToken() {}",
        startLine: 10,
        endLine: 12,
        chunkType: "function",
        symbolName: "verifyToken",
        distance: 0.1,
        similarity: 0.9,
      },
    ]);
    const indexing = {
      isReady: () => true,
      search,
    };

    const tool = createCodebaseSearchTool(async () => indexing as never);
    const result = await tool.execute(
      { query: "authentication logic", topK: 3 },
      context(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("Semantic search results");
    expect(result.output).toContain(path.join("src", "auth.ts"));
    expect(search).toHaveBeenCalledWith("authentication logic", 3);
  });
});
