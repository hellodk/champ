import { describe, it, expect } from "vitest";
import { McpRegistry } from "../../../src/mcp/mcp-registry";

describe("McpRegistry.reconnect signature", () => {
  it("is a function", () => {
    expect(typeof McpRegistry.prototype.reconnect).toBe("function");
  });
});
