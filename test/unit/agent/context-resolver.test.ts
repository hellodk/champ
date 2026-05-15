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

  it("should format @Codebase results as readable code chunks", async () => {
    const mockResults = [
      {
        filePath: "src/auth.ts",
        chunkText:
          "export function validateToken(token: string): User | null {",
        startLine: 42,
        endLine: 50,
        chunkType: "function",
        score: 0.92,
      },
    ];
    const resolver = new ContextResolver({
      workspaceRoot: "/workspace",
      indexingService: { search: vi.fn().mockResolvedValue(mockResults) },
      webSearchTool: { execute: vi.fn() },
    });
    const resolved = await resolver.resolve([
      { type: "codebase", value: "token validation", start: 0, end: 10 },
    ]);
    expect(resolved[0].content).toContain("src/auth.ts");
    expect(resolved[0].content).toContain("validateToken");
    expect(resolved[0].content).toContain("42");
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

  it("should resolve @Files to actual file content when fileReader is provided", async () => {
    const mockReadFile = vi.fn().mockResolvedValue("export const x = 1;");
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: vi.fn().mockResolvedValue([]) },
      webSearchTool: { execute: vi.fn() },
      fileReader: {
        readFile: mockReadFile,
        readdir: vi.fn().mockResolvedValue([["index.ts", "file"]]),
      },
    });
    const resolved = await resolver.resolve([
      { type: "file", value: "src/index.ts", start: 0, end: 0 },
    ]);
    expect(resolved[0].content).toBe("export const x = 1;");
    expect(mockReadFile).toHaveBeenCalledWith("/ws/src/index.ts");
  });

  it("should resolve @Folders to directory listing when fileReader is provided", async () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: vi.fn().mockResolvedValue([]) },
      webSearchTool: { execute: vi.fn() },
      fileReader: {
        readFile: vi.fn(),
        readdir: vi.fn().mockResolvedValue([
          ["a.ts", "file"],
          ["utils", "directory"],
        ]),
      },
    });
    const resolved = await resolver.resolve([
      { type: "folder", value: "src", start: 0, end: 0 },
    ]);
    expect(resolved[0].content).toContain("a.ts");
    expect(resolved[0].content).toContain("utils/");
  });

  it("should fall back to placeholder when fileReader is absent", async () => {
    const resolved = await resolver.resolve([
      { type: "file", value: "src/main.ts", start: 0, end: 0 },
    ]);
    expect(resolved[0].content).toContain("[File reference");
  });

  it("should handle @Folders readdir failure gracefully", async () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: vi.fn().mockResolvedValue([]) },
      webSearchTool: { execute: vi.fn() },
      fileReader: {
        readFile: vi.fn(),
        readdir: vi.fn().mockRejectedValue(new Error("ENOENT")),
      },
    });
    const resolved = await resolver.resolve([
      { type: "folder", value: "nonexistent", start: 0, end: 0 },
    ]);
    expect(resolved[0].content).toContain("could not list");
  });

  it("should resolve @Code to editor selection when getEditorContext is provided", async () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: vi.fn().mockResolvedValue([]) },
      webSearchTool: { execute: vi.fn() },
      getEditorContext: () => ({
        selection: "const foo = 42;",
        filePath: "src/foo.ts",
        language: "typescript",
      }),
    });
    const resolved = await resolver.resolve([
      { type: "code", value: "", start: 0, end: 0 },
    ]);
    expect(resolved[0].content).toContain("const foo = 42;");
    expect(resolved[0].content).toContain("src/foo.ts");
  });

  it("should resolve @Code to placeholder when no editor context", async () => {
    const resolved = await resolver.resolve([
      { type: "code", value: "", start: 0, end: 0 },
    ]);
    expect(resolved[0].content).toContain("[Current editor");
  });

  it("should resolve @Git to shell output when runShellCommand is provided", async () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: vi.fn().mockResolvedValue([]) },
      webSearchTool: { execute: vi.fn() },
      runShellCommand: vi.fn().mockResolvedValue("M src/foo.ts\n"),
    });
    const resolved = await resolver.resolve([
      { type: "git", value: "", start: 0, end: 0 },
    ]);
    expect(resolved[0].content).toContain("M src/foo.ts");
  });

  it("should resolve @Git to placeholder when runShellCommand absent", async () => {
    const resolved = await resolver.resolve([
      { type: "git", value: "", start: 0, end: 0 },
    ]);
    expect(resolved[0].content).toContain("[Git context");
  });

  it("should resolve @Symbols to symbol list when workspaceSymbols is provided", async () => {
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: vi.fn().mockResolvedValue([]) },
      webSearchTool: { execute: vi.fn() },
      workspaceSymbols: vi.fn().mockResolvedValue([
        {
          name: "authenticate",
          filePath: "src/auth.ts",
          kind: "Function",
          line: 12,
        },
      ]),
    });
    const resolved = await resolver.resolve([
      { type: "symbol", value: "auth", start: 0, end: 0 },
    ]);
    expect(resolved[0].content).toContain("authenticate");
    expect(resolved[0].content).toContain("src/auth.ts");
    expect(resolved[0].content).toContain("12");
  });

  it("should block @Files path traversal attempts", async () => {
    const mockReadFile = vi.fn();
    const resolver = new ContextResolver({
      workspaceRoot: "/ws",
      indexingService: { search: vi.fn().mockResolvedValue([]) },
      webSearchTool: { execute: vi.fn() },
      fileReader: {
        readFile: mockReadFile,
        readdir: vi.fn().mockResolvedValue([]),
      },
    });
    const resolved = await resolver.resolve([
      { type: "file", value: "../../etc/passwd", start: 0, end: 0 },
    ]);
    expect(resolved[0].content).toContain("path outside workspace");
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  describe("@Docs resolver", () => {
    it("returns README content when docsReader resolves the package", async () => {
      const resolver = new ContextResolver({
        workspaceRoot: "/ws",
        indexingService: { search: vi.fn().mockResolvedValue([]) },
        webSearchTool: { execute: vi.fn() },
        docsReader: {
          readPackageDocs: vi
            .fn()
            .mockResolvedValue("# React\nA JavaScript library."),
        },
      });
      const resolved = await resolver.resolve([
        { type: "docs", value: "react", start: 0, end: 0 },
      ]);
      expect(resolved[0].content).toContain("React");
      expect(resolved[0].content).toContain("A JavaScript library");
    });

    it("returns helpful message when package not found in node_modules", async () => {
      const resolver = new ContextResolver({
        workspaceRoot: "/ws",
        indexingService: { search: vi.fn().mockResolvedValue([]) },
        webSearchTool: { execute: vi.fn() },
        docsReader: {
          readPackageDocs: vi.fn().mockResolvedValue(null),
        },
      });
      const resolved = await resolver.resolve([
        { type: "docs", value: "nonexistent-pkg", start: 0, end: 0 },
      ]);
      expect(resolved[0].content).toContain("not found");
      expect(resolved[0].content).toContain("nonexistent-pkg");
    });

    it("falls back gracefully when docsReader is not provided", async () => {
      const resolver = new ContextResolver({
        workspaceRoot: "/ws",
        indexingService: { search: vi.fn().mockResolvedValue([]) },
        webSearchTool: { execute: vi.fn() },
      });
      const resolved = await resolver.resolve([
        { type: "docs", value: "react", start: 0, end: 0 },
      ]);
      // Falls back to stub behavior
      expect(resolved[0].content).toBeDefined();
    });
  });
});
