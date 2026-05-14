/**
 * TDD: Tests for grep_search tool.
 * Validates regex search using ripgrep.
 *
 * These tests run against the real workspace root so ripgrep can find files.
 * If ripgrep is not installed, the tool correctly returns success:false —
 * tests that require a real search are skipped in that environment.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { grepSearchTool } from "@/tools/grep-search";
import type { ToolExecutionContext } from "@/tools/types";
import * as path from "path";
import { execSync } from "child_process";

const ripgrepAvailable = (() => {
  try {
    execSync("rg --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const WORKSPACE = path.resolve(__dirname, "../../../");

describe("grep_search tool", () => {
  let context: ToolExecutionContext;

  beforeEach(() => {
    context = {
      workspaceRoot: WORKSPACE,
      abortSignal: new AbortController().signal,
      reportProgress: () => {},
      requestApproval: async () => false,
    };
  });

  it("should have correct metadata", () => {
    expect(grepSearchTool.name).toBe("grep_search");
    expect(grepSearchTool.requiresApproval).toBe(false);
    expect(grepSearchTool.parameters.required).toContain("query");
    // caseSensitive schema must be boolean so the LLM passes the right type
    expect(grepSearchTool.parameters.properties?.caseSensitive?.type).toBe(
      "boolean",
    );
  });

  it("should return success:false with clear message when ripgrep is unavailable", async () => {
    if (ripgrepAvailable) return; // only meaningful when rg is absent
    const result = await grepSearchTool.execute({ query: "anything" }, context);
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/ripgrep unavailable/i);
  });

  it(
    "should search with a regex pattern and return matches",
    { skip: !ripgrepAvailable },
    async () => {
      const result = await grepSearchTool.execute({ query: "export" }, context);
      expect(result.success).toBe(true);
      expect(typeof result.output).toBe("string");
    },
  );

  it(
    "should support include patterns",
    { skip: !ripgrepAvailable },
    async () => {
      const result = await grepSearchTool.execute(
        { query: "import", includePattern: "*.ts" },
        context,
      );
      expect(result.success).toBe(true);
    },
  );

  it(
    "should support exclude patterns",
    { skip: !ripgrepAvailable },
    async () => {
      const result = await grepSearchTool.execute(
        { query: "test", excludePattern: "node_modules" },
        context,
      );
      expect(result.success).toBe(true);
    },
  );

  it(
    "should support case-insensitive search",
    { skip: !ripgrepAvailable },
    async () => {
      const result = await grepSearchTool.execute(
        { query: "TODO", caseSensitive: false },
        context,
      );
      expect(result.success).toBe(true);
    },
  );

  it(
    "should handle no matches gracefully",
    { skip: !ripgrepAvailable },
    async () => {
      const result = await grepSearchTool.execute(
        { query: "xyznonexistentpattern_unique_12345abc" },
        context,
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("No matches");
    },
  );
});
