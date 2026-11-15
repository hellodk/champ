/**
 * Unit tests for CLI skill dispatch, context building, and formatting (Increment C).
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  buildSkillContext,
  formatSkillList,
  loadCliSkills,
  resolveInvocation,
} from "@/cli/skills";
import { SkillLoader } from "@/skills/skill-loader";
import { SkillRegistry } from "@/skills/skill-registry";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "champ-cli-dispatch-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveInvocation", () => {
  it("expands {{userInput}}", () => {
    const registry = new SkillRegistry();
    registry.register(
      SkillLoader.parseFile(
        "---\nname: greet\ndescription: Greet\n---\nHello {{userInput}}!",
        "workspace",
      ),
    );
    const { context } = buildSkillContext("/tmp/ws", "");
    const res = resolveInvocation(registry, "/greet world", context);
    expect(res.kind).toBe("skill");
    if (res.kind === "skill") {
      expect(res.invocation.prompt).toBe("Hello world!");
      expect(res.invocation.userInput).toBe("world");
    }
  });

  it("leaves an unknown {{nope}} placeholder intact", () => {
    const registry = new SkillRegistry();
    registry.register(
      SkillLoader.parseFile(
        "---\nname: test-unk\ndescription: Unknown var\n---\nKeep {{nope}} as-is",
        "workspace",
      ),
    );
    const { context } = buildSkillContext("/tmp/ws", "");
    const res = resolveInvocation(registry, "/test-unk", context);
    expect(res.kind).toBe("skill");
    if (res.kind === "skill") {
      expect(res.invocation.prompt).toBe("Keep {{nope}} as-is");
    }
  });

  it("always populates workspaceRoot and date", () => {
    const registry = new SkillRegistry();
    registry.register(
      SkillLoader.parseFile(
        "---\nname: env\ndescription: Env\n---\n{{workspaceRoot}} on {{date}}",
        "workspace",
      ),
    );
    const { context } = buildSkillContext("/tmp/ws", "");
    const res = resolveInvocation(registry, "/env", context);
    expect(res.kind).toBe("skill");
    if (res.kind === "skill") {
      const today = new Date().toISOString().slice(0, 10);
      expect(res.invocation.prompt).toBe(`/tmp/ws on ${today}`);
    }
  });

  it("populates currentFile and language from --file", () => {
    const registry = new SkillRegistry();
    registry.register(
      SkillLoader.parseFile(
        "---\nname: inspect\ndescription: Inspect\n---\nFile={{currentFile}} Lang={{language}}",
        "workspace",
      ),
    );
    const { context } = buildSkillContext("/tmp/ws", "", {
      file: "/tmp/ws/src/a.ts",
    });
    const res = resolveInvocation(registry, "/inspect", context);
    expect(res.kind).toBe("skill");
    if (res.kind === "skill") {
      expect(res.invocation.prompt).toBe("File=src/a.ts Lang=typescript");
    }
  });

  it("resolves selection and cursorLine to empty string", () => {
    const registry = new SkillRegistry();
    registry.register(
      SkillLoader.parseFile(
        "---\nname: sel\ndescription: Sel\n---\n[{{selection}}|{{cursorLine}}]",
        "workspace",
      ),
    );
    const { context } = buildSkillContext("/tmp/ws", "");
    const res = resolveInvocation(registry, "/sel", context);
    expect(res.kind).toBe("skill");
    if (res.kind === "skill") {
      expect(res.invocation.prompt).toBe("[|]");
    }
  });

  it("returns none for text without a leading slash", () => {
    const { registry } = loadCliSkills({
      workspaceRoot: "/tmp/ws",
      skipDisk: true,
    });
    const { context } = buildSkillContext("/tmp/ws", "");
    expect(resolveInvocation(registry, "explain this", context)).toEqual({
      kind: "none",
    });
  });

  it("returns reserved for /help even when a skill named help is registered", () => {
    const registry = new SkillRegistry();
    registry.register(
      SkillLoader.parseFile(
        "---\nname: help\ndescription: Shadow\n---\nShadow body",
        "workspace",
      ),
    );
    const { context } = buildSkillContext("/tmp/ws", "");
    expect(resolveInvocation(registry, "/help", context)).toEqual({
      kind: "reserved",
    });
  });

  it("returns unknown with <=3 deduplicated suggestions for a near miss", () => {
    const { registry } = loadCliSkills({
      workspaceRoot: "/tmp/ws",
      skipDisk: true,
    });
    const { context } = buildSkillContext("/tmp/ws", "");
    const res = resolveInvocation(registry, "/re", context);
    expect(res.kind).toBe("unknown");
    if (res.kind === "unknown") {
      expect(res.name).toBe("re");
      expect(res.suggestions.length).toBeLessThanOrEqual(3);
      expect(new Set(res.suggestions).size).toBe(res.suggestions.length);
      expect(res.suggestions).toEqual(
        expect.arrayContaining(["refactor", "review"]),
      );
    }
  });

  it("returns the body unchanged when the template has no placeholders", () => {
    const registry = new SkillRegistry();
    registry.register(
      SkillLoader.parseFile(
        "---\nname: plain\ndescription: Plain\n---\nJust do the thing.",
        "workspace",
      ),
    );
    const { context } = buildSkillContext("/tmp/ws", "");
    const res = resolveInvocation(registry, "/plain extra args", context);
    expect(res.kind).toBe("skill");
    if (res.kind === "skill") {
      expect(res.invocation.prompt).toBe("Just do the thing.");
    }
  });

  it("adds an editor-only note for /doc with no --file", () => {
    const { registry } = loadCliSkills({
      workspaceRoot: "/tmp/ws",
      skipDisk: true,
    });
    const { context } = buildSkillContext("/tmp/ws", "");
    const res = resolveInvocation(registry, "/doc", context);
    expect(res.kind).toBe("skill");
    if (res.kind === "skill") {
      expect(res.invocation.notes.length).toBeGreaterThan(0);
      expect(res.invocation.notes[0]).toContain("[skills] /doc:");
      expect(res.invocation.notes[0]).toContain("--file <path>");
    }
  });

  it("adds no editor-only note when --file supplies currentFile", () => {
    const registry = new SkillRegistry();
    registry.register(
      SkillLoader.parseFile(
        "---\nname: file-only\ndescription: File only\n---\nCheck {{currentFile}} ({{language}})",
        "workspace",
      ),
    );
    const { context } = buildSkillContext("/tmp/ws", "", {
      file: "/tmp/ws/src/a.ts",
    });
    const res = resolveInvocation(registry, "/file-only", context);
    expect(res.kind).toBe("skill");
    if (res.kind === "skill") {
      expect(res.invocation.notes).toEqual([]);
    }
  });

  it("keeps newlines in multi-line userInput", () => {
    const registry = new SkillRegistry();
    registry.register(
      SkillLoader.parseFile(
        "---\nname: multi\ndescription: Multi\n---\nInput:\n{{userInput}}",
        "workspace",
      ),
    );
    const { context } = buildSkillContext("/tmp/ws", "");
    const res = resolveInvocation(registry, "/multi line1\nline2", context);
    expect(res.kind).toBe("skill");
    if (res.kind === "skill") {
      expect(res.invocation.prompt).toBe("Input:\nline1\nline2");
    }
  });
});

describe("buildSkillContext", () => {
  it("derives language from extension and leaves unknown undefined", () => {
    const ts = buildSkillContext("/tmp/ws", "", { file: "src/app.ts" });
    expect(ts.context.language).toBe("typescript");

    const unk = buildSkillContext("/tmp/ws", "", { file: "data.xyz" });
    expect(unk.context.language).toBeUndefined();
  });

  it("makes currentFile workspace-relative when inside workspace", () => {
    const res = buildSkillContext("/tmp/ws", "", {
      file: "/tmp/ws/src/nested/file.py",
    });
    expect(res.context.currentFile).toBe("src/nested/file.py");
    expect(res.context.language).toBe("python");
    expect(res.notes).toEqual([]);
  });

  it("notes a --file outside the workspace", () => {
    const res = buildSkillContext("/tmp/ws", "", {
      file: "/etc/hosts",
    });
    expect(res.context.currentFile).toBe("/etc/hosts");
    expect(res.notes).toEqual([
      "[skills] --file is outside the workspace; glob rules will not match it.",
    ]);
  });
});

describe("formatSkillList", () => {
  it("includes name, mode, source, and description", () => {
    const { registry } = loadCliSkills({
      workspaceRoot: "/tmp/ws",
      skipDisk: true,
    });
    const output = formatSkillList(registry);
    expect(output).toContain("[champ] skills (workspace > user > built-in)");
    expect(output).toContain("/explain");
    expect(output).toContain("ask");
    expect(output).toContain("built-in");
    expect(output).toContain("Explain the current code selection");
  });

  it("shows workspace for an override", () => {
    const ws = makeTempDir();
    const home = makeTempDir();
    const skillsDir = path.join(ws, ".champ", "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "review.md"),
      "---\nname: review\ndescription: Custom ws review\n---\nCustom body",
    );

    const { registry } = loadCliSkills({ workspaceRoot: ws, homeDir: home });
    const output = formatSkillList(registry);
    expect(output).toContain("/review");
    expect(output).toContain("workspace");
    expect(output).toContain("Custom ws review");
  });
});
