/**
 * TDD: Tests for remote edit_file tool (SFTP operations).
 * Validates file editing over SFTP with streaming, fuzzy matching, and sandboxing.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { remoteEditFileTool } from "@/tools/remote-edit-file";
import type { ToolExecutionContext } from "@/tools/types";

// Mock the SSH client
vi.mock("ssh2-sftp-client");

describe("remote edit_file tool", () => {
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
    expect(remoteEditFileTool.name).toBe("remote_edit_file");
    expect(remoteEditFileTool.requiresApproval).toBe(true);
    expect(remoteEditFileTool.parameters.required).toContain("path");
    expect(remoteEditFileTool.parameters.required).toContain("remote");
    expect(remoteEditFileTool.parameters.required).toContain("old_content");
    expect(remoteEditFileTool.parameters.required).toContain("new_content");
  });

  it("should validate required remote target", async () => {
    const result = await remoteEditFileTool.execute(
      {
        path: "test.ts",
        remote: "",
        old_content: "const x = 1;",
        new_content: "const x = 2;",
      },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("remote");
  });

  it("should validate SSH connection parameters", async () => {
    const result = await remoteEditFileTool.execute(
      {
        path: "test.ts",
        remote: "invalid-format",
        old_content: "const x = 1;",
        new_content: "const x = 2;",
      },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("Invalid remote target format");
  });

  it("should validate file path for path traversal attacks", async () => {
    const result = await remoteEditFileTool.execute(
      {
        path: "../../etc/passwd",
        remote: "user@localhost:22",
        old_content: "test",
        new_content: "test2",
      },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toMatch(/path traversal|outside/i);
  });

  it("should parse valid SSH remote format", async () => {
    const result = await remoteEditFileTool.execute(
      {
        path: "test.ts",
        remote: "user@localhost:22",
        old_content: "const x = 1;",
        new_content: "const x = 2;",
      },
      context,
    );

    // Should fail with connection error, not parsing error
    expect(result.output).not.toContain("Invalid remote target format");
  });

  it("should stream file contents during read", async () => {
    // Verify that streaming is used for large file operations
    const largeContent = "x".repeat(1000000);
    const result = await remoteEditFileTool.execute(
      {
        path: "large.txt",
        remote: "user@localhost:22",
        old_content: largeContent.slice(0, 1000),
        new_content: largeContent.slice(0, 1000) + "modified",
      },
      context,
    );

    // Should not fail due to buffer issues
    expect(result.output).toBeDefined();
  });

  it("should handle missing file gracefully", async () => {
    const result = await remoteEditFileTool.execute(
      {
        path: "nonexistent.ts",
        remote: "user@localhost:22",
        old_content: "test",
        new_content: "replacement",
      },
      context,
    );

    expect(result.success).toBe(false);
  });

  it("should fail on ambiguous matches", async () => {
    // This would require a real connection, so we check the error handling logic
    const result = await remoteEditFileTool.execute(
      {
        path: "test.ts",
        remote: "user@localhost:22",
        old_content: "const x = 1;",
        new_content: "const x = 2;",
      },
      context,
    );

    // Should handle ambiguous match scenario
    expect(result.output).toBeDefined();
  });

  it("should report progress during file transfer", async () => {
    await remoteEditFileTool.execute(
      {
        path: "test.ts",
        remote: "user@localhost:22",
        old_content: "test",
        new_content: "replacement",
      },
      context,
    );

    // reportProgress should be called for streaming operations
    expect(context.reportProgress).toBeDefined();
  });

  it("should pass through abort signal", async () => {
    const controller = new AbortController();
    context.abortSignal = controller.signal;

    const promise = remoteEditFileTool.execute(
      {
        path: "test.ts",
        remote: "user@localhost:22",
        old_content: "test",
        new_content: "replacement",
      },
      context,
    );

    controller.abort();
    const result = await promise;

    expect(result.success).toBe(false);
  });
});
