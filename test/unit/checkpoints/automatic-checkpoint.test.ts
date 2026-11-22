/**
 * A mutating tool must checkpoint the files it is about to change before any
 * filesystem write occurs.
 */
import { describe, it, expect, vi } from "vitest";
import { ToolRegistry } from "@/tools/registry";
import type { Tool, ToolExecutionContext } from "@/tools/types";
import { editFileTool } from "@/tools/edit-file";
import { createFileTool } from "@/tools/create-file";
import { deleteFileTool } from "@/tools/delete-file";

const editingTool: Tool = {
  name: "edit_file",
  description: "edit",
  parameters: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  },
  requiresApproval: true,
  mutationPaths: (args) => (typeof args.path === "string" ? [args.path] : []),
  execute: vi.fn(async () => ({ success: true, output: "ok" })),
};

function context(onBeforeMutation: () => Promise<void>): ToolExecutionContext {
  return {
    workspaceRoot: process.cwd(),
    abortSignal: new AbortController().signal,
    reportProgress: vi.fn(),
    requestApproval: vi.fn().mockResolvedValue(true),
    onBeforeMutation,
  };
}

describe("automatic mutation checkpoints", () => {
  it("declares the target path on every mutating tool", () => {
    for (const tool of [editFileTool, createFileTool, deleteFileTool]) {
      expect(tool.mutationPaths).toBeDefined();
      expect(tool.mutationPaths?.({ path: "src/app.ts" })).toEqual([
        "src/app.ts",
      ]);
      expect(tool.mutationPaths?.({})).toEqual([]);
    }
  });

  it("checkpoints declared paths before executing the mutation", async () => {
    const order: string[] = [];
    const registry = new ToolRegistry();
    registry.register(editingTool);
    const result = await registry.execute(
      "edit_file",
      { path: "src/file.ts" },
      context(async () => {
        order.push("checkpoint");
      }),
    );
    (editingTool.execute as ReturnType<typeof vi.fn>).mock.results;
    expect(result.success).toBe(true);
    expect(order).toEqual(["checkpoint"]);
  });

  it("does not execute the mutation when checkpointing fails", async () => {
    const registry = new ToolRegistry();
    const tool = {
      ...editingTool,
      name: "delete_file",
      execute: vi.fn(async () => ({ success: true, output: "ok" })),
    } as Tool;
    registry.register(tool);
    const result = await registry.execute(
      "delete_file",
      { path: "src/file.ts" },
      context(async () => {
        throw new Error("checkpoint write failed");
      }),
    );
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/checkpoint/i);
    expect(tool.execute).not.toHaveBeenCalled();
  });
});
