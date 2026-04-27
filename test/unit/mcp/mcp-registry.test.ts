import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpRegistry } from "../../../src/mcp/mcp-registry";
import type { ToolRegistry } from "../../../src/tools/registry";

function makeToolRegistry() {
  const registered = new Map<string, unknown>();
  return {
    register: vi.fn((tool: { name: string }) =>
      registered.set(tool.name, tool),
    ),
    unregister: vi.fn((name: string) => registered.delete(name)),
    registered,
  } as unknown as ToolRegistry & { registered: Map<string, unknown> };
}

function makeMcpTools(names: string[]) {
  return names.map((n) => ({
    name: n,
    description: `Tool ${n}`,
    inputSchema: { type: "object", properties: {}, required: [] },
  }));
}

function makeManager(
  toolNames: string[] = [],
  connectedServers: string[] = [],
) {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectAll: vi.fn(),
    listTools: vi.fn().mockResolvedValue(makeMcpTools(toolNames)),
    getConnectedServers: vi.fn().mockReturnValue(connectedServers),
  };
}

const fakeSecrets = { get: vi.fn().mockResolvedValue(undefined) };

describe("McpRegistry", () => {
  it("connects new servers and registers their tools", async () => {
    const registry = makeToolRegistry();
    const manager = makeManager(["list_issues"]);
    const mcpRegistry = new McpRegistry(
      manager as never,
      registry,
      fakeSecrets as never,
    );

    await mcpRegistry.loadServers([
      { name: "github", command: "npx", args: [] },
    ]);

    expect(manager.connect).toHaveBeenCalledOnce();
    const toolName = (registry.register as ReturnType<typeof vi.fn>).mock
      .calls[0][0].name;
    expect(toolName).toBe("mcp_github_list_issues");
  });

  it("disconnects removed servers and unregisters their tools", async () => {
    const registry = makeToolRegistry();
    // First call: nothing connected; second call: github is connected
    const manager = makeManager(["list_issues"]);
    (manager.getConnectedServers as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce([])
      .mockReturnValue(["github"]);

    const mcpRegistry = new McpRegistry(
      manager as never,
      registry,
      fakeSecrets as never,
    );

    // Connect github
    await mcpRegistry.loadServers([
      { name: "github", command: "npx", args: [] },
    ]);
    // Remove github
    await mcpRegistry.loadServers([]);

    expect(manager.disconnect).toHaveBeenCalledWith("github");
    expect(registry.unregister).toHaveBeenCalledWith("mcp_github_list_issues");
  });

  it("skips servers already connected (no reconnect on reload)", async () => {
    const registry = makeToolRegistry();
    const manager = makeManager([], ["github"]); // github already connected
    const mcpRegistry = new McpRegistry(
      manager as never,
      registry,
      fakeSecrets as never,
    );

    await mcpRegistry.loadServers([
      { name: "github", command: "npx", args: [] },
    ]);

    expect(manager.connect).not.toHaveBeenCalled();
  });

  it("disposeAll disconnects everything and unregisters all tools", async () => {
    const registry = makeToolRegistry();
    const manager = makeManager(["t1"]);
    const mcpRegistry = new McpRegistry(
      manager as never,
      registry,
      fakeSecrets as never,
    );

    await mcpRegistry.loadServers([{ name: "srv", command: "cmd", args: [] }]);
    await mcpRegistry.disposeAll();

    expect(manager.disconnectAll).toHaveBeenCalledOnce();
    expect(registry.unregister).toHaveBeenCalledWith("mcp_srv_t1");
  });

  it("continues connecting other servers when one fails", async () => {
    const registry = makeToolRegistry();
    const manager = makeManager(["tool_b"]);
    (manager.connect as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("timeout")) // first server fails
      .mockResolvedValue(undefined); // second succeeds

    const mcpRegistry = new McpRegistry(
      manager as never,
      registry,
      fakeSecrets as never,
    );

    await mcpRegistry.loadServers([
      { name: "bad", command: "bad-cmd", args: [] },
      { name: "good", command: "good-cmd", args: [] },
    ]);

    // bad failed, good succeeded — good's tool registered
    const calls = (registry.register as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(1);
    expect(calls[0][0].name).toBe("mcp_good_tool_b");
  });
});
