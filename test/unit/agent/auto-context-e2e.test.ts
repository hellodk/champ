import { describe, it, expect } from "vitest";
import * as path from "path";
import { ContextResolver } from "@/agent/context-resolver";

const WS = path.resolve("/ws");
const MAIN = path.join(WS, "src/main.ts");

describe("ContextResolver.getEditorContext", () => {
  it("returns configured context", () => {
    const resolver = new ContextResolver({
      workspaceRoot: WS,
      indexingService: { search: async () => [] },
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      getEditorContext: () => ({
        selection: "",
        filePath: MAIN,
        language: "typescript",
      }),
    });
    expect(resolver.getEditorContext()?.filePath).toBe(MAIN);
  });

  it("returns undefined when not wired", () => {
    const resolver = new ContextResolver({
      workspaceRoot: WS,
      indexingService: { search: async () => [] },
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
    });
    expect(resolver.getEditorContext()).toBeUndefined();
  });

  it("resolve() returns file content when synthetic file ref is injected", async () => {
    const resolver = new ContextResolver({
      workspaceRoot: WS,
      indexingService: { search: async () => [] },
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      getEditorContext: () => ({
        selection: "",
        filePath: MAIN,
        language: "typescript",
      }),
      fileReader: {
        async readFile(absPath) {
          if (absPath === MAIN) return "export const MAIN = true;";
          throw new Error("not found");
        },
        async readdir() {
          return [];
        },
      },
    });
    const syntheticRef = {
      type: "file" as const,
      value: MAIN,
      start: 0,
      end: 0,
    };
    const resolved = await resolver.resolve([syntheticRef]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].content).toContain("export const MAIN = true;");
  });
});
