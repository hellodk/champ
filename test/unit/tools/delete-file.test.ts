/**
 * TDD: Tests for delete_file tool.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { deleteFileTool } from "@/tools/delete-file";
import type { ToolExecutionContext } from "@/tools/types";
import * as vscode from "vscode";

describe("delete_file tool", () => {
  let context: ToolExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      workspaceRoot: "/test-workspace",
      abortSignal: new AbortController().signal,
      reportProgress: vi.fn(),
      requestApproval: vi.fn().mockResolvedValue(true),
    };
  });

  it("should have correct metadata", () => {
    expect(deleteFileTool.name).toBe("delete_file");
    expect(deleteFileTool.requiresApproval).toBe(true);
    expect(deleteFileTool.parameters.required).toContain("path");
  });

  it("should delete a file", async () => {
    (vscode.workspace.fs.delete as ReturnType<typeof vi.fn>).mockResolvedValue(
      undefined,
    );

    const result = await deleteFileTool.execute(
      { path: "old-file.ts" },
      context,
    );
    expect(result.success).toBe(true);
    expect(vscode.workspace.fs.delete).toHaveBeenCalled();
    expect(result.metadata?.filesDeleted).toContain("old-file.ts");
  });

  it("should handle file not found", async () => {
    (vscode.workspace.fs.delete as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("File not found"),
    );

    const result = await deleteFileTool.execute(
      { path: "missing.ts" },
      context,
    );
    expect(result.success).toBe(false);
  });

  it("should reject path traversal", async () => {
    const result = await deleteFileTool.execute(
      { path: "../../etc/passwd" },
      context,
    );
    expect(result.success).toBe(false);
  });
});
