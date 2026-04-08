/**
 * SkillLoader: parses a markdown file with YAML frontmatter into a Skill.
 *
 * The file format is:
 *
 *   ---
 *   name: explain
 *   description: Explain code
 *   mode: ask                # optional
 *   allowedTools: [read_file] # optional
 *   trigger: /xp             # optional, defaults to /<name>
 *   ---
 *
 *   The body is the prompt template with {{variables}}.
 *
 * Validation is strict — required fields throw clear errors with the
 * field name so the user can fix the file. Invalid YAML throws too.
 */
import * as yaml from "js-yaml";
import type { Skill, SkillFrontmatter, SkillSource } from "./types";
import type { AgentMode } from "../agent/agent-controller";

const VALID_MODES: AgentMode[] = ["agent", "ask", "manual", "plan", "composer"];

export class SkillLoader {
  /**
   * Split a markdown file into its YAML frontmatter and body. The
   * frontmatter must be the first thing in the file, opened and closed
   * by `---` on a line of its own.
   */
  static parseFrontmatter(text: string): { meta: unknown; body: string } {
    if (!text.startsWith("---")) {
      throw new Error(
        "Skill file must begin with YAML frontmatter (`---` line)",
      );
    }
    // Find the closing --- on a line by itself.
    const lines = text.split("\n");
    if (lines[0].trim() !== "---") {
      throw new Error(
        "Skill file must begin with YAML frontmatter (`---` line)",
      );
    }
    let closeIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx === -1) {
      throw new Error("Unterminated YAML frontmatter (missing closing `---`)");
    }
    const yamlText = lines.slice(1, closeIdx).join("\n");
    const body = lines.slice(closeIdx + 1).join("\n");

    let meta: unknown;
    try {
      meta = yaml.load(yamlText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid YAML in skill frontmatter: ${msg}`);
    }

    return { meta, body: body.startsWith("\n") ? body.slice(1) : body };
  }

  /**
   * Parse a complete skill file into a Skill object. Validates the
   * frontmatter against the schema and populates defaults.
   */
  static parseFile(
    text: string,
    source: SkillSource,
    filePath?: string,
  ): Skill {
    const { meta, body } = SkillLoader.parseFrontmatter(text);

    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) {
      throw new Error("Skill frontmatter must be a YAML object");
    }
    const m = meta as Record<string, unknown>;

    if (typeof m.name !== "string" || !m.name.trim()) {
      throw new Error("Skill frontmatter missing required field: `name`");
    }
    if (typeof m.description !== "string" || !m.description.trim()) {
      throw new Error(
        "Skill frontmatter missing required field: `description`",
      );
    }

    const fm: SkillFrontmatter = {
      name: m.name,
      description: m.description,
      trigger: typeof m.trigger === "string" ? m.trigger : `/${m.name}`,
    };

    if ("mode" in m) {
      if (
        typeof m.mode !== "string" ||
        !VALID_MODES.includes(m.mode as AgentMode)
      ) {
        throw new Error(
          `Skill frontmatter \`mode\` must be one of: ${VALID_MODES.join(", ")}`,
        );
      }
      fm.mode = m.mode as AgentMode;
    }

    if ("allowedTools" in m) {
      if (
        !Array.isArray(m.allowedTools) ||
        m.allowedTools.some((t) => typeof t !== "string")
      ) {
        throw new Error(
          "Skill frontmatter `allowedTools` must be an array of strings",
        );
      }
      fm.allowedTools = m.allowedTools as string[];
    }

    return {
      metadata: fm,
      template: body,
      source,
      filePath,
    };
  }
}
