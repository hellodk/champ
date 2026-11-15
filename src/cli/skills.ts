import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BUILT_IN_SKILL_TEXTS } from "../skills/built-in";
import { SkillLoader } from "../skills/skill-loader";
import { SkillRegistry } from "../skills/skill-registry";
import {
  VariableResolver,
  type SkillContext,
} from "../skills/variable-resolver";
import type { AgentMode } from "../agent/agent-controller";
import type { Skill, SkillSource } from "../skills/types";

export interface CliSkillsOptions {
  /** Absolute workspace root. */
  workspaceRoot: string;
  /** Injected in tests; defaults to os.homedir(). */
  homeDir?: string;
  /** `--no-skills`: register built-ins only. */
  skipDisk?: boolean;
  /** Overrides the workspace skills dir (tests). */
  workspaceSkillsDir?: string;
}

export interface LoadedCliSkills {
  registry: SkillRegistry;
  /** Human-readable problems, one per skipped file/collision. */
  problems: string[];
}

/**
 * Meta commands that always win over a same-named skill.
 * Bare names, no leading slash: "help", "exit", "quit", "q",
 * "session", "sessions", "checkpoint", "compact", "skills".
 */
export const RESERVED_COMMANDS: ReadonlySet<string> = new Set([
  "help",
  "exit",
  "quit",
  "q",
  "session",
  "sessions",
  "checkpoint",
  "compact",
  "skills",
]);

function loadSkillsFromDir(
  dir: string,
  source: SkillSource,
  registry: SkillRegistry,
  problems: string[],
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    const msg = err instanceof Error ? err.message : String(err);
    problems.push(`${dir}: ${msg}`);
    return;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = path.join(dir, entry.name);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      problems.push(`${filePath}: ${msg}`);
      continue;
    }

    const text = raw.replace(/^\uFEFF/, "");
    try {
      const skill = SkillLoader.parseFile(text, source, filePath);
      if (skill.template.trim() === "") {
        problems.push(`${filePath}: empty skill body`);
        continue;
      }
      registry.register(skill);
      const bare = skill.metadata.name.replace(/^\//, "");
      if (RESERVED_COMMANDS.has(bare)) {
        problems.push(
          `skill '${bare}' is shadowed by the built-in /${bare} command`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      problems.push(`${filePath}: ${msg}`);
    }
  }
}

/**
 * Load built-in, workspace, and user skills into a SkillRegistry.
 * Never throws for disk or parse problems; problems are returned for stderr reporting.
 */
export function loadCliSkills(opts: CliSkillsOptions): LoadedCliSkills {
  const registry = new SkillRegistry();
  const problems: string[] = [];

  for (const entry of BUILT_IN_SKILL_TEXTS) {
    try {
      registry.register(SkillLoader.parseFile(entry.text, "built-in"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      problems.push(`built-in/${entry.name}: ${msg}`);
    }
  }

  if (!opts.skipDisk) {
    const wsDir =
      opts.workspaceSkillsDir ??
      path.join(opts.workspaceRoot, ".champ", "skills");
    const home = opts.homeDir ?? os.homedir();
    const userDir = path.join(home, ".champ", "skills");

    loadSkillsFromDir(wsDir, "workspace", registry, problems);
    loadSkillsFromDir(userDir, "user", registry, problems);
  }

  return { registry, problems };
}

export type InvocationResolution =
  | { kind: "skill"; invocation: ResolvedInvocation }
  | { kind: "reserved" }
  | { kind: "unknown"; name: string; suggestions: string[] }
  | { kind: "none" };

export interface ResolvedInvocation {
  skill: Skill;
  /** Template with {{variables}} substituted. */
  prompt: string;
  /** Everything after the skill name. */
  userInput: string;
  mode?: AgentMode;
  /** Non-fatal notes for stderr (never sent to the model). */
  notes: string[];
}

const SLASH_INVOCATION_RE = /^\/([A-Za-z][\w-]*)\s*(.*)$/s;

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".cs": "csharp",
  ".php": "php",
  ".md": "markdown",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".sh": "bash",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".hpp": "cpp",
  ".css": "css",
  ".html": "html",
  ".sql": "sql",
};

function languageForFile(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext];
}

/**
 * Build a SkillContext for headless CLI execution.
 */
export function buildSkillContext(
  workspaceRoot: string,
  userInput: string,
  opts?: { file?: string },
): { context: SkillContext; notes: string[] } {
  const notes: string[] = [];
  const context: SkillContext = {
    workspaceRoot,
    date: new Date().toISOString().slice(0, 10),
    userInput,
  };

  if (opts?.file) {
    const resolvedRoot = path.resolve(workspaceRoot);
    const resolvedFile = path.resolve(resolvedRoot, opts.file);
    const rel = path.relative(resolvedRoot, resolvedFile);
    const isInside =
      rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));

    if (isInside) {
      context.currentFile = rel.replace(/\\/g, "/");
    } else {
      context.currentFile = opts.file;
      notes.push(
        "[skills] --file is outside the workspace; glob rules will not match it.",
      );
    }

    const lang = languageForFile(opts.file);
    if (lang) {
      context.language = lang;
    }
  }

  return { context, notes };
}

function suggestSkills(registry: SkillRegistry, name: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const s of registry.matchPrefix(name)) {
    if (!seen.has(s.metadata.name)) {
      seen.add(s.metadata.name);
      out.push(s.metadata.name);
      if (out.length === 3) return out;
    }
  }

  const lowered = name.toLowerCase();
  for (const s of registry.list()) {
    if (
      !seen.has(s.metadata.name) &&
      s.metadata.name.toLowerCase().includes(lowered)
    ) {
      seen.add(s.metadata.name);
      out.push(s.metadata.name);
      if (out.length === 3) return out;
    }
  }

  return out;
}

function collectEditorNotes(skill: Skill, context: SkillContext): string[] {
  const placeholders: Array<{ token: string; key: keyof SkillContext }> = [
    { token: "{{selection}}", key: "selection" },
    { token: "{{currentFile}}", key: "currentFile" },
    { token: "{{cursorLine}}", key: "cursorLine" },
    { token: "{{language}}", key: "language" },
  ];

  const missingTokens: string[] = [];
  let needsFileFlag = false;

  for (const { token, key } of placeholders) {
    if (skill.template.includes(token)) {
      const val = context[key];
      if (val === undefined || val === "") {
        missingTokens.push(token);
        if (key === "currentFile" || key === "language") {
          needsFileFlag = true;
        }
      }
    }
  }

  if (missingTokens.length === 0) return [];

  const list = missingTokens.join(", ");
  const verb = missingTokens.length === 1 ? "is" : "are";
  const fileHint = needsFileFlag ? " or use --file <path>." : "";
  return [
    `[skills] /${skill.metadata.name}: ${list} ${verb} empty — the CLI has no editor. Pass the code as arguments.${fileHint}`,
  ];
}

/**
 * Resolve a slash invocation against the skill registry.
 */
export function resolveInvocation(
  registry: SkillRegistry,
  text: string,
  context: SkillContext,
): InvocationResolution {
  const match = text.match(SLASH_INVOCATION_RE);
  if (!match) {
    return { kind: "none" };
  }

  const name = match[1];
  const args = match[2] ?? "";

  if (RESERVED_COMMANDS.has(name)) {
    return { kind: "reserved" };
  }

  const skill = registry.get(name);
  if (!skill) {
    return {
      kind: "unknown",
      name,
      suggestions: suggestSkills(registry, name),
    };
  }

  const userInput = args || (context.userInput ?? "");
  const effectiveContext: SkillContext = {
    ...context,
    userInput,
  };

  return {
    kind: "skill",
    invocation: {
      skill,
      prompt: VariableResolver.resolve(skill.template, effectiveContext),
      userInput,
      mode: skill.metadata.mode,
      notes: collectEditorNotes(skill, effectiveContext),
    },
  };
}

/**
 * Format all registered skills for `--list-skills` and `/skills`.
 */
export function formatSkillList(registry: SkillRegistry): string {
  const skills = registry.list();
  if (skills.length === 0) {
    return "[champ] no skills registered";
  }

  const sorted = [...skills].sort((a, b) => {
    const byName = a.metadata.name.localeCompare(b.metadata.name);
    if (byName !== 0) return byName;
    return a.source.localeCompare(b.source);
  });

  const nameWidth = Math.max(...sorted.map((s) => s.metadata.name.length));
  const modeWidth = Math.max(
    ...sorted.map((s) => (s.metadata.mode ?? "agent").length),
  );
  const sourceWidth = Math.max(...sorted.map((s) => s.source.length));

  const lines = ["[champ] skills (workspace > user > built-in)"];
  for (const s of sorted) {
    const name = `/${s.metadata.name}`.padEnd(nameWidth + 1);
    const mode = (s.metadata.mode ?? "agent").padEnd(modeWidth);
    const source = s.source.padEnd(sourceWidth);
    lines.push(`  ${name}  ${mode}  ${source}  ${s.metadata.description}`);
  }
  return lines.join("\n");
}
