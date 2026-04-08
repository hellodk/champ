/**
 * Skills type definitions.
 *
 * A skill is a named, reusable prompt template invoked from chat with
 * `/<name>`. Skills are markdown files with YAML frontmatter; the body
 * is the prompt template (with {{variables}} substituted at invocation
 * time).
 *
 * See docs/PLAN_SKILLS.md for the full design.
 */
import type { AgentMode } from "../agent/agent-controller";

/**
 * Source of a skill — used for precedence (workspace > user > built-in)
 * and for telling the user where a skill came from in error messages.
 */
export type SkillSource = "built-in" | "user" | "workspace";

/**
 * Parsed YAML frontmatter from a skill file. `name` and `description`
 * are required; other fields are optional and have sensible defaults.
 */
export interface SkillFrontmatter {
  name: string;
  description: string;
  /** Slash-command trigger. Defaults to `/<name>` if absent. */
  trigger?: string;
  /** Optional mode override — useful for /explain (ask) or /commit (manual). */
  mode?: AgentMode;
  /** Optional tool restriction — names from the ToolRegistry. */
  allowedTools?: string[];
}

/**
 * A loaded skill: metadata plus the markdown body that becomes the
 * prompt after variable substitution.
 */
export interface Skill {
  metadata: SkillFrontmatter;
  /** Markdown body with {{variables}} placeholders. */
  template: string;
  /** Where this skill came from (for precedence and error messages). */
  source: SkillSource;
  /** Disk path for user/workspace skills (undefined for built-in). */
  filePath?: string;
}
