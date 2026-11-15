/**
 * Unit tests for CLI skill loading (Increment B).
 */
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadCliSkills, RESERVED_COMMANDS } from "@/cli/skills";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "champ-cli-skills-"));
  tempDirs.push(dir);
  return dir;
}

function writeSkill(dir: string, filename: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, "utf8");
  return filePath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("loadCliSkills", () => {
  it("registers the eight built-ins by name", () => {
    const ws = makeTempDir();
    const home = makeTempDir();
    const { registry, problems } = loadCliSkills({
      workspaceRoot: ws,
      homeDir: home,
    });
    expect(problems).toEqual([]);
    const names = registry.list().map((s) => s.metadata.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "explain",
        "test",
        "refactor",
        "review",
        "commit",
        "doc",
        "fix",
        "optimize",
      ]),
    );
    expect(names).toHaveLength(8);
  });

  it("workspace skill overrides a built-in of the same name", () => {
    const ws = makeTempDir();
    const home = makeTempDir();
    writeSkill(
      path.join(ws, ".champ", "skills"),
      "review.md",
      "---\nname: review\ndescription: Custom ws review\n---\nWorkspace review body",
    );

    const { registry, problems } = loadCliSkills({
      workspaceRoot: ws,
      homeDir: home,
    });
    expect(problems).toEqual([]);
    const skill = registry.get("review");
    expect(skill?.source).toBe("workspace");
    expect(skill?.template).toContain("Workspace review body");
  });

  it("user overrides built-in and workspace overrides user (precedence)", () => {
    const ws = makeTempDir();
    const home = makeTempDir();
    writeSkill(
      path.join(home, ".champ", "skills"),
      "explain.md",
      "---\nname: explain\ndescription: User explain\n---\nUser body",
    );
    writeSkill(
      path.join(ws, ".champ", "skills"),
      "explain.md",
      "---\nname: explain\ndescription: Workspace explain\n---\nWorkspace body",
    );
    writeSkill(
      path.join(home, ".champ", "skills"),
      "doc.md",
      "---\nname: doc\ndescription: User doc\n---\nUser doc body",
    );

    const { registry, problems } = loadCliSkills({
      workspaceRoot: ws,
      homeDir: home,
    });
    expect(problems).toEqual([]);
    expect(registry.get("explain")?.source).toBe("workspace");
    expect(registry.get("explain")?.template).toContain("Workspace body");
    expect(registry.get("doc")?.source).toBe("user");
    expect(registry.get("doc")?.template).toContain("User doc body");
  });

  it("reports invalid YAML in problems without throwing", () => {
    const ws = makeTempDir();
    const home = makeTempDir();
    writeSkill(
      path.join(ws, ".champ", "skills"),
      "broken.md",
      "---\nname: [unclosed\n---\nBody",
    );

    const { registry, problems } = loadCliSkills({
      workspaceRoot: ws,
      homeDir: home,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("broken.md");
    expect(registry.list()).toHaveLength(8);
  });

  it("reports a missing description in problems", () => {
    const ws = makeTempDir();
    const home = makeTempDir();
    writeSkill(
      path.join(ws, ".champ", "skills"),
      "nodesc.md",
      "---\nname: nodesc\n---\nBody here",
    );

    const { registry, problems } = loadCliSkills({
      workspaceRoot: ws,
      homeDir: home,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("nodesc.md");
    expect(problems[0]).toContain("description");
    expect(registry.get("nodesc")).toBeUndefined();
  });

  it("skips an empty body and reports it", () => {
    const ws = makeTempDir();
    const home = makeTempDir();
    writeSkill(
      path.join(ws, ".champ", "skills"),
      "empty.md",
      "---\nname: empty\ndescription: Has no body\n---\n   \n",
    );

    const { registry, problems } = loadCliSkills({
      workspaceRoot: ws,
      homeDir: home,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("empty skill body");
    expect(registry.get("empty")).toBeUndefined();
  });

  it("ignores non-markdown files", () => {
    const ws = makeTempDir();
    const home = makeTempDir();
    writeSkill(path.join(ws, ".champ", "skills"), "notes.txt", "not a skill");

    const { registry, problems } = loadCliSkills({
      workspaceRoot: ws,
      homeDir: home,
    });
    expect(problems).toEqual([]);
    expect(registry.list()).toHaveLength(8);
  });

  it("reports a reserved-name collision (help.md)", () => {
    const ws = makeTempDir();
    const home = makeTempDir();
    writeSkill(
      path.join(ws, ".champ", "skills"),
      "help.md",
      "---\nname: help\ndescription: Shadowed\n---\nHelp body",
    );

    const { registry, problems } = loadCliSkills({
      workspaceRoot: ws,
      homeDir: home,
    });
    expect(RESERVED_COMMANDS.has("help")).toBe(true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("shadowed");
    expect(registry.get("help")).toBeDefined();
  });

  it("strips a UTF-8 BOM before parsing", () => {
    const ws = makeTempDir();
    const home = makeTempDir();
    writeSkill(
      path.join(ws, ".champ", "skills"),
      "bom.md",
      "\uFEFF---\nname: bom\ndescription: BOM skill\n---\nBOM body",
    );

    const { registry, problems } = loadCliSkills({
      workspaceRoot: ws,
      homeDir: home,
    });
    expect(problems).toEqual([]);
    expect(registry.get("bom")?.template).toContain("BOM body");
  });

  it("registers built-ins only when skipDisk is true", () => {
    const ws = makeTempDir();
    const home = makeTempDir();
    writeSkill(
      path.join(ws, ".champ", "skills"),
      "custom.md",
      "---\nname: custom\ndescription: Custom\n---\nCustom body",
    );

    const { registry, problems } = loadCliSkills({
      workspaceRoot: ws,
      homeDir: home,
      skipDisk: true,
    });
    expect(problems).toEqual([]);
    expect(registry.get("custom")).toBeUndefined();
    expect(registry.list()).toHaveLength(8);
  });

  it("uses workspaceSkillsDir when injected without touching real home", () => {
    const ws = makeTempDir();
    const home = makeTempDir();
    const customDir = makeTempDir();
    writeSkill(
      customDir,
      "injected.md",
      "---\nname: injected\ndescription: Injected\n---\nInjected body",
    );

    const { registry, problems } = loadCliSkills({
      workspaceRoot: ws,
      homeDir: home,
      workspaceSkillsDir: customDir,
    });
    expect(problems).toEqual([]);
    expect(registry.get("injected")?.source).toBe("workspace");
  });
});
