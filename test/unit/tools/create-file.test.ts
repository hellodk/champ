/**
 * TDD: Tests for create_file tool.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createFileTool } from "@/tools/create-file";
import type { ToolExecutionContext } from "@/tools/types";
import * as vscode from "vscode";

describe("create_file tool", () => {
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
    expect(createFileTool.name).toBe("create_file");
    expect(createFileTool.requiresApproval).toBe(true);
    expect(createFileTool.parameters.required).toContain("path");
    expect(createFileTool.parameters.required).toContain("content");
  });

  it("should create a new file with given content", async () => {
    (
      vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>
    ).mockResolvedValue(undefined);

    const result = await createFileTool.execute(
      { path: "src/new-file.ts", content: "export const x = 1;" },
      context,
    );

    expect(result.success).toBe(true);
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalled();
    expect(result.metadata?.filesCreated).toContain("src/new-file.ts");
  });

  it("should reject path traversal", async () => {
    const result = await createFileTool.execute(
      { path: "../../../etc/malicious", content: "bad" },
      context,
    );
    expect(result.success).toBe(false);
  });
});
