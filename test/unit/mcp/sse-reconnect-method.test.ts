import { describe, it, expect, vi } from "vitest";
import { MCPSSEConnection } from "../../../src/mcp/mcp-client";

describe("MCPSSEConnection.reconnect", () => {
  it("is a callable method on the class", () => {
    expect(typeof MCPSSEConnection.prototype.reconnect).toBe("function");
  });

  it("resets state and calls connect()", async () => {
    const conn = new MCPSSEConnection("http://localhost:9999");
    (conn as unknown as { reconnectAttempts: number }).reconnectAttempts = 10;
    (conn as unknown as { error: string }).error = "SSE connection lost";
    (conn as unknown as { connected: boolean }).connected = false;
    const connectSpy = vi.spyOn(conn, "connect").mockResolvedValue(undefined);
    await conn.reconnect();
    expect(connectSpy).toHaveBeenCalledOnce();
    expect(
      (conn as unknown as { reconnectAttempts: number }).reconnectAttempts,
    ).toBe(0);
    expect(
      (conn as unknown as { error: string | undefined }).error,
    ).toBeUndefined();
  });
});
