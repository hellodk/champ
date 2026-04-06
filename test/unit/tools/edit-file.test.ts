/**
 * TDD: Tests for edit_file tool.
 * Validates search-and-replace edits, diff generation, and approval.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { editFileTool } from "@/tools/edit-file";
import type { ToolExecutionContext } from "@/tools/types";
import * as vscode from "vscode";

describe("edit_file tool", () => {
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
    expect(editFileTool.name).toBe("edit_file");
    expect(editFileTool.requiresApproval).toBe(true);
    expect(editFileTool.parameters.required).toContain("path");
    expect(editFileTool.parameters.required).toContain("old_content");
    expect(editFileTool.parameters.required).toContain("new_content");
  });

  it("should replace old content with new content", async () => {
    const mockDoc = {
      getText: () => "const x = 1;\nconst y = 2;\n",
      positionAt: (offset: number) => ({ line: 0, character: offset }),
      uri: vscode.Uri.file("/test-workspace/test.ts"),
    };
    (
      vscode.workspace.openTextDocument as ReturnType<typeof vi.fn>
    ).mockResolvedValue(mockDoc);
    (vscode.workspace.applyEdit as ReturnType<typeof vi.fn>).mockResolvedValue(
      true,
    );

    const result = await editFileTool.execute(
      {
        path: "test.ts",
        old_content: "const x = 1;",
        new_content: "const x = 42;",
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.filesModified).toContain("test.ts");
  });

  it("should fail when old content is not found", async () => {
    const mockDoc = {
      getText: () => "const x = 1;\n",
      uri: vscode.Uri.file("/test-workspace/test.ts"),
    };
    (
      vscode.workspace.openTextDocument as ReturnType<typeof vi.fn>
    ).mockResolvedValue(mockDoc);

    const result = await editFileTool.execute(
      {
        path: "test.ts",
        old_content: "not found content",
        new_content: "replacement",
      },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Could not find");
  });

  it("should handle file open errors", async () => {
    (
      vscode.workspace.openTextDocument as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("File not found"));

    const result = await editFileTool.execute(
      { path: "missing.ts", old_content: "x", new_content: "y" },
      context,
    );

    expect(result.success).toBe(false);
  });

  it("should reject path traversal", async () => {
    const result = await editFileTool.execute(
      { path: "../../../etc/passwd", old_content: "x", new_content: "y" },
      context,
    );
    expect(result.success).toBe(false);
  });
});
