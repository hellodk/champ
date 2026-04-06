/**
 * TDD: Tests for ToolRegistry.
 * Validates tool registration, retrieval, execution, and approval flow.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { ToolRegistry } from "@/tools/registry";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/types";

function createMockTool(name: string, requiresApproval = false): Tool {
  return {
    name,
    description: `Mock tool: ${name}`,
    parameters: {
      type: "object" as const,
      properties: { input: { type: "string", description: "Input" } },
      required: ["input"],
    },
    requiresApproval,
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: `Executed ${name}`,
    }),
  };
}

function createMockContext(approvalResponse = true): ToolExecutionContext {
  return {
    workspaceRoot: "/test-workspace",
    abortSignal: new AbortController().signal,
    reportProgress: vi.fn(),
    requestApproval: vi.fn().mockResolvedValue(approvalResponse),
  };
}

describe("ToolRegistry", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it("should register a tool", () => {
    const tool = createMockTool("read_file");
    registry.register(tool);
    expect(registry.get("read_file")).toBe(tool);
  });

  it("should return undefined for unregistered tool", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("should list all registered tools", () => {
    registry.register(createMockTool("read_file"));
    registry.register(createMockTool("edit_file"));
    registry.register(createMockTool("grep_search"));

    const tools = registry.getAll();
    expect(tools).toHaveLength(3);
  });

  it("should return tool definitions for LLM", () => {
    registry.register(createMockTool("read_file"));
    const defs = registry.getDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("read_file");
    expect(defs[0].parameters).toBeDefined();
  });

  it("should execute a tool by name", async () => {
    const tool = createMockTool("read_file");
    registry.register(tool);
    const ctx = createMockContext();

    const result = await registry.execute("read_file", { input: "test" }, ctx);
    expect(result.success).toBe(true);
    expect(tool.execute).toHaveBeenCalledWith({ input: "test" }, ctx);
  });

  it("should return failure for unknown tool", async () => {
    const ctx = createMockContext();
    const result = await registry.execute("unknown", {}, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("Unknown tool");
  });

  it("should request approval for tools that require it", async () => {
    const tool = createMockTool("run_terminal_cmd", true);
    registry.register(tool);
    const ctx = createMockContext(true);

    await registry.execute("run_terminal_cmd", { input: "ls" }, ctx);
    expect(ctx.requestApproval).toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalled();
  });

  it("should not execute tool when approval is denied", async () => {
    const tool = createMockTool("delete_file", true);
    registry.register(tool);
    const ctx = createMockContext(false); // denied

    const result = await registry.execute(
      "delete_file",
      { input: "test.ts" },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("denied");
    expect(tool.execute).not.toHaveBeenCalled();
  });

  it("should skip approval for tools that do not require it", async () => {
    const tool = createMockTool("read_file", false);
    registry.register(tool);
    const ctx = createMockContext();

    await registry.execute("read_file", { input: "test" }, ctx);
    expect(ctx.requestApproval).not.toHaveBeenCalled();
    expect(tool.execute).toHaveBeenCalled();
  });

  it("should unregister a tool", () => {
    registry.register(createMockTool("read_file"));
    registry.unregister("read_file");
    expect(registry.get("read_file")).toBeUndefined();
  });
});
