/**
 * TDD: Tool-call robustness (issue #106).
 *
 * Contracts:
 * 1. Registry validates args against the tool's declared JSON schema BEFORE
 *    approval/execute; failures return an actionable message and the tool
 *    never runs.
 * 2. parseToolCallsFromText reports malformed argument JSON instead of
 *    dropping it silently.
 * 3. ToolCallingLoop caches under the SAME key it looks up.
 */
import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "@/tools/registry";
import type { Tool, ToolResult, ToolExecutionContext } from "@/tools/types";
import type { ToolParameterSchema } from "@/providers/types";
import { parseToolCallsFromText } from "@/providers/prompt-based-tools";

function makeContext(): ToolExecutionContext {
  return {
    workspaceRoot: "/tmp",
    abortSignal: new AbortController().signal,
    reportProgress: () => {},
    requestApproval: async () => true,
  };
}

const schema: ToolParameterSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "file path" },
    limit: { type: "number", description: "line limit" },
  },
  required: ["path"],
};

function makeTool(
  executed: Array<Record<string, unknown>>,
  parameters?: ToolParameterSchema,
): Tool {
  return {
    name: "read_file",
    description: "test",
    parameters: parameters ?? { type: "object", properties: {}, required: [] },
    requiresApproval: false,
    execute: async (args) => {
      executed.push(args);
      return { success: true, output: "ok" };
    },
  } as unknown as Tool;
}

describe("registry arg validation (#106)", () => {
  it("rejects missing required args with an actionable message", async () => {
    const executed: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry();
    registry.register(makeTool(executed, schema));

    const result = await registry.execute("read_file", {}, makeContext());

    expect(result.success).toBe(false);
    expect(result.output).toContain("path");
    expect(executed).toEqual([]);
  });

  it("rejects wrong-typed args naming the field", async () => {
    const executed: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry();
    registry.register(makeTool(executed, schema));

    const result = await registry.execute(
      "read_file",
      { path: "a.ts", limit: "ten" },
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("limit");
    expect(executed).toEqual([]);
  });

  it("allows valid args through untouched", async () => {
    const executed: Array<Record<string, unknown>> = [];
    const registry = new ToolRegistry();
    registry.register(makeTool(executed, schema));

    const result = await registry.execute(
      "read_file",
      { path: "a.ts" },
      makeContext(),
    );

    expect(result.success).toBe(true);
    expect(executed).toEqual([{ path: "a.ts" }]);
  });
});

describe("malformed tool-call reporting (#106)", () => {
  it("parseToolCallsFromText surfaces malformed XML arguments via callback", () => {
    const malformed: Array<{ name: string; reason: string }> = [];
    const calls = parseToolCallsFromText(
      '<tool_call><name>read_file</name><arguments>{"path": </arguments></tool_call>',
      (info) => malformed.push(info),
    );

    expect(calls).toHaveLength(0);
    expect(malformed).toHaveLength(1);
    expect(malformed[0].name).toBe("read_file");
    expect(malformed[0].reason).toBeTruthy();
  });

  it("still parses valid calls when no callback is provided (back-compat)", () => {
    const calls = parseToolCallsFromText(
      '<tool_call><name>read_file</name><arguments>{"path":"a.ts"}</arguments></tool_call>',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].arguments).toEqual({ path: "a.ts" });
  });
});
