import { describe, it, expect } from "vitest";
import { ContextResolver } from "@/agent/context-resolver";

describe("ContextResolver.getEditorContext", () => {
  it("returns configured context", () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: async () => [] },
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      getEditorContext: () => ({
        selection: "",
        filePath: "/ws/src/main.ts",
        language: "typescript",
      }),
    });
    expect(resolver.getEditorContext()?.filePath).toBe("/ws/src/main.ts");
  });

  it("returns undefined when not wired", () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: async () => [] },
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
    });
    expect(resolver.getEditorContext()).toBeUndefined();
  });

  it("resolve() returns file content when synthetic file ref is injected", async () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: async () => [] },
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      getEditorContext: () => ({
        selection: "",
        filePath: "/ws/src/main.ts",
        language: "typescript",
      }),
      fileReader: {
        async readFile(absPath) {
          if (absPath === "/ws/src/main.ts") return "export const MAIN = true;";
          throw new Error("not found");
        },
        async readdir() {
          return [];
        },
      },
    });
    const syntheticRef = {
      type: "file" as const,
      value: "/ws/src/main.ts",
      start: 0,
      end: 0,
    };
    const resolved = await resolver.resolve([syntheticRef]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].content).toContain("export const MAIN = true;");
  });
});
