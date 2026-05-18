import { describe, it, expect } from "vitest";
import type { McpServerStatus } from "../../ui/messages";

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
