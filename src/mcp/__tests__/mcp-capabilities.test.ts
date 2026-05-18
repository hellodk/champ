import { describe, it, expect } from "vitest";
import type { McpServerStatus } from "../../ui/messages";
import { MCPSSEConnection, MCPClientManager } from "../../mcp/mcp-client";

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
