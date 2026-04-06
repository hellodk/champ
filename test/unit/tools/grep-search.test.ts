/**
 * TDD: Tests for grep_search tool.
 * Validates regex search using ripgrep.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { grepSearchTool } from "@/tools/grep-search";
import type { ToolExecutionContext } from "@/tools/types";

describe("grep_search tool", () => {
  let context: ToolExecutionContext;

  beforeEach(() => {
    context = {
      workspaceRoot: "/test-workspace",
      abortSignal: new AbortController().signal,
      reportProgress: vi.fn(),
      requestApproval: vi.fn(),
    };
  });

  it("should have correct metadata", () => {
    expect(grepSearchTool.name).toBe("grep_search");
    expect(grepSearchTool.requiresApproval).toBe(false);
    expect(grepSearchTool.parameters.required).toContain("query");
  });

  it("should search with a regex pattern and return matches", async () => {
    const result = await grepSearchTool.execute(
      { query: "function\\s+\\w+" },
      context,
    );

    expect(result.success).toBe(true);
    expect(typeof result.output).toBe("string");
  });

  it("should support include patterns", async () => {
    const result = await grepSearchTool.execute(
      { query: "import", includePattern: "*.ts" },
      context,
    );

    expect(result.success).toBe(true);
  });

  it("should support exclude patterns", async () => {
    const result = await grepSearchTool.execute(
      { query: "test", excludePattern: "node_modules" },
      context,
    );

    expect(result.success).toBe(true);
  });

  it("should support case-insensitive search", async () => {
    const result = await grepSearchTool.execute(
      { query: "TODO", caseSensitive: false },
      context,
    );

    expect(result.success).toBe(true);
  });

  it("should handle no matches gracefully", async () => {
    const result = await grepSearchTool.execute(
      { query: "xyznonexistentpattern123" },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("No matches");
  });
});
