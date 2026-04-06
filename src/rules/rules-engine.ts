/**
 * RulesEngine: loads, classifies, and selects project + user + team rules.
 *
 * Rules are per-workspace instructions the agent should honor — coding
 * conventions, domain facts, testing requirements, etc. They ship in
 * three "activation modes":
 *
 *   - always: attached to every prompt
 *   - auto-attached: attached when the current file matches a glob
 *   - agent-requested: not auto-attached; the agent can fetch by name
 *
 * Rules come from three sources:
 *
 *   - project: `.aidev/rules/*.md` in the workspace (committed, shared
 *     with the team)
 *   - user:    the `aidev.userRules` setting in VS Code (personal)
 *   - team:    pushed via a team dashboard (enterprise feature)
 *
 * The engine merges all three and exposes getActiveRules() for the
 * system prompt builder.
 */

export type RuleType = "always" | "auto-attached" | "agent-requested";
export type RuleSource = "project" | "user" | "team";

export interface Rule {
  name: string;
  content: string;
  type: RuleType;
  source: RuleSource;
  /** Glob pattern for auto-attached rules. Required when type='auto-attached'. */
  glob?: string;
}

/** Context used to decide which rules are active for a given request. */
export interface RuleContext {
  /** Relative path of the file the user is currently editing. */
  currentFile?: string;
  /** Active agent mode (agent/ask/manual/plan/composer/custom). */
  mode: string;
}

export class RulesEngine {
  private rules = new Map<string, Rule>();
  private userRules: Rule | null = null;

  /** Workspace root. Retained for future loadRulesFromDirectory implementation. */
  public readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Register a single rule. Overwrites any prior rule with the same name.
   */
  addRule(rule: Rule): void {
    this.rules.set(rule.name, rule);
  }

  /**
   * Remove a rule by name.
   */
  removeRule(name: string): void {
    this.rules.delete(name);
  }

  /**
   * Fetch a rule by name. Used for agent-requested rules that aren't
   * auto-attached — the agent asks for them explicitly via a
   * fetch_rules tool.
   */
  getRule(name: string): Rule | undefined {
    return this.rules.get(name);
  }

  /**
   * List every registered rule (project + team; not including the user
   * rule which is a single opaque string).
   */
  listRules(): Rule[] {
    return Array.from(this.rules.values());
  }

  /**
   * Set the user's global rules (a single free-form string from VS Code
   * settings). This is wrapped in a synthetic Rule so the rest of the
   * pipeline can treat it uniformly.
   */
  setUserRules(content: string): void {
    if (!content.trim()) {
      this.userRules = null;
      return;
    }
    this.userRules = {
      name: "user-rules",
      content: content.trim(),
      type: "always",
      source: "user",
    };
  }

  /**
   * Load rules from a directory. In the default export-only
   * implementation this is a stub; tests override it via vi.fn() to
   * control the return value. The production implementation reads
   * .md files with frontmatter from `.aidev/rules/` in the workspace.
   */
  async loadRulesFromDirectory(_directory: string): Promise<Rule[]> {
    // Placeholder: the production implementation will use
    // vscode.workspace.fs.readDirectory + readFile to load .md files
    // with YAML frontmatter ({name, type, glob}). For now this is a
    // no-op that tests can override.
    return [];
  }

  /**
   * Compute the set of rules that should be injected into the current
   * system prompt. Includes:
   *   - all `always` rules
   *   - auto-attached rules whose glob matches the current file
   *   - the user rule (if set)
   * Does NOT include agent-requested rules; those are fetched on demand.
   */
  getActiveRules(context: RuleContext): Rule[] {
    const active: Rule[] = [];

    for (const rule of this.rules.values()) {
      if (rule.type === "always") {
        active.push(rule);
      } else if (
        rule.type === "auto-attached" &&
        rule.glob &&
        context.currentFile
      ) {
        if (this.matchesGlob(context.currentFile, rule.glob)) {
          active.push(rule);
        }
      }
      // agent-requested rules are never auto-included
    }

    if (this.userRules) {
      active.push(this.userRules);
    }

    return active;
  }

  /**
   * Minimal glob matcher. Handles `*` (any characters except path sep),
   * `**` (any characters including sep), and literal characters.
   * Good enough for the patterns we care about (*.ts, src/** /*.py, etc.)
   * without dragging in a full glob library.
   */
  private matchesGlob(filePath: string, glob: string): boolean {
    // Normalize path separators for cross-platform matching.
    const normalized = filePath.replace(/\\/g, "/");
    const pattern = this.globToRegex(glob);
    return pattern.test(normalized);
  }

  private globToRegex(glob: string): RegExp {
    let regex = "";
    let i = 0;
    while (i < glob.length) {
      const ch = glob[i];
      if (ch === "*") {
        if (glob[i + 1] === "*") {
          regex += ".*";
          i += 2;
          // Consume an optional trailing slash so "src/**/x" matches
          // both "src/x" and "src/a/b/x".
          if (glob[i] === "/") i++;
        } else {
          regex += "[^/]*";
          i++;
        }
      } else if (ch === "?") {
        regex += "[^/]";
        i++;
      } else if (".+^$()|{}[]\\".includes(ch)) {
        regex += "\\" + ch;
        i++;
      } else {
        regex += ch;
        i++;
      }
    }
    // Anchor to end; allow match anywhere at start for simple patterns
    // like "*.ts" which should match "src/main.ts".
    return new RegExp(`(^|/)${regex}$`);
  }
}
