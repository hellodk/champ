import { describe, it, expect, vi } from "vitest";
import type { McpServerStatus } from "../../ui/messages";
import { MCPSSEConnection, MCPClientManager } from "../../mcp/mcp-client";
import { McpRegistry } from "../../mcp/mcp-registry";
import type { ToolRegistry } from "../../tools/registry";

describe("McpServerStatus", () => {
  it("includes resourceCount and promptCount fields", () => {
    const status: McpServerStatus = {
      name: "test-server",
      connected: true,
      toolCount: 3,
      resourceCount: 5,
      promptCount: 2,
    };
    expect(status.resourceCount).toBe(5);
    expect(status.promptCount).toBe(2);
  });
});

describe("MCPSSEConnection auth", () => {
  it("injects Authorization header from bearer auth config", () => {
    const conn = new MCPSSEConnection("http://example.com", {
      type: "bearer",
      token: "tok_abc123",
    });
    // Access private extraHeaders via type cast for testing
    const headers = (
      conn as unknown as { extraHeaders: Record<string, string> }
    ).extraHeaders;
    expect(headers["Authorization"]).toBe("Bearer tok_abc123");
  });

  it("injects custom header from header auth config", () => {
    const conn = new MCPSSEConnection("http://example.com", {
      type: "header",
      name: "X-Api-Key",
      value: "secret",
    });
    const headers = (
      conn as unknown as { extraHeaders: Record<string, string> }
    ).extraHeaders;
    expect(headers["X-Api-Key"]).toBe("secret");
  });
});

describe("MCPClientManager capability negotiation", () => {
  it("getCapabilities returns empty object for unknown server", () => {
    const manager = new MCPClientManager();
    expect(manager.getCapabilities("unknown")).toEqual({});
  });
});

describe("McpRegistry resource/prompt counts", () => {
  it("getStatus includes resourceCount from server", async () => {
    const mockManager = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      // Return empty initially (server not yet connected), so loadServers will connect it
      getConnectedServers: vi.fn().mockReturnValue([]),
      listTools: vi.fn().mockResolvedValue([]),
      listResources: vi.fn().mockResolvedValue([
        { uri: "file://a", name: "a" },
        { uri: "file://b", name: "b" },
      ]),
      listPrompts: vi.fn().mockResolvedValue([{ name: "p1" }]),
      onServerExit: undefined,
    };
    const mockToolRegistry = {
      register: vi.fn(),
      unregister: vi.fn(),
    } as unknown as ToolRegistry;
    const mockSecretStorage = { get: vi.fn().mockResolvedValue(undefined) };

    const registry = new McpRegistry(
      mockManager as never,
      mockToolRegistry,
      mockSecretStorage,
    );
    await registry.loadServers([
      { name: "srv", command: "echo", transport: "stdio" },
    ]);

    const status = registry.getStatus();
    expect(status[0].resourceCount).toBe(2);
    expect(status[0].promptCount).toBe(1);
  });
});
