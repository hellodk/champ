/**
 * TDD: Tests for read_file tool.
 * Validates file reading with line numbers, ranges, and error handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readFileTool } from "@/tools/read-file";
import type { ToolExecutionContext } from "@/tools/types";
import { MAX_READ_FILE_BYTES } from "@/utils/bounded-read";
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

  /**
   * External review 4b had only bounded the headless tool; pass 2 found the
   * VS Code tool still read whole files. A huge file is now read as a prefix
   * through node fs (the same helper the CLI uses).
   */
  describe("huge files (review pass 2)", () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "champ-read-file-"));
      context.workspaceRoot = dir;
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    function writeHuge(name: string, lines: number): void {
      fs.writeFileSync(
        path.join(dir, name),
        Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join("\n"),
      );
    }

    function mockSize(size: number): void {
      (vscode.workspace.fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({
        size,
        type: 1,
      });
    }

    it("reads a bounded prefix and says so", async () => {
      writeHuge("huge.ts", 400_000);
      mockSize(fs.statSync(path.join(dir, "huge.ts")).size);

      const result = await readFileTool.execute(
        { path: "huge.ts", startLine: 1, endLine: 2 },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("1: line 1");
      expect(result.output).toContain("showing the first");
      expect(result.output).not.toContain("400000: line 400000");
      // Nothing was handed to the VS Code API for the big read.
      expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    });

    it("fails loudly when the range is past the read limit", async () => {
      writeHuge("huge.ts", 400_000);
      mockSize(fs.statSync(path.join(dir, "huge.ts")).size);

      const result = await readFileTool.execute(
        { path: "huge.ts", startLine: 399_000 },
        context,
      );

      expect(result.success).toBe(false);
      expect(result.output).toContain("past the read limit");
      expect(result.output).toContain("grep_search");
    });

    it("falls back to the VS Code API when node fs cannot read the file", async () => {
      // Stat reports a huge file, but the path has no local file behind it
      // (virtual workspace): the read must still work.
      mockSize(MAX_READ_FILE_BYTES + 1);
      (
        vscode.workspace.fs.readFile as ReturnType<typeof vi.fn>
      ).mockResolvedValue(new TextEncoder().encode("virtual\nfile"));

      const result = await readFileTool.execute(
        { path: "virtual.ts" },
        context,
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("virtual");
      expect(result.output).not.toContain("showing the first");
    });
  });
});
