/**
 * Unit tests for CLI rules loading and prompt assembly (Increment A).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadCliRules, rulesPrompt } from "@/cli/rules";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "champ-cli-rules-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadCliRules", () => {
  it("returns an engine with no rules when .champ/rules is missing", async () => {
    const ws = makeTempDir();
    const engine = await loadCliRules({ workspaceRoot: ws });
    expect(engine.listRules()).toEqual([]);
    expect(rulesPrompt(engine, { mode: "agent" })).toBe("");
  });

  it("loads an always rule from .champ/rules", async () => {
    const ws = makeTempDir();
    const rulesDir = path.join(ws, ".champ", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, "style.md"),
      "---\ntype: always\n---\nUse strict types.",
    );

    const engine = await loadCliRules({ workspaceRoot: ws });
    expect(engine.listRules()).toHaveLength(1);
    expect(rulesPrompt(engine, { mode: "agent" })).toBe("Use strict types.");
  });

  it("appends userRules even with no rules directory", async () => {
    const ws = makeTempDir();
    const engine = await loadCliRules({
      workspaceRoot: ws,
      userRules: "Always write concise code.",
    });
    expect(rulesPrompt(engine, { mode: "agent" })).toBe(
      "Always write concise code.",
    );
  });

  it("skips an unreadable rule file and keeps valid ones", async () => {
    const ws = makeTempDir();
    const rulesDir = path.join(ws, ".champ", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, "good.md"),
      "---\ntype: always\n---\nValid rule.",
    );
    // A directory ending in .md causes fs.readFile to throw EISDIR
    fs.mkdirSync(path.join(rulesDir, "bad.md"));

    const engine = await loadCliRules({ workspaceRoot: ws });
    expect(rulesPrompt(engine, { mode: "agent" })).toBe("Valid rule.");
  });

  it("logs to stderr and continues when .champ/rules is not a directory", async () => {
    const ws = makeTempDir();
    fs.mkdirSync(path.join(ws, ".champ"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".champ", "rules"), "not a dir");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const engine = await loadCliRules({
      workspaceRoot: ws,
      userRules: "User rule survives.",
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[champ] rules:"),
    );
    expect(rulesPrompt(engine, { mode: "agent" })).toBe("User rule survives.");
  });
});

describe("rulesPrompt", () => {
  it("includes a glob rule only when currentFile matches", async () => {
    const ws = makeTempDir();
    const rulesDir = path.join(ws, ".champ", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, "ts-only.md"),
      "---\ntype: auto-attached\nglob: src/**/*.ts\n---\nTS rule active.",
    );

    const engine = await loadCliRules({ workspaceRoot: ws });
    expect(rulesPrompt(engine, { mode: "agent" })).toBe("");
    expect(
      rulesPrompt(engine, { mode: "agent", currentFile: "README.md" }),
    ).toBe("");
    expect(
      rulesPrompt(engine, { mode: "agent", currentFile: "src/cli.ts" }),
    ).toBe("TS rule active.");
  });

  it("excludes agent-requested rules", async () => {
    const ws = makeTempDir();
    const rulesDir = path.join(ws, ".champ", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, "on-demand.md"),
      "---\ntype: agent-requested\n---\nOn demand only.",
    );

    const engine = await loadCliRules({ workspaceRoot: ws });
    expect(rulesPrompt(engine, { mode: "agent" })).toBe("");
  });

  it("joins two rules with exactly one blank line", async () => {
    const ws = makeTempDir();
    const rulesDir = path.join(ws, ".champ", "rules");
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.writeFileSync(
      path.join(rulesDir, "a.md"),
      "---\nname: a\ntype: always\n---\nRule A",
    );
    fs.writeFileSync(
      path.join(rulesDir, "b.md"),
      "---\nname: b\ntype: always\n---\nRule B",
    );

    const engine = await loadCliRules({ workspaceRoot: ws });
    expect(rulesPrompt(engine, { mode: "agent" })).toBe("Rule A\n\nRule B");
  });

  it("returns empty string when nothing is active", async () => {
    const ws = makeTempDir();
    const engine = await loadCliRules({ workspaceRoot: ws });
    expect(rulesPrompt(engine, { mode: "agent" })).toBe("");
  });

  it("adds the mandatory workflow rule only when requested", async () => {
    const ws = makeTempDir();
    const engine = await loadCliRules({
      workspaceRoot: ws,
      includeWorkflowRule: true,
    });
    const prompt = rulesPrompt(engine, { mode: "agent" });
    expect(prompt).toContain("Coding workflow (mandatory)");
    expect(prompt).toContain("inspect the resulting diff");
  });
});
