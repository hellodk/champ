import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContextResolver } from "../context-resolver";

/** Minimal deps object for tests that don't need real services. */
const makeDeps = () => ({
  workspaceRoot: "/workspace",
  indexingService: { search: vi.fn() },
  webSearchTool: { execute: vi.fn() },
});

// ---------------------------------------------------------------------------
// Helpers to mock child_process.execSync via vi.mock
// ---------------------------------------------------------------------------

vi.mock("child_process", () => ({
  execSync: vi.fn(),
}));

// We need to import after vi.mock so we get the mocked version.
import { execSync } from "child_process";
const mockExecSync = vi.mocked(execSync);

beforeEach(() => {
  mockExecSync.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// @PR — parseReferences
// ---------------------------------------------------------------------------

describe("ContextResolver @PR parseReferences", () => {
  it("parses @PR(123)", () => {
    const resolver = new ContextResolver(makeDeps() as never);
    const refs = resolver.parseReferences("Review @PR(123) please");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("pr");
    expect(refs[0].value).toBe("123");
  });

  it("parses multiple @PR references", () => {
    const resolver = new ContextResolver(makeDeps() as never);
    const refs = resolver.parseReferences("@PR(1) and @PR(999)");
    expect(refs).toHaveLength(2);
    expect(refs[0].value).toBe("1");
    expect(refs[1].value).toBe("999");
  });

  it("does NOT parse @PR without parentheses", () => {
    const resolver = new ContextResolver(makeDeps() as never);
    const refs = resolver.parseReferences("See @PR for details");
    expect(refs.find((r) => r.type === "pr")).toBeUndefined();
  });

  it("does NOT parse @PR with non-digit content", () => {
    const resolver = new ContextResolver(makeDeps() as never);
    // @PR(abc) should not match because the regex requires \d+
    const refs = resolver.parseReferences("@PR(abc)");
    expect(refs.find((r) => r.type === "pr")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// @PR — resolve
// ---------------------------------------------------------------------------

describe("ContextResolver @PR resolve", () => {
  it("resolves a PR and formats title, state, description, files and comments", async () => {
    const prPayload = {
      title: "Fix the bug",
      body: "This fixes the critical bug.",
      author: { login: "alice" },
      state: "MERGED",
      files: [
        { path: "src/foo.ts", additions: 10, deletions: 2 },
        { path: "src/bar.ts", additions: 3, deletions: 1 },
      ],
      comments: [{ author: { login: "bob" }, body: "LGTM!" }],
      reviews: [],
    };
    mockExecSync.mockReturnValue(JSON.stringify(prPayload));

    const resolver = new ContextResolver(makeDeps() as never);
    const refs = [{ type: "pr" as const, value: "42", start: 0, end: 7 }];
    const result = await resolver.resolve(refs);

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("pr");
    expect(result[0].label).toBe("PR #42: Fix the bug");
    expect(result[0].content).toContain("PR #42: Fix the bug");
    expect(result[0].content).toContain("Author: alice | State: MERGED");
    expect(result[0].content).toContain("This fixes the critical bug.");
    expect(result[0].content).toContain("src/foo.ts (+10 -2)");
    expect(result[0].content).toContain("bob: LGTM!");
  });

  it("caps content at 8000 characters for large PRs", async () => {
    const bigBody = "x".repeat(10000);
    const prPayload = {
      title: "Big PR",
      body: bigBody,
      author: { login: "dev" },
      state: "OPEN",
      files: [],
      comments: [],
    };
    mockExecSync.mockReturnValue(JSON.stringify(prPayload));

    const resolver = new ContextResolver(makeDeps() as never);
    const result = await resolver.resolve([
      { type: "pr" as const, value: "1", start: 0, end: 6 },
    ]);
    expect(result[0].content.length).toBeLessThanOrEqual(8000);
  });

  it("returns a helpful error when gh CLI fails", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("gh: command not found");
    });

    const resolver = new ContextResolver(makeDeps() as never);
    const result = await resolver.resolve([
      { type: "pr" as const, value: "10", start: 0, end: 7 },
    ]);
    expect(result[0].type).toBe("pr");
    expect(result[0].content).toContain("Failed to fetch PR #10");
    expect(result[0].content).toContain("gh: command not found");
    expect(result[0].content).toContain(
      "Is gh CLI installed and authenticated?",
    );
  });

  it("returns error message for invalid PR number (non-numeric value path)", async () => {
    // The regex only passes digits so value will always be numeric when matched,
    // but we can test the guard directly via resolve.
    const resolver = new ContextResolver(makeDeps() as never);
    // Manually construct a ref with a non-numeric value to exercise the guard.
    const refs = [{ type: "pr" as const, value: "abc", start: 0, end: 7 }];
    const result = await resolver.resolve(refs);
    expect(result[0].content).toBe("[Invalid PR number]");
  });

  it("omits empty files section when PR has no changed files", async () => {
    const prPayload = {
      title: "No files PR",
      body: "Pure config change.",
      author: { login: "alice" },
      state: "OPEN",
      files: [],
      comments: [],
    };
    mockExecSync.mockReturnValue(JSON.stringify(prPayload));

    const resolver = new ContextResolver(makeDeps() as never);
    const result = await resolver.resolve([
      { type: "pr" as const, value: "7", start: 0, end: 6 },
    ]);
    expect(result[0].content).not.toContain("## Changed files");
    expect(result[0].content).not.toContain("## Recent comments");
  });
});

// ---------------------------------------------------------------------------
// @Issue — parseReferences
// ---------------------------------------------------------------------------

describe("ContextResolver @Issue parseReferences", () => {
  it("parses @Issue(456)", () => {
    const resolver = new ContextResolver(makeDeps() as never);
    const refs = resolver.parseReferences("Relates to @Issue(456)");
    expect(refs).toHaveLength(1);
    expect(refs[0].type).toBe("issue");
    expect(refs[0].value).toBe("456");
  });

  it("parses multiple @Issue references", () => {
    const resolver = new ContextResolver(makeDeps() as never);
    const refs = resolver.parseReferences("Closes @Issue(1) and @Issue(2)");
    expect(refs).toHaveLength(2);
    expect(refs[0].value).toBe("1");
    expect(refs[1].value).toBe("2");
  });

  it("does NOT parse @Issue without parentheses", () => {
    const resolver = new ContextResolver(makeDeps() as never);
    const refs = resolver.parseReferences("See @Issue for info");
    expect(refs.find((r) => r.type === "issue")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// @Issue — resolve
// ---------------------------------------------------------------------------

describe("ContextResolver @Issue resolve", () => {
  it("resolves an issue and formats title, state, labels, description and comments", async () => {
    const issuePayload = {
      title: "App crashes on startup",
      body: "Steps to reproduce: launch the app.",
      author: { login: "reporter" },
      state: "OPEN",
      labels: [{ name: "bug" }, { name: "priority:high" }],
      comments: [
        { author: { login: "maintainer" }, body: "Looking into this." },
      ],
    };
    mockExecSync.mockReturnValue(JSON.stringify(issuePayload));

    const resolver = new ContextResolver(makeDeps() as never);
    const result = await resolver.resolve([
      { type: "issue" as const, value: "99", start: 0, end: 10 },
    ]);

    expect(result[0].type).toBe("issue");
    expect(result[0].label).toBe("Issue #99: App crashes on startup");
    expect(result[0].content).toContain("Issue #99: App crashes on startup");
    expect(result[0].content).toContain("Author: reporter | State: OPEN");
    expect(result[0].content).toContain("Labels: bug, priority:high");
    expect(result[0].content).toContain("Steps to reproduce");
    expect(result[0].content).toContain("maintainer: Looking into this.");
  });

  it("caps content at 8000 characters", async () => {
    const issuePayload = {
      title: "Big issue",
      body: "y".repeat(10000),
      author: { login: "dev" },
      state: "OPEN",
      labels: [],
      comments: [],
    };
    mockExecSync.mockReturnValue(JSON.stringify(issuePayload));

    const resolver = new ContextResolver(makeDeps() as never);
    const result = await resolver.resolve([
      { type: "issue" as const, value: "2", start: 0, end: 9 },
    ]);
    expect(result[0].content.length).toBeLessThanOrEqual(8000);
  });

  it("returns a helpful error when gh CLI fails", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("authentication required");
    });

    const resolver = new ContextResolver(makeDeps() as never);
    const result = await resolver.resolve([
      { type: "issue" as const, value: "5", start: 0, end: 9 },
    ]);
    expect(result[0].content).toContain("Failed to fetch Issue #5");
    expect(result[0].content).toContain("authentication required");
  });

  it("returns error for invalid issue number", async () => {
    const resolver = new ContextResolver(makeDeps() as never);
    const result = await resolver.resolve([
      { type: "issue" as const, value: "xyz", start: 0, end: 10 },
    ]);
    expect(result[0].content).toBe("[Invalid issue number]");
  });

  it("omits empty labels and comments sections", async () => {
    const issuePayload = {
      title: "Simple issue",
      body: "Just a description.",
      author: { login: "user" },
      state: "CLOSED",
      labels: [],
      comments: [],
    };
    mockExecSync.mockReturnValue(JSON.stringify(issuePayload));

    const resolver = new ContextResolver(makeDeps() as never);
    const result = await resolver.resolve([
      { type: "issue" as const, value: "3", start: 0, end: 9 },
    ]);
    expect(result[0].content).not.toContain("Labels:");
    expect(result[0].content).not.toContain("## Comments");
  });
});

// ---------------------------------------------------------------------------
// Mixed @PR and @Issue in the same message
// ---------------------------------------------------------------------------

describe("ContextResolver mixed @PR and @Issue", () => {
  it("parses both reference types from a single message", () => {
    const resolver = new ContextResolver(makeDeps() as never);
    const refs = resolver.parseReferences("This @PR(10) fixes @Issue(20)");
    const prRef = refs.find((r) => r.type === "pr");
    const issueRef = refs.find((r) => r.type === "issue");
    expect(prRef?.value).toBe("10");
    expect(issueRef?.value).toBe("20");
  });

  it("resolves both types correctly in the same call", async () => {
    const prPayload = {
      title: "My PR",
      body: "PR description",
      author: { login: "alice" },
      state: "OPEN",
      files: [],
      comments: [],
    };
    const issuePayload = {
      title: "My Issue",
      body: "Issue description",
      author: { login: "bob" },
      state: "OPEN",
      labels: [],
      comments: [],
    };
    // execSync will be called twice: first for PR, then for Issue.
    mockExecSync
      .mockReturnValueOnce(JSON.stringify(prPayload))
      .mockReturnValueOnce(JSON.stringify(issuePayload));

    const resolver = new ContextResolver(makeDeps() as never);
    const refs = [
      { type: "pr" as const, value: "10", start: 0, end: 7 },
      { type: "issue" as const, value: "20", start: 8, end: 16 },
    ];
    const result = await resolver.resolve(refs);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("pr");
    expect(result[0].label).toContain("PR #10");
    expect(result[1].type).toBe("issue");
    expect(result[1].label).toContain("Issue #20");
  });
});
