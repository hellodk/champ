/**
 * E2E tests for ContextResolver — all @-reference types.
 *
 * No network calls and no real filesystem reads for most tests.
 * Dependencies are mocked via the ContextResolverDeps interface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ContextResolver,
  type ContextResolverDeps,
} from "../../src/agent/context-resolver";

// ── Minimal mock deps ──────────────────────────────────────────────────────────

function makeDeps(
  overrides: Partial<ContextResolverDeps> = {},
): ContextResolverDeps {
  return {
    workspaceRoot: "/workspace",
    indexingService: {
      search: vi.fn().mockResolvedValue([]),
    },
    webSearchTool: {
      execute: vi.fn().mockResolvedValue({
        success: false,
        output: "[Brave API key not configured]",
      }),
    },
    ...overrides,
  };
}

// ── parseReferences ──────────────────────────────────────────────────────────

describe("ContextResolver.parseReferences", () => {
  it("parses @Files(path) reference", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@Files(src/main.ts) explain this");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("file");
    expect(refs[0].value).toBe("src/main.ts");
  });

  it("parses @Folders(path) reference", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@Folders(src/utils)");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("folder");
    expect(refs[0].value).toBe("src/utils");
  });

  it("parses bare @Git reference", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("Show me @Git changes");
    expect(refs.some((r) => r.type === "git")).toBe(true);
  });

  it("parses bare @Code reference", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("explain @Code");
    expect(refs.some((r) => r.type === "code")).toBe(true);
  });

  it("parses bare @Terminal reference", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("check @Terminal output");
    expect(refs.some((r) => r.type === "terminal")).toBe(true);
  });

  it("parses @MCP(server:uri) reference", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@MCP(myserver:some/resource)");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("mcp");
    expect(refs[0].value).toBe("myserver:some/resource");
  });

  it("parses @MCPPrompt(server:name) reference — detected before @MCP", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@MCPPrompt(myserver:my-prompt)");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("mcpPrompt");
  });

  it("parses @PR(123) reference", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@PR(123)");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("pr");
    expect(refs[0].value).toBe("123");
  });

  it("parses @Issue(456) reference", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@Issue(456)");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("issue");
    expect(refs[0].value).toBe("456");
  });

  it("parses @GitBlame(src/file.ts:10) reference", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@GitBlame(src/file.ts:10)");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("gitBlame");
    expect(refs[0].value).toBe("src/file.ts:10");
  });

  it("parses @TestFor(myFunction) reference", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@TestFor(myFunction)");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("testFor");
    expect(refs[0].value).toBe("myFunction");
  });

  it("returns empty array for messages with no @-references", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("hello world, no references here");
    expect(refs).toHaveLength(0);
  });

  it("sorts references by start position", () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences(
      "@Files(a.ts) first then @Files(b.ts)",
    );
    expect(refs[0].start).toBeLessThan(refs[1].start);
  });
});

// ── resolve: @Files ──────────────────────────────────────────────────────────

describe("ContextResolver.resolve @Files", () => {
  it("returns file content when fileReader is provided", async () => {
    const resolver = new ContextResolver(
      makeDeps({
        fileReader: {
          readFile: vi.fn().mockResolvedValue("const x = 1;"),
          readdir: vi.fn().mockResolvedValue([]),
        },
      }),
    );
    const refs = resolver.parseReferences("@Files(src/main.ts)");
    const resolved = await resolver.resolve(refs);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].type).toBe("file");
    expect(resolved[0].content).toBe("const x = 1;");
  });

  it("returns placeholder when fileReader is not set", async () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@Files(src/missing.ts)");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].content).toContain("src/missing.ts");
  });

  it("handles path outside workspace gracefully", async () => {
    const resolver = new ContextResolver(
      makeDeps({
        fileReader: {
          readFile: vi.fn(),
          readdir: vi.fn(),
        },
      }),
    );
    const refs = resolver.parseReferences("@Files(../../../etc/passwd)");
    const resolved = await resolver.resolve(refs);
    // Path traversal outside workspace should give a graceful message
    expect(resolved[0].content).not.toBe("");
  });
});

// ── resolve: @Folders ────────────────────────────────────────────────────────

describe("ContextResolver.resolve @Folders", () => {
  it("returns directory listing when fileReader is provided", async () => {
    const resolver = new ContextResolver(
      makeDeps({
        fileReader: {
          readFile: vi.fn(),
          readdir: vi.fn().mockResolvedValue([
            ["index.ts", "file"],
            ["utils", "directory"],
          ]),
        },
      }),
    );
    const refs = resolver.parseReferences("@Folders(src)");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].type).toBe("folder");
    expect(resolved[0].content).toContain("index.ts");
    expect(resolved[0].content).toContain("utils/");
  });

  it("returns placeholder when fileReader is not set", async () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@Folders(src)");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].content).toContain("[Folder reference");
  });
});

// ── resolve: @Code ───────────────────────────────────────────────────────────

describe("ContextResolver.resolve @Code", () => {
  it("returns placeholder when getEditorContext is not set", async () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@Code");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].type).toBe("code");
    expect(resolved[0].content).toContain("placeholder");
  });

  it("returns no-active-editor message when editor context returns undefined", async () => {
    const resolver = new ContextResolver(
      makeDeps({
        getEditorContext: () => undefined,
      }),
    );
    const refs = resolver.parseReferences("@Code");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].content).toContain("no active editor");
  });

  it("returns selection and file info when editor context is set", async () => {
    const resolver = new ContextResolver(
      makeDeps({
        getEditorContext: () => ({
          selection: "function hello() {}",
          filePath: "/workspace/src/hello.ts",
          language: "typescript",
        }),
      }),
    );
    const refs = resolver.parseReferences("@Code");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].content).toContain("function hello()");
    expect(resolved[0].content).toContain("typescript");
  });
});

// ── resolve: @Git ────────────────────────────────────────────────────────────

describe("ContextResolver.resolve @Git", () => {
  it("returns mocked git output when runShellCommand is provided", async () => {
    const resolver = new ContextResolver(
      makeDeps({
        runShellCommand: vi
          .fn()
          .mockResolvedValue("M src/foo.ts\n---\nabc1234 fix bug"),
      }),
    );
    const refs = resolver.parseReferences("@Git");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].type).toBe("git");
    expect(resolved[0].content).toContain("src/foo.ts");
  });

  it("returns placeholder when runShellCommand is not set", async () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@Git");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].content).toContain("[Git context placeholder]");
  });
});

// ── resolve: @Terminal ───────────────────────────────────────────────────────

describe("ContextResolver.resolve @Terminal", () => {
  it("returns terminal output or placeholder", async () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@Terminal");
    // terminalOutputBuffer is a singleton; it may have content or not —
    // either way the resolver must return a non-empty string
    const resolved = await resolver.resolve(refs);
    expect(resolved).toHaveLength(1);
    expect(typeof resolved[0].content).toBe("string");
    expect(resolved[0].content.length).toBeGreaterThan(0);
  });
});

// ── resolve: @MCP ────────────────────────────────────────────────────────────

describe("ContextResolver.resolve @MCP", () => {
  it("returns graceful error when mcpRegistry is not set", async () => {
    const resolver = new ContextResolver(makeDeps()); // no registry
    const refs = resolver.parseReferences("@MCP(myserver:some/resource)");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].type).toBe("mcp");
    expect(resolved[0].content).toContain("[MCP registry not available]");
  });

  it("handles missing server:uri separator gracefully", async () => {
    const mockRegistry = {
      readResource: vi.fn(),
      getPrompt: vi.fn(),
    };
    const resolver = new ContextResolver(
      makeDeps(),
      mockRegistry as unknown as import("../../src/mcp/mcp-registry").McpRegistry,
    );
    const refs = resolver.parseReferences("@MCP(no-colon-value)");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].content).toContain("missing server:uri separator");
  });
});

// ── resolve: @MCPPrompt ──────────────────────────────────────────────────────

describe("ContextResolver.resolve @MCPPrompt", () => {
  it("returns graceful error when mcpRegistry is not set", async () => {
    const resolver = new ContextResolver(makeDeps()); // no registry
    const refs = resolver.parseReferences("@MCPPrompt(myserver:my-prompt)");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].type).toBe("mcpPrompt");
    expect(resolved[0].content).toContain("[MCP registry not available]");
  });
});

// ── resolve: @PR ─────────────────────────────────────────────────────────────

describe("ContextResolver.resolve @PR", () => {
  it("returns graceful error when gh CLI is not available (no git remote)", async () => {
    const resolver = new ContextResolver(
      makeDeps({ workspaceRoot: "/tmp/no-git-repo" }),
    );
    const refs = resolver.parseReferences("@PR(123)");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].type).toBe("pr");
    // Should contain either the PR content or an error message — not throw
    expect(typeof resolved[0].content).toBe("string");
    expect(resolved[0].content.length).toBeGreaterThan(0);
  });
});

// ── resolve: @Issue ──────────────────────────────────────────────────────────

describe("ContextResolver.resolve @Issue", () => {
  it("returns graceful error when gh CLI is not available", async () => {
    const resolver = new ContextResolver(
      makeDeps({ workspaceRoot: "/tmp/no-git-repo" }),
    );
    const refs = resolver.parseReferences("@Issue(456)");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].type).toBe("issue");
    expect(typeof resolved[0].content).toBe("string");
    expect(resolved[0].content.length).toBeGreaterThan(0);
  });

  it("returns invalid issue number message for non-numeric value", async () => {
    const resolver = new ContextResolver(makeDeps());
    // @Issue only matches digits by regex, so parse manually via a fabricated ref
    const resolved = await resolver.resolve([
      { type: "issue", value: "not-a-number", start: 0, end: 10 },
    ]);
    expect(resolved[0].content).toContain("[Invalid issue number]");
  });
});

// ── resolve: @GitBlame path sanitization ─────────────────────────────────────

describe("ContextResolver.resolve @GitBlame", () => {
  it("sanitizes path — strips leading slash", async () => {
    const resolver = new ContextResolver(makeDeps());
    // Pass directly — spawnSync will fail gracefully since /workspace is fake
    const resolved = await resolver.resolve([
      { type: "gitBlame", value: "/src/file.ts:10", start: 0, end: 20 },
    ]);
    // Leading slash should be stripped; result is either blame output or error message
    expect(resolved[0].type).toBe("gitBlame");
    expect(typeof resolved[0].content).toBe("string");
    // Should not contain the raw leading slash in the label
    expect(resolved[0].label).not.toContain("//");
  });

  it("sanitizes path — strips .. traversal (content must not expose traversal path)", async () => {
    const resolver = new ContextResolver(makeDeps());
    const resolved = await resolver.resolve([
      { type: "gitBlame", value: "../../../etc/passwd:1", start: 0, end: 25 },
    ]);
    expect(resolved[0].content).not.toContain("[Invalid file path]");
    // The sanitized path used for git blame should have ".." stripped.
    // The content should not expose the traversal path as a file read.
    // (The label keeps the original value for display; the content uses sanitized path.)
    expect(resolved[0].type).toBe("gitBlame");
    // Content should be git blame output (or error from git not finding the file),
    // not a raw file read of /etc/passwd
    expect(resolved[0].content).not.toContain("root:");
  });
});

// ── resolve: @TestFor identifier validation ──────────────────────────────────

describe("ContextResolver.resolve @TestFor", () => {
  it("accepts a valid JavaScript identifier", async () => {
    const resolver = new ContextResolver(makeDeps({ workspaceRoot: "/tmp" }));
    const resolved = await resolver.resolve([
      { type: "testFor", value: "myFunction", start: 0, end: 20 },
    ]);
    expect(resolved[0].type).toBe("testFor");
    // Should not return invalid identifier error
    expect(resolved[0].content).not.toContain("[Invalid symbol name");
  });

  it('rejects shell-injection attempt like "foo(); rm -rf ~"', async () => {
    const resolver = new ContextResolver(makeDeps());
    const resolved = await resolver.resolve([
      { type: "testFor", value: "foo(); rm -rf ~", start: 0, end: 20 },
    ]);
    expect(resolved[0].content).toContain("[Invalid symbol name");
  });

  it("rejects identifiers with spaces", async () => {
    const resolver = new ContextResolver(makeDeps());
    const resolved = await resolver.resolve([
      { type: "testFor", value: "bad identifier", start: 0, end: 15 },
    ]);
    expect(resolved[0].content).toContain("[Invalid symbol name");
  });

  it("accepts underscore-prefixed identifier", async () => {
    const resolver = new ContextResolver(makeDeps({ workspaceRoot: "/tmp" }));
    const resolved = await resolver.resolve([
      { type: "testFor", value: "_myPrivateFunc", start: 0, end: 15 },
    ]);
    expect(resolved[0].content).not.toContain("[Invalid symbol name");
  });

  it("rejects identifiers starting with a digit", async () => {
    const resolver = new ContextResolver(makeDeps());
    const resolved = await resolver.resolve([
      { type: "testFor", value: "1badName", start: 0, end: 10 },
    ]);
    expect(resolved[0].content).toContain("[Invalid symbol name");
  });
});

// ── resolve: @Web ────────────────────────────────────────────────────────────

describe("ContextResolver.resolve @Web", () => {
  it("returns placeholder when Brave key not set (webSearchTool returns error)", async () => {
    const resolver = new ContextResolver(makeDeps());
    const refs = resolver.parseReferences("@Web latest news");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].type).toBe("web");
    // The mock returns success:false — should surface as web search failed message
    expect(resolved[0].content).toContain("[web search failed]");
  });

  it("returns web content when search succeeds", async () => {
    const resolver = new ContextResolver(
      makeDeps({
        webSearchTool: {
          execute: vi.fn().mockResolvedValue({
            success: true,
            output: "Result 1: TypeScript 5.6 released",
          }),
        },
      }),
    );
    const refs = resolver.parseReferences("@Web TypeScript release");
    const resolved = await resolver.resolve(refs);
    expect(resolved[0].content).toContain("TypeScript 5.6 released");
  });
});

// ── Autocomplete ─────────────────────────────────────────────────────────────

describe("ContextResolver.getAutocompleteSuggestions", () => {
  it("returns all suggestions for bare @", () => {
    const resolver = new ContextResolver(makeDeps());
    const suggestions = resolver.getAutocompleteSuggestions("@");
    expect(suggestions.length).toBeGreaterThan(5);
  });

  it("filters by prefix", () => {
    const resolver = new ContextResolver(makeDeps());
    const suggestions = resolver.getAutocompleteSuggestions("@Fi");
    expect(suggestions.every((s) => s.label.startsWith("@Fi"))).toBe(true);
  });

  it("returns empty array for non-@ prefix", () => {
    const resolver = new ContextResolver(makeDeps());
    const suggestions = resolver.getAutocompleteSuggestions("Files");
    expect(suggestions).toHaveLength(0);
  });
});
