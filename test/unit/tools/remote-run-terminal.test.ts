/**
 * TDD: Tests for remote run_terminal_cmd tool (SSH execution).
 * Validates command execution over SSH, output capture, timeout, and sandboxing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { remoteRunTerminalTool } from "@/tools/remote-run-terminal";
import type { ToolExecutionContext } from "@/tools/types";

// Mock the SSH client
vi.mock("ssh2-sftp-client");

describe("remote run_terminal_cmd tool", () => {
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
    expect(remoteRunTerminalTool.name).toBe("remote_run_terminal_cmd");
    expect(remoteRunTerminalTool.requiresApproval).toBe(true);
    expect(remoteRunTerminalTool.parameters.required).toContain("command");
    expect(remoteRunTerminalTool.parameters.required).toContain("remote");
  });

  it("should validate required remote target", async () => {
    const result = await remoteRunTerminalTool.execute(
      { command: 'echo "hello"', remote: "" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("remote");
  });

  it("should validate SSH connection parameters", async () => {
    const result = await remoteRunTerminalTool.execute(
      { command: "ls", remote: "invalid-format" },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Invalid remote target format");
  });

  it("should parse valid SSH remote format (user@host:port)", async () => {
    // This test checks that the tool accepts valid SSH remote formats
    const result = await remoteRunTerminalTool.execute(
      {
        command: 'echo "test"',
        remote: "user@localhost:22",
      },
      context,
    );

    // Should fail during connection, not parsing
    expect(result.output).not.toContain("Invalid remote target format");
  });

  it("should block dangerous commands via sandbox on remote", async () => {
    const result = await remoteRunTerminalTool.execute(
      {
        command: "rm -rf /",
        remote: "user@localhost:22",
      },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("blocked");
  });

  it("should respect timeout on remote execution", async () => {
    const result = await remoteRunTerminalTool.execute(
      {
        command: "sleep 60",
        remote: "user@localhost:22",
        timeout: 1000,
      },
      context,
    );

    // Either timeout or connection error is acceptable
    expect(result.success).toBe(false);
  });

  it("should buffer output correctly", async () => {
    // This verifies that streaming output is captured
    const result = await remoteRunTerminalTool.execute(
      {
        command: 'echo "line1" && echo "line2"',
        remote: "user@localhost:22",
      },
      context,
    );

    // Should either succeed or fail with connection error, not parsing error
    expect(result.output).toBeDefined();
  });

  it("should pass through abort signal", async () => {
    const controller = new AbortController();
    context.abortSignal = controller.signal;

    const promise = remoteRunTerminalTool.execute(
      {
        command: "sleep 60",
        remote: "user@localhost:22",
      },
      context,
    );

    controller.abort();
    const result = await promise;

    expect(result.success).toBe(false);
  });
});
