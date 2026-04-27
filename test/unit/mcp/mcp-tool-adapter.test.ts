import { describe, it, expect, vi } from "vitest";
import { createMcpToolAdapter } from "../../../src/mcp/mcp-tool-adapter";
import type { MCPClientManager, MCPTool } from "../../../src/mcp/mcp-client";
import type { ToolExecutionContext } from "../../../src/tools/types";

function makeManager(
  result = {
    content: [{ type: "text" as const, text: "output" }],
    isError: false,
  },
) {
  return {
    invokeTool: vi.fn().mockResolvedValue(result),
  } as unknown as MCPClientManager;
}

const ctx: ToolExecutionContext = {
  workspaceRoot: "/tmp",
  abortSignal: new AbortController().signal,
  reportProgress: vi.fn(),
  requestApproval: vi.fn().mockResolvedValue(true),
};

const mcpTool: MCPTool = {
  name: "list_issues",
  description: "List GitHub issues",
  inputSchema: {
    type: "object",
    properties: { repo: { type: "string" } },
    required: ["repo"],
  },
};

describe("createMcpToolAdapter", () => {
  it("maps MCPTool name and description to Tool", () => {
    const tool = createMcpToolAdapter("github", mcpTool, makeManager());
    expect(tool.name).toBe("mcp_github_list_issues");
    expect(tool.description).toContain("List GitHub issues");
    expect(tool.description).toContain("[MCP: github]");
  });

  it("maps inputSchema to parameters", () => {
    const tool = createMcpToolAdapter("github", mcpTool, makeManager());
    expect(tool.parameters).toEqual(mcpTool.inputSchema);
  });

  it("requiresApproval is true by default", () => {
    const tool = createMcpToolAdapter("github", mcpTool, makeManager());
    expect(tool.requiresApproval).toBe(true);
  });

  it("executes by calling invokeTool and returns text output", async () => {
    const manager = makeManager();
    const tool = createMcpToolAdapter("github", mcpTool, manager);
    const result = await tool.execute({ repo: "hellodk/champ" }, ctx);
    expect(manager.invokeTool).toHaveBeenCalledWith("github", "list_issues", {
      repo: "hellodk/champ",
    });
    expect(result.success).toBe(true);
    expect(result.output).toBe("output");
  });

  it("returns success=false and error text when isError=true", async () => {
    const manager = makeManager({
      content: [{ type: "text", text: "not found" }],
      isError: true,
    });
    const tool = createMcpToolAdapter("github", mcpTool, manager);
    const result = await tool.execute({ repo: "x" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("not found");
  });

  it("joins multiple content blocks with newlines", async () => {
    const manager = makeManager({
      content: [
        { type: "text", text: "part1" },
        { type: "text", text: "part2" },
      ],
      isError: false,
    });
    const tool = createMcpToolAdapter("github", mcpTool, manager);
    const result = await tool.execute({}, ctx);
    expect(result.output).toBe("part1\npart2");
  });

  it("ignores non-text content blocks", async () => {
    const manager = makeManager({
      content: [
        { type: "image", data: "base64...", mimeType: "image/png" },
        { type: "text", text: "summary" },
      ],
      isError: false,
    });
    const tool = createMcpToolAdapter("github", mcpTool, manager);
    const result = await tool.execute({}, ctx);
    expect(result.output).toBe("summary");
  });
});
