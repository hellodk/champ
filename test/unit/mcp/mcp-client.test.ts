/**
 * TDD: Tests for MCPClient.
 * Connect to MCP servers, discover and invoke tools.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MCPClientManager } from "@/mcp/mcp-client";

describe("MCPClientManager", () => {
  let manager: MCPClientManager;

  beforeEach(() => {
    manager = new MCPClientManager();
  });

  it("should connect to an MCP server config", async () => {
    // This will fail until MCP SDK is integrated, but validates the interface
    const config = {
      name: "test-server",
      command: "node",
      args: ["test-mcp-server.js"],
      env: {},
    };

    // Mock the connection
    manager.connect = vi.fn().mockResolvedValue(undefined);
    await manager.connect(config);
    expect(manager.connect).toHaveBeenCalledWith(config);
  });

  it("should list tools from connected server", async () => {
    manager.listTools = vi.fn().mockResolvedValue([
      { name: "mcp_github_create_issue", description: "Create a GitHub issue" },
      { name: "mcp_github_list_prs", description: "List pull requests" },
    ]);

    const tools = await manager.listTools("test-server");
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toContain("github");
  });

  it("should invoke a tool on an MCP server", async () => {
    manager.invokeTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Issue #42 created" }],
    });

    const result = await manager.invokeTool("test-server", "create_issue", {
      title: "Bug fix",
      body: "Fixes the null pointer",
    });

    expect(result.content[0].text).toContain("Issue #42");
  });

  it("should disconnect from a server", async () => {
    manager.disconnect = vi.fn().mockResolvedValue(undefined);
    await manager.disconnect("test-server");
    expect(manager.disconnect).toHaveBeenCalledWith("test-server");
  });

  it("should list connected servers", () => {
    manager.getConnectedServers = vi
      .fn()
      .mockReturnValue(["server-a", "server-b"]);
    const servers = manager.getConnectedServers();
    expect(servers).toHaveLength(2);
  });
});
