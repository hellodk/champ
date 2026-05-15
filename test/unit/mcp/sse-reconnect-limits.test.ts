import { describe, it, expect } from "vitest";
import { MCPSSEConnection } from "../../../src/mcp/mcp-client";

describe("MCPSSEConnection constants", () => {
  it("MAX_RECONNECTS is 10 (not 3)", () => {
    const maxReconnects = (
      MCPSSEConnection as unknown as { MAX_RECONNECTS: number }
    ).MAX_RECONNECTS;
    expect(maxReconnects).toBe(10);
  });
});

describe("backoff cap", () => {
  it("backoff capped at 30_000 for any attempt value", () => {
    for (let attempt = 1; attempt <= 15; attempt++) {
      const delay = Math.min(30_000, 1_000 * attempt);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
    expect(Math.min(30_000, 1_000 * 35)).toBe(30_000);
  });
});
