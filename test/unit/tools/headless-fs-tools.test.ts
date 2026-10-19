/**
 * Tests for the headless (VSCode-free) fs tool layer — issue #136.
 *
 * Covers: round-trips for all seven tools, path-traversal rejection, staging
 * behaviour, approval flow through the registry, and the guarantee that the
 * CLI path never imports `vscode`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  createHeadlessToolRegistry,
  globToRegExp,
  headlessFsTools,
  headlessReadFileTool,
  headlessEditFileTool,
  headlessCreateFileTool,
  headlessDeleteFileTool,
  headlessListDirectoryTool,
  headlessGrepSearchTool,
  headlessFileSearchTool,
} from "@/tools/headless";
import { StagedEdits } from "@/agent/staged-edits";
import type { ToolExecutionContext } from "@/tools/types";

const TRAVERSAL = "../../etc/passwd";
const OUTSIDE = "is outside workspace";

let workspace: string;
let context: ToolExecutionContext;
let approvals: boolean[];

const approval = async () => {
  const approve = approvals.length > 0 ? approvals.shift()! : true;
  return approve;
};

function makeContext(overrides: Partial<ToolExecutionContext> = {}) {
  return {
    workspaceRoot: workspace,
    abortSignal: new AbortController().signal,
    reportProgress: vi.fn(),
    requestApproval: vi.fn(approval),
    ...overrides,
  } as ToolExecutionContext;
}

/** Write a file inside the temp workspace, creating parents as needed. */
function write(rel: string, content: string): string {
  const full = path.join(workspace, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf-8");
  return full;
}

function readDisk(rel: string): string {
  return fs.readFileSync(path.join(workspace, rel), "utf-8");
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "champ-headless-"));
  approvals = [];
  context = makeContext();
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Layer shape
// ---------------------------------------------------------------------------

describe("headless tool layer", () => {
  it("provides exactly the seven fs/search tools with unique names", () => {
    expect(headlessFsTools).toHaveLength(7);
    const names = headlessFsTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual([
      "create_file",
      "delete_file",
      "edit_file",
      "file_search",
      "grep_search",
      "list_directory",
      "read_file",
    ]);
  });

  it("requires approval only for mutating tools", () => {
    const expectApproval: Record<string, boolean> = {
      read_file: false,
      list_directory: false,
      grep_search: false,
      file_search: false,
      edit_file: true,
      create_file: true,
      delete_file: true,
    };
    for (const tool of headlessFsTools) {
      expect(tool.requiresApproval, tool.name).toBe(expectApproval[tool.name]);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.parameters.required?.length).toBeGreaterThan(0);
    }
  });

  it("registers every tool into a ToolRegistry", () => {
    const registry = createHeadlessToolRegistry();
    expect(registry.getAll()).toHaveLength(7);
    const defs = registry.getDefinitions();
    expect(defs.map((d) => d.name).sort()).toEqual(
      headlessFsTools.map((t) => t.name).sort(),
    );
    for (const def of defs) {
      expect(def.parameters.type).toBe("object");
    }
  });

  it("never imports the vscode API (CLI must run outside VS Code)", () => {
    const sources = [
      "src/tools/headless/fs-tools.ts",
      "src/tools/headless/index.ts",
      "src/utils/edit-match.ts",
      "src/utils/line-numbering.ts",
      "src/utils/workspace-path.ts",
      "src/utils/diff-utils.ts",
    ];
    for (const rel of sources) {
      const text = fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
      expect(text, `${rel} must not import vscode`).not.toMatch(
        /from\s+["']vscode["']|require\(["']vscode["']\)|import\(["']vscode["']\)/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe("headless read_file", () => {
  it("returns content with line numbers", async () => {
    write("a.txt", "alpha\nbeta\ngamma");
    const res = await headlessReadFileTool.execute({ path: "a.txt" }, context);
    expect(res.success).toBe(true);
    expect(res.output).toContain("1: alpha");
    expect(res.output).toContain("2: beta");
    expect(res.output).toContain("3: gamma");
  });

  it("honours an inclusive startLine/endLine range", async () => {
    write(
      "range.txt",
      Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    const res = await headlessReadFileTool.execute(
      { path: "range.txt", startLine: 5, endLine: 10 },
      context,
    );
    expect(res.output).toContain("5: line 5");
    expect(res.output).toContain("10: line 10");
    expect(res.output).not.toContain("11:");
  });

  it("truncates files longer than 2000 lines", async () => {
    write(
      "big.txt",
      Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n"),
    );
    const res = await headlessReadFileTool.execute(
      { path: "big.txt" },
      context,
    );
    expect(res.output).toContain("[truncated at line 2000 of 3000]");
    expect(res.output).not.toContain("3000: line 3000");
  });

  it("reads a bounded prefix instead of loading a huge file (review 4b)", async () => {
    // One 3 MB line: the formatter emits it whole (1 line is under the
    // 2000-line cap), so only a bounded read keeps it out of the prompt.
    write("huge.txt", `HEAD_MARKER${"x".repeat(3_000_000)}TAIL_MARKER`);

    const res = await headlessReadFileTool.execute(
      { path: "huge.txt" },
      context,
    );

    expect(res.success).toBe(true);
    expect(res.output).toContain("HEAD_MARKER");
    expect(res.output).not.toContain("TAIL_MARKER");
    expect(res.output).toContain("showing the first 1 line]");
  });

  it("fails loudly when the requested range is past the read limit (review 2)", async () => {
    // Multi-line so the prefix covers a countable number of lines.
    write(
      "huge-lines.txt",
      Array.from({ length: 400_000 }, (_, i) => `line ${i + 1}`).join("\n"),
    );

    const res = await headlessReadFileTool.execute(
      { path: "huge-lines.txt", startLine: 399_000 },
      context,
    );

    expect(res.success).toBe(false);
    expect(res.output).toContain("past the read limit");
    expect(res.output).toContain("huge-lines.txt");
    expect(res.output).toContain("grep_search");
  });

  it("still serves a range inside the read prefix of a huge file (review 2)", async () => {
    write(
      "huge-lines.txt",
      Array.from({ length: 400_000 }, (_, i) => `line ${i + 1}`).join("\n"),
    );

    const res = await headlessReadFileTool.execute(
      { path: "huge-lines.txt", startLine: 2, endLine: 3 },
      context,
    );

    expect(res.success).toBe(true);
    expect(res.output).toContain("2: line 2");
    expect(res.output).toContain("3: line 3");
  });

  it("rejects path traversal", async () => {
    const res = await headlessReadFileTool.execute(
      { path: TRAVERSAL },
      context,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain(OUTSIDE);
  });

  it("reports a missing file without throwing", async () => {
    const res = await headlessReadFileTool.execute(
      { path: "nope.txt" },
      context,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain("File not found or unreadable");
  });

  it("reads staged content ahead of what is on disk", async () => {
    const staged = new StagedEdits();
    const stagedCtx = makeContext({ stagedEdits: staged });
    const abs = write("s.txt", "before\n");
    staged.stage(abs, "before\n", "after\n", "s.txt");

    const res = await headlessReadFileTool.execute(
      { path: "s.txt" },
      stagedCtx,
    );
    expect(res.output).toContain("after");
    expect(readDisk("s.txt")).toBe("before\n");
  });
});

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

describe("headless edit_file", () => {
  it("replaces exact content on disk", async () => {
    write("m.txt", "hello world\n");
    const res = await headlessEditFileTool.execute(
      {
        path: "m.txt",
        old_content: "hello world",
        new_content: "goodbye moon",
      },
      context,
    );
    expect(res.success).toBe(true);
    expect(readDisk("m.txt")).toContain("goodbye moon");
    expect(res.metadata?.filesModified).toEqual(["m.txt"]);
    expect(res.metadata?.fileEditDiff?.newContent).toContain("goodbye moon");
  });

  it("rejects ambiguous old_content that appears twice", async () => {
    write("d.txt", "aa bb aa\n");
    const res = await headlessEditFileTool.execute(
      { path: "d.txt", old_content: "aa", new_content: "zz" },
      context,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain("Ambiguous match");
    expect(readDisk("d.txt")).toBe("aa bb aa\n");
  });

  it("returns a self-correcting message when old_content is absent", async () => {
    write("f.txt", "one\ntwo\n");
    const res = await headlessEditFileTool.execute(
      { path: "f.txt", old_content: "nine", new_content: "9" },
      context,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain("Could not find the specified old_content");
    expect(res.output).toContain("re-read the file");
    expect(readDisk("f.txt")).toBe("one\ntwo\n");
  });

  it("rejects path traversal", async () => {
    const res = await headlessEditFileTool.execute(
      { path: TRAVERSAL, old_content: "a", new_content: "b" },
      context,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain(OUTSIDE);
  });

  it("returns a diff preview", () => {
    const preview = headlessEditFileTool.getPreview?.({
      path: "x.txt",
      old_content: "const a = 1;\n",
      new_content: "const a = 2;\n",
    });
    expect(preview?.type).toBe("diff");
    expect(preview?.label).toContain("x.txt");
    expect(preview?.content.split("\n").filter((l) => l !== "")).toContain(
      "+const a = 2;",
    );
  });

  it("buffers edits into staging instead of writing the disk", async () => {
    const staged = new StagedEdits();
    const stagedCtx = makeContext({ stagedEdits: staged });
    write("st.txt", "original\n");

    const res = await headlessEditFileTool.execute(
      { path: "st.txt", old_content: "original", new_content: "staged" },
      stagedCtx,
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain("Staged edit");
    expect(readDisk("st.txt")).toBe("original\n");
    expect(staged.size()).toBe(1);

    const flushed = await staged.flush();
    expect(flushed).toHaveLength(1);
    expect(readDisk("st.txt")).toBe("staged\n");
  });

  it("composes sequential edits in one turn through staging", async () => {
    const staged = new StagedEdits();
    const stagedCtx = makeContext({ stagedEdits: staged });
    write("seq.txt", "A B C\n");

    await headlessEditFileTool.execute(
      { path: "seq.txt", old_content: "A", new_content: "X" },
      stagedCtx,
    );
    await headlessEditFileTool.execute(
      { path: "seq.txt", old_content: "C", new_content: "Y" },
      stagedCtx,
    );

    await staged.flush();
    expect(readDisk("seq.txt")).toBe("X B Y\n");
  });

  it("records the edit in the review tracker when writing straight through", async () => {
    const tracker = {
      record: vi.fn(),
      flush: vi.fn(() => []),
      reset: vi.fn(),
      count: 0,
    } as unknown as import("@/agent/edit-review-tracker").EditReviewTracker;
    const trackCtx = makeContext({ editReviewTracker: tracker });
    write("tr.txt", "before\n");

    await headlessEditFileTool.execute(
      { path: "tr.txt", old_content: "before", new_content: "after" },
      trackCtx,
    );
    expect(tracker.record).toHaveBeenCalledTimes(1);
    expect(tracker.record).toHaveBeenCalledWith(
      expect.objectContaining({ path: "tr.txt", newContent: "after\n" }),
    );
  });
});

// ---------------------------------------------------------------------------
// create_file / delete_file
// ---------------------------------------------------------------------------

describe("headless create_file", () => {
  it("creates the file and any missing parent directories", async () => {
    const res = await headlessCreateFileTool.execute(
      { path: "deep/nested/file.txt", content: "made\n" },
      context,
    );
    expect(res.success).toBe(true);
    expect(readDisk("deep/nested/file.txt")).toBe("made\n");
    expect(res.metadata?.filesCreated).toEqual(["deep/nested/file.txt"]);
  });

  it("rejects path traversal", async () => {
    const res = await headlessCreateFileTool.execute(
      { path: TRAVERSAL, content: "x" },
      context,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain(OUTSIDE);
    expect(fs.readdirSync(workspace)).toEqual([]); // nothing was created
  });
});

describe("headless delete_file", () => {
  it("deletes an existing file", async () => {
    write("gone.txt", "bye");
    const res = await headlessDeleteFileTool.execute(
      { path: "gone.txt" },
      context,
    );
    expect(res.success).toBe(true);
    expect(res.output).toBe("Deleted gone.txt");
    expect(fs.existsSync(path.join(workspace, "gone.txt"))).toBe(false);
    expect(res.metadata?.filesDeleted).toEqual(["gone.txt"]);
  });

  it("refuses to delete a directory", async () => {
    fs.mkdirSync(path.join(workspace, "adir"));
    const res = await headlessDeleteFileTool.execute({ path: "adir" }, context);
    expect(res.success).toBe(false);
    expect(res.output).toContain("is a directory");
    expect(fs.existsSync(path.join(workspace, "adir"))).toBe(true);
  });

  it("rejects path traversal", async () => {
    const res = await headlessDeleteFileTool.execute(
      { path: TRAVERSAL },
      context,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain(OUTSIDE);
  });
});

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

describe("headless list_directory", () => {
  it("marks directories with a trailing slash and sorts entries", async () => {
    write("pkg/a.ts", "a");
    write("zeta.txt", "z");
    const res = await headlessListDirectoryTool.execute({ path: "." }, context);
    const lines = res.output.split("\n");
    expect(lines).toEqual(["pkg/", "zeta.txt"]);
  });

  it("reports an empty directory", async () => {
    fs.mkdirSync(path.join(workspace, "empty"));
    const res = await headlessListDirectoryTool.execute(
      { path: "empty" },
      context,
    );
    expect(res.success).toBe(true);
    expect(res.output).toBe("empty is empty");
  });

  it("rejects path traversal", async () => {
    const res = await headlessListDirectoryTool.execute(
      { path: TRAVERSAL },
      context,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain(OUTSIDE);
  });
});

// ---------------------------------------------------------------------------
// grep_search
// ---------------------------------------------------------------------------

describe("headless grep_search", () => {
  it("returns file:line:content matches", async () => {
    write(
      "src/app.ts",
      "const needle = 1;\nlet other = 2;\nconst needle = 3;\n",
    );
    const res = await headlessGrepSearchTool.execute(
      { query: "needle" },
      context,
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain("src/app.ts:1:");
    expect(res.output).toContain("src/app.ts:3:");
    expect(res.output).not.toContain("src/app.ts:2:");
  });

  it("reports no matches without failing", async () => {
    write("a.txt", "nothing here");
    const res = await headlessGrepSearchTool.execute(
      { query: "zzz-absent" },
      context,
    );
    expect(res.success).toBe(true);
    expect(res.output).toBe("No matches found");
  });

  it("is case-sensitive by default and insensitive when asked", async () => {
    write("case.txt", "apple pie\n");
    const sensitive = await headlessGrepSearchTool.execute(
      { query: "APPLE" },
      context,
    );
    expect(sensitive.output).toBe("No matches found");

    const insensitive = await headlessGrepSearchTool.execute(
      { query: "APPLE", caseSensitive: false },
      context,
    );
    expect(insensitive.output).toContain("case.txt:1:");
  });

  it("filters by includePattern", async () => {
    write("src/keep.ts", "searchme");
    write("src/skip.txt", "searchme");
    const res = await headlessGrepSearchTool.execute(
      { query: "searchme", includePattern: "*.ts" },
      context,
    );
    expect(res.output).toContain("src/keep.ts");
    expect(res.output).not.toContain("skip.txt");
  });

  it("never descends into ignored directories like node_modules", async () => {
    write("node_modules/pkg/index.js", "searchme");
    write("src/real.ts", "searchme");
    const res = await headlessGrepSearchTool.execute(
      { query: "searchme" },
      context,
    );
    expect(res.output).toContain("src/real.ts");
    expect(res.output).not.toContain("node_modules");
  });

  it("rejects an invalid regex instead of throwing", async () => {
    const res = await headlessGrepSearchTool.execute(
      { query: "(unclosed" },
      context,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain("Invalid regex");
  });

  it("treats an empty query as no matches", async () => {
    const res = await headlessGrepSearchTool.execute({ query: "" }, context);
    expect(res.success).toBe(true);
    expect(res.output).toBe("No matches found");
  });
});

// ---------------------------------------------------------------------------
// file_search
// ---------------------------------------------------------------------------

describe("headless file_search", () => {
  it("matches partial file names anywhere in the tree", async () => {
    write("src/utils/widgets.ts", "x");
    const res = await headlessFileSearchTool.execute(
      { query: "widget" },
      context,
    );
    expect(res.output).toBe("src/utils/widgets.ts");
  });

  it("caps results at 10 files", async () => {
    for (let i = 1; i <= 15; i++) write(`gen/widget${i}.ts`, "x");
    const res = await headlessFileSearchTool.execute(
      { query: "widget" },
      context,
    );
    expect(res.output.split("\n")).toHaveLength(10);
  });

  it("skips node_modules", async () => {
    write("node_modules/pkg/widget.js", "x");
    const res = await headlessFileSearchTool.execute(
      { query: "widget" },
      context,
    );
    expect(res.output).toBe('No files found matching "widget"');
  });

  it("handles an empty query", async () => {
    const res = await headlessFileSearchTool.execute({ query: "  " }, context);
    expect(res.success).toBe(true);
    expect(res.output).toBe("No files found for empty query");
  });
});

// ---------------------------------------------------------------------------
// glob matching helper
// ---------------------------------------------------------------------------

describe("globToRegExp", () => {
  it("matches a bare pattern at any depth", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/deep/a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("src/a.tsx")).toBe(false);
  });

  it("anchors patterns that contain a slash", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("lib/a.ts")).toBe(false);
  });

  it("supports ** across directories and ? wildcards", () => {
    expect(globToRegExp("**/*.test.ts").test("a/b/c.test.ts")).toBe(true);
    expect(globToRegExp("v?.ts").test("v1.ts")).toBe(true);
    expect(globToRegExp("v?.ts").test("v10.ts")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Registry approval flow
// ---------------------------------------------------------------------------

describe("registry approval flow", () => {
  it("asks before running an approval-gated tool", async () => {
    approvals = [false];
    const registry = createHeadlessToolRegistry();
    write("victim.txt", "data");
    const res = await registry.execute(
      "delete_file",
      { path: "victim.txt" },
      context,
    );
    expect(context.requestApproval).toHaveBeenCalledTimes(1);
    expect(res.success).toBe(false);
    expect(res.output).toContain("User denied");
    expect(fs.existsSync(path.join(workspace, "victim.txt"))).toBe(true);
  });

  it("runs the tool when approved", async () => {
    approvals = [true];
    const registry = createHeadlessToolRegistry();
    write("victim.txt", "data");
    const res = await registry.execute(
      "delete_file",
      { path: "victim.txt" },
      context,
    );
    expect(res.success).toBe(true);
    expect(fs.existsSync(path.join(workspace, "victim.txt"))).toBe(false);
  });

  it("validates arguments before asking for approval", async () => {
    const registry = createHeadlessToolRegistry();
    const res = await registry.execute(
      "create_file",
      { path: "only-path.txt" },
      context,
    );
    expect(res.success).toBe(false);
    expect(res.output).toContain("missing required argument");
    expect(context.requestApproval).not.toHaveBeenCalled();
  });
});
