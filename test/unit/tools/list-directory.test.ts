/**
 * TDD: Tests for list_directory tool.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { listDirectoryTool } from "@/tools/list-directory";
import type { ToolExecutionContext } from "@/tools/types";
import * as vscode from "vscode";

describe("list_directory tool", () => {
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
    expect(listDirectoryTool.name).toBe("list_directory");
    expect(listDirectoryTool.requiresApproval).toBe(false);
  });

  it("should list directory contents with type indicators", async () => {
    (
      vscode.workspace.fs.readDirectory as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      ["src", 2], // directory = 2
      ["package.json", 1], // file = 1
      ["README.md", 1],
    ]);

    const result = await listDirectoryTool.execute({ path: "." }, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain("src/");
    expect(result.output).toContain("package.json");
  });

  it("should handle empty directories", async () => {
    (
      vscode.workspace.fs.readDirectory as ReturnType<typeof vi.fn>
    ).mockResolvedValue([]);

    const result = await listDirectoryTool.execute({ path: "empty" }, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain("empty");
  });

  it("should handle directory not found", async () => {
    (
      vscode.workspace.fs.readDirectory as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("Directory not found"));

    const result = await listDirectoryTool.execute(
      { path: "nonexistent" },
      context,
    );
    expect(result.success).toBe(false);
  });

  it("should reject path traversal", async () => {
    const result = await listDirectoryTool.execute({ path: "../../" }, context);
    expect(result.success).toBe(false);
  });
});
