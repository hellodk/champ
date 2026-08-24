import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDelegateTaskTool } from "../delegate-task";
import type { ToolExecutionContext } from "../types";

// Mock agent controller
const mockAgentController = {
  processMessage: vi.fn(),
};

// Mock shared memory
const mockSharedMemory = {
  set: vi.fn(),
  get: vi.fn(),
  subscribe: vi.fn(),
  hasChannel: vi.fn(),
};

function makeContext(): ToolExecutionContext {
  return {
    workspaceRoot: "/tmp/workspace",
    abortSignal: new AbortController().signal,
    reportProgress: vi.fn(),
    requestApproval: async () => true,
  };
}

describe("DelegateTaskTool", () => {
  let tool: ReturnType<typeof createDelegateTaskTool>;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = createDelegateTaskTool(mockAgentController, mockSharedMemory);
  });

  it("has correct name and description", () => {
    expect(tool.name).toBe("delegate_task");
    expect(tool.description).toContain("sub-agent");
    expect(tool.description.length > 0).toBe(true);
  });

  it("requires approval for execution", () => {
    expect(tool.requiresApproval).toBe(true);
  });

  it("returns failure when task is missing", async () => {
    const context = makeContext();
    const result = await tool.execute({}, context);

    expect(result.success).toBe(false);
    expect(result.output).toContain("task");
  });

  it("returns failure when scope is invalid", async () => {
    const context = makeContext();
    const result = await tool.execute(
      {
        task: "Do something",
        scope: "invalid_scope",
      },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("scope");
  });

  it("executes task with default model when model not specified", async () => {
    mockAgentController.processMessage.mockResolvedValue({
      text: "Task completed successfully",
      toolCalls: [],
    });

    const context = makeContext();
    const result = await tool.execute(
      {
        task: "Refactor the authentication module",
        scope: "file",
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(mockAgentController.processMessage).toHaveBeenCalled();
  });

  it("executes task with specified model", async () => {
    mockAgentController.processMessage.mockResolvedValue({
      text: "Analysis complete",
      toolCalls: [],
    });

    const context = makeContext();
    const result = await tool.execute(
      {
        task: "Analyze code complexity",
        scope: "directory",
        model: "claude-haiku",
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(mockAgentController.processMessage).toHaveBeenCalled();
  });

  it("supports 'file' scope for single file operations", async () => {
    mockAgentController.processMessage.mockResolvedValue({
      text: "File processed",
      toolCalls: [],
    });

    const context = makeContext();
    const result = await tool.execute(
      {
        task: "Format this TypeScript file",
        scope: "file",
      },
      context,
    );

    expect(result.success).toBe(true);
  });

  it("supports 'directory' scope for multi-file operations", async () => {
    mockAgentController.processMessage.mockResolvedValue({
      text: "Directory processed",
      toolCalls: [],
    });

    const context = makeContext();
    const result = await tool.execute(
      {
        task: "Run tests in src/",
        scope: "directory",
      },
      context,
    );

    expect(result.success).toBe(true);
  });

  it("supports 'workspace' scope for full workspace operations", async () => {
    mockAgentController.processMessage.mockResolvedValue({
      text: "Workspace processed",
      toolCalls: [],
    });

    const context = makeContext();
    const result = await tool.execute(
      {
        task: "Audit all security issues",
        scope: "workspace",
      },
      context,
    );

    expect(result.success).toBe(true);
  });

  it("passes context to sub-agent", async () => {
    mockAgentController.processMessage.mockResolvedValue({
      text: "Context passed",
      toolCalls: [],
    });

    const context = makeContext();
    const result = await tool.execute(
      {
        task: "Review changes",
        scope: "file",
        context: {
          currentFile: "/src/app.ts",
          lineStart: 10,
          lineEnd: 50,
        },
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(mockAgentController.processMessage).toHaveBeenCalled();
  });

  it("reports progress of sub-agent execution", async () => {
    mockAgentController.processMessage.mockResolvedValue({
      text: "Progress reported",
      toolCalls: [],
    });

    const context = makeContext();
    const reportProgressSpy = vi.fn();
    context.reportProgress = reportProgressSpy;

    await tool.execute(
      {
        task: "Do something",
        scope: "file",
      },
      context,
    );

    // Should report at least the start of delegation
    expect(reportProgressSpy).toHaveBeenCalled();
  });

  it("includes sub-agent output in result", async () => {
    const expectedOutput = "Sub-agent completed: Fixed 5 issues";
    mockAgentController.processMessage.mockResolvedValue({
      text: expectedOutput,
      toolCalls: [],
    });

    const context = makeContext();
    const result = await tool.execute(
      {
        task: "Fix linting errors",
        scope: "file",
      },
      context,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("Sub-agent");
  });

  it("handles sub-agent errors gracefully", async () => {
    mockAgentController.processMessage.mockRejectedValue(
      new Error("Sub-agent crash"),
    );

    const context = makeContext();
    const result = await tool.execute(
      {
        task: "Do something",
        scope: "file",
      },
      context,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("failed");
  });

  it("has correct parameter schema", () => {
    const params = tool.parameters;
    expect(params.type).toBe("object");
    expect(params.properties).toHaveProperty("task");
    expect(params.properties).toHaveProperty("scope");
    expect(params.properties?.task.type).toBe("string");
    expect(params.properties?.scope.enum).toContain("file");
    expect(params.properties?.scope.enum).toContain("directory");
    expect(params.properties?.scope.enum).toContain("workspace");
  });

  it("allows optional context parameter in schema", () => {
    const params = tool.parameters;
    expect(params.properties).toHaveProperty("context");
  });

  it("allows optional model parameter in schema", () => {
    const params = tool.parameters;
    expect(params.properties).toHaveProperty("model");
  });

  it("provides meaningful preview for approval dialog", () => {
    const preview = tool.getPreview?.({
      task: "Review security vulnerabilities",
      scope: "workspace",
      model: "claude-sonnet",
    });

    expect(preview).toBeDefined();
    expect(preview?.type).toBe("command");
    expect(preview?.content).toContain("Review security vulnerabilities");
  });
});
