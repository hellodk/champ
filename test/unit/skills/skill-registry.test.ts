/**
 * TDD: Tests for SkillRegistry.
 *
 * The registry holds every loaded skill. Skills can be registered
 * individually (by built-in loader at activation) or in bulk via
 * loadFromDirectory (for user/workspace skills). Lookups by name and
 * by prefix are required for chat invocation and autocomplete.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SkillRegistry } from "@/skills/skill-registry";
import type { Skill } from "@/skills/types";

function makeSkill(name: string, source: Skill["source"] = "built-in"): Skill {
  return {
    metadata: {
      name,
      description: `${name} description`,
      trigger: `/${name}`,
    },
    template: `Template for ${name}`,
    source,
  };
}

describe("SkillRegistry", () => {
  let registry: SkillRegistry;

  beforeEach(() => {
    registry = new SkillRegistry();
  });

  it("registers and retrieves a skill by name", () => {
    const skill = makeSkill("explain");
    registry.register(skill);
    expect(registry.get("explain")).toBe(skill);
  });

  it("returns undefined for unknown names", () => {
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("lists all registered skills", () => {
    registry.register(makeSkill("explain"));
    registry.register(makeSkill("test"));
    registry.register(makeSkill("commit"));
    const all = registry.list();
    expect(all).toHaveLength(3);
    const names = all.map((s) => s.metadata.name);
    expect(names).toContain("explain");
    expect(names).toContain("test");
    expect(names).toContain("commit");
  });

  it("unregisters a skill", () => {
    registry.register(makeSkill("explain"));
    registry.unregister("explain");
    expect(registry.get("explain")).toBeUndefined();
  });

  it("matchPrefix returns skills whose name starts with the prefix", () => {
    registry.register(makeSkill("explain"));
    registry.register(makeSkill("examine"));
    registry.register(makeSkill("test"));
    const matches = registry.matchPrefix("ex");
    expect(matches).toHaveLength(2);
    const names = matches.map((s) => s.metadata.name).sort();
    expect(names).toEqual(["examine", "explain"]);
  });

  it("matchPrefix is case-insensitive", () => {
    registry.register(makeSkill("Explain"));
    const matches = registry.matchPrefix("ex");
    expect(matches).toHaveLength(1);
  });

  it("matchPrefix returns an empty array when nothing matches", () => {
    registry.register(makeSkill("explain"));
    expect(registry.matchPrefix("xyz")).toHaveLength(0);
  });

  it("matchPrefix returns all skills for empty prefix", () => {
    registry.register(makeSkill("a"));
    registry.register(makeSkill("b"));
    expect(registry.matchPrefix("")).toHaveLength(2);
  });

  it("registering a skill with the same name overwrites the previous one", () => {
    const v1 = makeSkill("explain", "built-in");
    const v2 = makeSkill("explain", "user");
    registry.register(v1);
    registry.register(v2);
    expect(registry.get("explain")?.source).toBe("user");
    expect(registry.list()).toHaveLength(1);
  });

  it("clear removes every registered skill", () => {
    registry.register(makeSkill("a"));
    registry.register(makeSkill("b"));
    registry.clear();
    expect(registry.list()).toHaveLength(0);
  });

  describe("source precedence", () => {
    it("workspace skills override user skills", () => {
      registry.register(makeSkill("explain", "user"));
      registry.register(makeSkill("explain", "workspace"));
      expect(registry.get("explain")?.source).toBe("workspace");
    });

    it("user skills override built-in skills", () => {
      registry.register(makeSkill("explain", "built-in"));
      registry.register(makeSkill("explain", "user"));
      expect(registry.get("explain")?.source).toBe("user");
    });

    it("built-in skills do NOT override workspace skills", () => {
      registry.register(makeSkill("explain", "workspace"));
      registry.register(makeSkill("explain", "built-in"));
      // The workspace one should still win.
      expect(registry.get("explain")?.source).toBe("workspace");
    });
  });
});
