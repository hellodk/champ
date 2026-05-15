import { describe, it, expect, vi } from "vitest";
import { MCPClientManager } from "../../../src/mcp/mcp-client";

describe("MCPClientManager.reconnect", () => {
  it("is defined on the class", () => {
    expect(typeof MCPClientManager.prototype.reconnect).toBe("function");
  });

  it("calls sseConnection.reconnect() for SSE connections", async () => {
    const manager = new MCPClientManager();
    const fakeSse = {
      reconnect: vi.fn().mockResolvedValue(undefined),
      tools: [],
      connected: false,
      error: "lost",
      sendRequestInternal: vi.fn().mockResolvedValue({ tools: [] }),
    };
    const fakeConn = {
      config: {
        name: "test-sse",
        transport: "sse" as const,
        url: "http://localhost:9999",
      },
      tools: [],
      process: null,
      nextId: 0,
      pendingRequests: new Map(),
      buffer: "",
      sseConnection: fakeSse,
    };
    (
      manager as unknown as { connections: Map<string, unknown> }
    ).connections.set("test-sse", fakeConn);
    await manager.reconnect("test-sse");
    expect(fakeSse.reconnect).toHaveBeenCalledOnce();
  });

  it("throws for unknown server", async () => {
    const manager = new MCPClientManager();
    await expect(manager.reconnect("nonexistent")).rejects.toThrow(
      /not found/i,
    );
  });
});
