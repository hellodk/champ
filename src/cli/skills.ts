import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BUILT_IN_SKILL_TEXTS } from "../skills/built-in";
import { SkillLoader } from "../skills/skill-loader";
import { SkillRegistry } from "../skills/skill-registry";
import type { SkillSource } from "../skills/types";

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
