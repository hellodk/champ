import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "../../../src/tools/registry";
import type { Tool, ToolExecutionContext } from "../../../src/tools/types";

describe("ToolRegistry.execute preview passthrough", () => {
  it("passes preview to requestApproval when tool has getPreview", async () => {
    const registry = new ToolRegistry();
    const captured: Array<{ description: string; preview?: unknown }> = [];

    const mockTool: Tool = {
      name: "mock_tool",
      description: "mock",
      parameters: { type: "object", properties: {} },
      requiresApproval: true,
      getPreview: (args) => ({
        type: "command" as const,
        content: String(args.cmd),
        label: "Mock",
      }),
      async execute() {
        return { success: true, output: "ok" };
      },
    };
    registry.register(mockTool);

    const ctx: ToolExecutionContext = {
      workspaceRoot: "/tmp",
      abortSignal: new AbortController().signal,
      reportProgress: () => {},
      requestApproval: async (description, preview) => {
        captured.push({ description, preview });
        return true;
      },
    };

    await registry.execute("mock_tool", { cmd: "ls" }, ctx);
    expect(captured).toHaveLength(1);
    expect(captured[0].preview).toEqual({
      type: "command",
      content: "ls",
      label: "Mock",
    });
  });

  it("passes undefined preview when tool has no getPreview", async () => {
    const registry = new ToolRegistry();
    const captured: Array<{ preview?: unknown }> = [];

    const mockTool: Tool = {
      name: "simple_tool",
      description: "simple",
      parameters: { type: "object", properties: {} },
      requiresApproval: true,
      async execute() {
        return { success: true, output: "ok" };
      },
    };
    registry.register(mockTool);

    const ctx: ToolExecutionContext = {
      workspaceRoot: "/tmp",
      abortSignal: new AbortController().signal,
      reportProgress: () => {},
      requestApproval: async (description, preview) => {
        captured.push({ preview });
        return true;
      },
    };

    await registry.execute("simple_tool", {}, ctx);
    expect(captured[0].preview).toBeUndefined();
  });
});
