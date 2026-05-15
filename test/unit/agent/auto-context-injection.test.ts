import { describe, it, expect } from "vitest";
import { ContextResolver } from "@/agent/context-resolver";

describe("auto-context injection logic", () => {
  it("parseReferences returns empty array for plain message", () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: async () => [] },
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
    });
    const refs = resolver.parseReferences("what does this do?");
    expect(refs).toHaveLength(0);
  });

  it("parseReferences returns non-empty for @Code message", () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: async () => [] },
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      getEditorContext: () => ({
        selection: "code",
        filePath: "/ws/a.ts",
        language: "typescript",
      }),
    });
    const refs = resolver.parseReferences("explain @Code");
    expect(refs.length).toBeGreaterThan(0);
  });

  it("getEditorContext returns filePath when wired", () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: async () => [] },
      webSearchTool: { execute: async () => ({ success: true, output: "" }) },
      getEditorContext: () => ({
        selection: "",
        filePath: "/ws/src/active.ts",
        language: "typescript",
      }),
    });
    expect(resolver.getEditorContext()?.filePath).toBe("/ws/src/active.ts");
  });
});
