/**
 * TDD: Tests for run_terminal_cmd tool.
 * Validates command execution, output capture, timeout, and sandboxing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { runTerminalTool } from "@/tools/run-terminal";
import type { ToolExecutionContext } from "@/tools/types";

describe("run_terminal_cmd tool", () => {
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
    expect(runTerminalTool.name).toBe("run_terminal_cmd");
    expect(runTerminalTool.requiresApproval).toBe(true);
    expect(runTerminalTool.parameters.required).toContain("command");
  });

  it("should execute a command and return stdout", async () => {
    const result = await runTerminalTool.execute(
      { command: 'echo "hello world"' },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("hello world");
  });

  it("should capture stderr on failure", async () => {
    const result = await runTerminalTool.execute(
      { command: "ls /nonexistent-path-12345" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("STDERR");
  });

  it("should return exit code", async () => {
    const result = await runTerminalTool.execute(
      { command: "exit 42" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Exit code");
  });

  it("should respect timeout", async () => {
    const result = await runTerminalTool.execute(
      { command: "sleep 60", timeout: 1000 },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/timeout|killed/i);
  }, 10000);

  it("should truncate very large output", async () => {
    const result = await runTerminalTool.execute(
      { command: "seq 1 100000" },
      context,
    );

    expect(result.success).toBe(true);
    // Output should be capped
    expect(result.output.length).toBeLessThan(20000);
  });

  it("should report progress during execution", async () => {
    await runTerminalTool.execute(
      { command: 'echo "line1" && echo "line2"' },
      context,
    );

    expect(context.reportProgress).toHaveBeenCalled();
  });

  it("should block dangerous commands when sandboxed", async () => {
    const result = await runTerminalTool.execute(
      { command: "rm -rf /" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("blocked");
  });
});
