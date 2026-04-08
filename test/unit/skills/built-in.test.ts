/**
 * TDD: Tests for the 8 built-in skills shipped with AIDev.
 *
 * Verifies every built-in parses cleanly, has the required metadata,
 * and uses only the documented variable placeholders. This catches
 * typos in the inlined markdown at test time rather than at runtime.
 */
import { describe, it, expect } from "vitest";
import { BUILT_IN_SKILL_TEXTS } from "@/skills/built-in";
import { SkillLoader } from "@/skills/skill-loader";

const KNOWN_VARIABLES = new Set([
  "selection",
  "currentFile",
  "language",
  "userInput",
  "cursorLine",
  "date",
  "branch",
  "workspaceRoot",
]);

describe("Built-in skills", () => {
  it("ships all 8 skills documented in PLAN_SKILLS.md", () => {
    const names = BUILT_IN_SKILL_TEXTS.map((s) => s.name);
    expect(names).toEqual([
      "explain",
      "test",
      "refactor",
      "review",
      "commit",
      "doc",
      "fix",
      "optimize",
    ]);
  });

  for (const { name, text } of BUILT_IN_SKILL_TEXTS) {
    describe(`/${name}`, () => {
      const skill = SkillLoader.parseFile(text, "built-in");

      it("parses cleanly into a valid Skill", () => {
        expect(skill.metadata.name).toBe(name);
        expect(skill.metadata.description).toBeTruthy();
        expect(skill.template).toBeTruthy();
        expect(skill.source).toBe("built-in");
      });

      it("has a non-empty description", () => {
        expect(skill.metadata.description.length).toBeGreaterThan(10);
      });

      it("has a default trigger of /<name>", () => {
        expect(skill.metadata.trigger).toBe(`/${name}`);
      });

      it("uses only documented variable placeholders", () => {
        const placeholders = [
          ...skill.template.matchAll(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g),
        ].map((m) => m[1]);
        for (const p of placeholders) {
          expect(KNOWN_VARIABLES).toContain(p);
        }
      });
    });
  }
});
