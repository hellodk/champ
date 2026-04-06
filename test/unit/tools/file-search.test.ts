/**
 * TDD: Tests for file_search tool.
 * Fuzzy file name matching using vscode.workspace.findFiles.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fileSearchTool } from "@/tools/file-search";
import type { ToolExecutionContext } from "@/tools/types";
import * as vscode from "vscode";

describe("file_search tool", () => {
  let context: ToolExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      workspaceRoot: "/test-workspace",
      abortSignal: new AbortController().signal,
      reportProgress: vi.fn(),
      requestApproval: vi.fn(),
    };
  });

  it("should have correct metadata", () => {
    expect(fileSearchTool.name).toBe("file_search");
    expect(fileSearchTool.requiresApproval).toBe(false);
    expect(fileSearchTool.parameters.required).toContain("query");
  });

  it("should search for files matching a query", async () => {
    (vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue([
      vscode.Uri.file("/test-workspace/src/main.ts"),
      vscode.Uri.file("/test-workspace/src/mainHelper.ts"),
    ]);

    const result = await fileSearchTool.execute({ query: "main" }, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain("main.ts");
  });

  it("should return no matches message when nothing found", async () => {
    (vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue(
      [],
    );

    const result = await fileSearchTool.execute(
      { query: "xyznonexistent" },
      context,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("No files found");
  });

  it("should limit results to max 10", async () => {
    const files = Array.from({ length: 20 }, (_, i) =>
      vscode.Uri.file(`/test-workspace/file${i}.ts`),
    );
    (vscode.workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValue(
      files,
    );

    const result = await fileSearchTool.execute({ query: "file" }, context);
    expect(result.success).toBe(true);
    // Should cap at 10 results
    const lines = result.output
      .split("\n")
      .filter((l: string) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(12); // 10 files + possible header/footer
  });
});
