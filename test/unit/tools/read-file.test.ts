/**
 * TDD: Tests for read_file tool.
 * Validates file reading with line numbers, ranges, and error handling.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileTool } from "@/tools/read-file";
import type { ToolExecutionContext } from "@/tools/types";
import * as vscode from "vscode";

describe("read_file tool", () => {
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
    expect(readFileTool.name).toBe("read_file");
    expect(readFileTool.requiresApproval).toBe(false);
    expect(readFileTool.parameters.required).toContain("path");
  });

  it("should read a file and return numbered lines", async () => {
    const fileContent = "line one\nline two\nline three";
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(new TextEncoder().encode(fileContent));

    const result = await readFileTool.execute({ path: "src/main.ts" }, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain("1:");
    expect(result.output).toContain("line one");
    expect(result.output).toContain("3:");
    expect(result.output).toContain("line three");
  });

  it("should read a specific line range", async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(new TextEncoder().encode(lines));

    const result = await readFileTool.execute(
      { path: "test.ts", startLine: 5, endLine: 10 },
      context,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("5:");
    expect(result.output).toContain("line 5");
    expect(result.output).toContain("10:");
    expect(result.output).not.toContain("11:");
  });

  it("should handle file not found", async () => {
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("File not found"));

    const result = await readFileTool.execute(
      { path: "nonexistent.ts" },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("should truncate very large files", async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    (
      vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(new TextEncoder().encode(lines));

    const result = await readFileTool.execute({ path: "big.ts" }, context);
    expect(result.success).toBe(true);
    expect(result.output).toContain("truncated");
  });

  it("should reject path traversal attempts", async () => {
    const result = await readFileTool.execute(
      { path: "../../etc/passwd" },
      context,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("outside workspace");
  });
});
