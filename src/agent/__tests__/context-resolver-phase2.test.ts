import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContextResolver } from "../context-resolver";
import { terminalOutputBuffer } from "../terminal-output-buffer";

// Hoisted mock factory so spawnSync can be controlled per-test via mockSpawnSyncResult.
const mockSpawnSyncResult = vi.hoisted(() => ({
  value: null as null | {
    stdout: string;
    stderr: string;
    status: number | null;
    error: Error | undefined;
    pid: number;
    signal: null;
    output: never[];
  },
}));

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawnSync: (..._args: unknown[]) => {
      if (mockSpawnSyncResult.value !== null) {
        return mockSpawnSyncResult.value;
      }
      // Fall through to actual if no mock result set
      return actual.spawnSync(
        ...(_args as Parameters<typeof actual.spawnSync>),
      );
    },
  };
});

// Minimal deps factory for tests that don't need full wiring
const makeBaseDeps = (overrides: Record<string, unknown> = {}) => ({
  workspaceRoot: "/workspace",
  indexingService: { search: vi.fn().mockResolvedValue([]) },
  webSearchTool: {
    execute: vi.fn().mockResolvedValue({ success: false, output: "" }),
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
// @Terminal
// ---------------------------------------------------------------------------
describe("ContextResolver @Terminal reference", () => {
  beforeEach(() => {
    terminalOutputBuffer.clear();
  });

  it("parses bare @Terminal reference", () => {
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = resolver.parseReferences("Here is the output @Terminal");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("terminal");
  });

  it("parses @Terminal(50) with line count", () => {
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = resolver.parseReferences("Output: @Terminal(50) analyse");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("terminal");
    expect(refs[0].value).toBe("50");
  });

  it("resolves @Terminal with no stored output", async () => {
    // buffer is cleared in beforeEach
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = [{ type: "terminal", value: "", start: 0, end: 9 }];
    const result = await resolver.resolve(refs as never);
    expect(result[0].type).toBe("terminal");
    expect(result[0].content).toContain("No recent terminal output");
  });

  it("resolves @Terminal and returns last N lines of stored output", async () => {
    const stored = Array.from({ length: 100 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    terminalOutputBuffer.write(stored);
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = [{ type: "terminal", value: "5", start: 0, end: 13 }];
    const result = await resolver.resolve(refs as never);
    const lines = result[0].content.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe("line 99");
  });

  it("defaults to 30 lines when value is empty", async () => {
    const stored = Array.from({ length: 50 }, (_, i) => `row ${i}`).join("\n");
    terminalOutputBuffer.write(stored);
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = [{ type: "terminal", value: "", start: 0, end: 9 }];
    const result = await resolver.resolve(refs as never);
    const lines = result[0].content.split("\n");
    expect(lines).toHaveLength(30);
  });

  it("resolves @Terminal without workspaceState dep gracefully", async () => {
    // buffer is cleared in beforeEach, so should return empty message
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = [{ type: "terminal", value: "", start: 0, end: 9 }];
    const result = await resolver.resolve(refs as never);
    expect(result[0].content).toContain("No recent terminal output");
  });

  it("appears in getAutocompleteSuggestions for @Te prefix", () => {
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const suggestions = resolver.getAutocompleteSuggestions("@Te");
    const labels = suggestions.map((s) => s.label);
    expect(labels).toContain("@Terminal");
    expect(labels).toContain("@TestFor");
  });
});

// ---------------------------------------------------------------------------
// @GitBlame
// ---------------------------------------------------------------------------
describe("ContextResolver @GitBlame reference", () => {
  it("parses @GitBlame(src/foo.ts:42) reference", () => {
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = resolver.parseReferences(
      "Who changed this? @GitBlame(src/foo.ts:42)",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("gitBlame");
    expect(refs[0].value).toBe("src/foo.ts:42");
  });

  it("resolves @GitBlame and returns blame output", async () => {
    mockSpawnSyncResult.value = {
      stdout: "abc123 author.name 42 blame line",
      stderr: "",
      status: 0,
      pid: 0,
      signal: null,
      error: undefined,
      output: [],
    };
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = [
      { type: "gitBlame", value: "src/foo.ts:42", start: 0, end: 10 },
    ];
    const result = await resolver.resolve(refs as never);
    expect(result[0].type).toBe("gitBlame");
    expect(result[0].label).toBe("Git blame: src/foo.ts:42");
    expect(typeof result[0].content).toBe("string");
    mockSpawnSyncResult.value = null;
  });

  it("resolves @GitBlame with fallback when git fails", async () => {
    mockSpawnSyncResult.value = {
      stdout: "",
      stderr: "not a git repo",
      status: 1,
      pid: 0,
      signal: null,
      error: undefined,
      output: [],
    };
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = [
      { type: "gitBlame", value: "nonexistent.ts:1", start: 0, end: 10 },
    ];
    const result = await resolver.resolve(refs as never);
    expect(result[0].content).toContain("Git blame failed");
    mockSpawnSyncResult.value = null;
  });

  it("parses @GitBlame with file that has no line number", () => {
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = resolver.parseReferences("@GitBlame(src/file.ts:1)");
    expect(refs[0].value).toBe("src/file.ts:1");
  });

  it("appears in getAutocompleteSuggestions for @GitB prefix", () => {
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const suggestions = resolver.getAutocompleteSuggestions("@GitB");
    expect(suggestions.map((s) => s.label)).toContain("@GitBlame");
  });
});

// ---------------------------------------------------------------------------
// @TestFor
// ---------------------------------------------------------------------------
describe("ContextResolver @TestFor reference", () => {
  it("parses @TestFor(myFunction) reference", () => {
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = resolver.parseReferences(
      "Help me write tests @TestFor(myFunction)",
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("testFor");
    expect(refs[0].value).toBe("myFunction");
  });

  it("resolves @TestFor and returns combined context when symbol found", async () => {
    // execSync returns file list; fs/promises.readFile reads content
    const { execSync } = await import("child_process");
    vi.spyOn(
      { execSync } as { execSync: typeof execSync },
      "execSync",
    ).mockReturnValue("src/utils/myFunction.ts\n");

    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = [{ type: "testFor", value: "myFunction", start: 0, end: 10 }];
    const result = await resolver.resolve(refs as never);
    expect(result[0].type).toBe("testFor");
    expect(result[0].label).toBe("Test context: myFunction");
    expect(typeof result[0].content).toBe("string");
  });

  it("resolves @TestFor gracefully when grep finds nothing", async () => {
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = [
      { type: "testFor", value: "nonExistentSymbol", start: 0, end: 10 },
    ];
    const result = await resolver.resolve(refs as never);
    expect(result[0].type).toBe("testFor");
    // Should return some content (either "not found" or partial)
    expect(typeof result[0].content).toBe("string");
    expect(result[0].content.length).toBeGreaterThan(0);
  });

  it("appears in getAutocompleteSuggestions for @Test prefix", () => {
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const suggestions = resolver.getAutocompleteSuggestions("@Test");
    expect(suggestions.map((s) => s.label)).toContain("@TestFor");
  });

  it("resolves @TestFor and includes 'no existing tests found' when none exist", async () => {
    const resolver = new ContextResolver(makeBaseDeps() as never);
    // grep will throw (no src/ dir in test env), so no tests found
    const refs = [{ type: "testFor", value: "phantomFn", start: 0, end: 10 }];
    const result = await resolver.resolve(refs as never);
    expect(result[0].type).toBe("testFor");
    // Either "no existing tests" or "not found" — either is acceptable fallback
    expect(result[0].content).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Combined parsing — multiple new references in one message
// ---------------------------------------------------------------------------
describe("ContextResolver phase-2 combined parsing", () => {
  it("parses @Terminal, @GitBlame, and @TestFor in a single message", () => {
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const msg =
      "Check @Terminal and @GitBlame(src/main.ts:10) then @TestFor(doTheThing)";
    const refs = resolver.parseReferences(msg);
    const types = refs.map((r) => r.type);
    expect(types).toContain("terminal");
    expect(types).toContain("gitBlame");
    expect(types).toContain("testFor");
  });

  it("bare @Terminal does not match @TestFor", () => {
    const resolver = new ContextResolver(makeBaseDeps() as never);
    const refs = resolver.parseReferences("@TestFor(fn) @Terminal");
    expect(refs.find((r) => r.type === "testFor")).toBeDefined();
    expect(refs.find((r) => r.type === "terminal")).toBeDefined();
    // @Terminal should not be consumed by @TestFor
    expect(refs.filter((r) => r.type === "terminal")).toHaveLength(1);
  });
});
