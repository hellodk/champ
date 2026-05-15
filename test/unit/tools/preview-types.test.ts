// Compile-time test: verify the new optional fields exist on the interfaces.
import type { Tool } from "../../../src/tools/types";
import type { ApprovalRequestMessage } from "../../../src/ui/messages";
import { describe, it, expect } from "vitest";

describe("ToolPreview type contracts", () => {
  it("Tool interface accepts optional getPreview method", () => {
    const _tool: Tool = {
      name: "test",
      description: "test",
      parameters: { type: "object", properties: {} },
      requiresApproval: false,
      getPreview: (args) => ({
        type: "command" as const,
        content: String(args.command),
        label: "Run",
      }),
      async execute() {
        return { success: true, output: "" };
      },
    };
    expect(_tool.name).toBe("test");
  });

  it("ApprovalRequestMessage accepts optional preview field", () => {
    const _msg: ApprovalRequestMessage = {
      type: "approvalRequest",
      id: "test-id",
      description: "desc",
      preview: { type: "diff", content: "-old\n+new" },
    };
    expect(_msg.id).toBe("test-id");
  });
});
