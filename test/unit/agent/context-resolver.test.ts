/**
 * TDD: Tests for ContextResolver.
 * @-symbol resolution: @Files, @Folders, @Code, @Symbols, @Codebase, @Web, @Git, @Docs.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ContextResolver } from "@/agent/context-resolver";

describe("ContextResolver", () => {
  let resolver: ContextResolver;

  beforeEach(() => {
    resolver = new ContextResolver({
      workspaceRoot: "/test-workspace",
      indexingService: { search: vi.fn().mockResolvedValue([]) } as any,
      webSearchTool: {
        execute: vi
          .fn()
          .mockResolvedValue({ success: true, output: "Web results" }),
      } as any,
    });
  });

  it("should parse @Files references from message", () => {
    const refs = resolver.parseReferences(
      "Look at @Files(src/main.ts) for context",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("file");
    expect(refs[0].value).toBe("src/main.ts");
  });

  it("should parse @Folders references", () => {
    const refs = resolver.parseReferences(
      "Check @Folders(src/utils) for helpers",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("folder");
    expect(refs[0].value).toBe("src/utils");
  });

  it("should parse @Codebase references", () => {
    const refs = resolver.parseReferences(
      "@Codebase how does authentication work?",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("codebase");
  });

  it("should parse @Web references", () => {
    const refs = resolver.parseReferences("@Web latest React hooks patterns");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("web");
  });

  it("should parse @Git references", () => {
    const refs = resolver.parseReferences("@Git show recent changes");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("git");
  });

  it("should parse multiple references in one message", () => {
    const refs = resolver.parseReferences(
      "Compare @Files(a.ts) with @Files(b.ts) using @Codebase search",
    );
    expect(refs).toHaveLength(3);
  });

  it("should resolve @Files to file content", async () => {
    const resolved = await resolver.resolve([
      { type: "file", value: "src/main.ts" },
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].type).toBe("file");
  });

  it("should resolve @Codebase to semantic search results", async () => {
    const resolved = await resolver.resolve([
      { type: "codebase", value: "authentication" },
    ]);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].type).toBe("codebase");
  });

  it("should return empty for message with no references", () => {
    const refs = resolver.parseReferences(
      "Just a normal message with no @ symbols",
    );
    expect(refs).toHaveLength(0);
  });

  it("should provide autocomplete suggestions for @ prefix", () => {
    const suggestions = resolver.getAutocompleteSuggestions("@Fi");
    expect(suggestions.some((s) => s.label === "@Files")).toBe(true);
  });

  it("should provide all suggestions for bare @", () => {
    const suggestions = resolver.getAutocompleteSuggestions("@");
    expect(suggestions.length).toBeGreaterThanOrEqual(7); // Files, Folders, Code, Symbols, Codebase, Web, Git, Docs
  });
});
