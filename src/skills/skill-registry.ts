/**
 * SkillRegistry: central store for loaded skills.
 *
 * Holds every skill that has been registered (built-in, user, or
 * workspace). Lookups by name and by prefix support both chat
 * invocation and slash-command autocomplete.
 *
 * Source precedence (highest wins): workspace > user > built-in.
 * When a skill is registered with a name that already exists, the
 * registry compares sources and keeps the higher-precedence one.
 */
import type { Skill, SkillSource } from "./types";

const SOURCE_RANK: Record<SkillSource, number> = {
  "built-in": 0,
  user: 1,
  workspace: 2,
};

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  /**
   * Register a skill. If a skill with the same name already exists,
   * the higher-precedence source wins (workspace > user > built-in).
   * Same-source registration overwrites unconditionally.
   */
  register(skill: Skill): void {
    const existing = this.skills.get(skill.metadata.name);
    if (existing) {
      const existingRank = SOURCE_RANK[existing.source];
      const newRank = SOURCE_RANK[skill.source];
      if (newRank < existingRank) {
        // Lower-precedence source — keep the existing skill.
        return;
      }
    }
    this.skills.set(skill.metadata.name, skill);
  }

  /** Remove a skill by name. */
  unregister(name: string): void {
    this.skills.delete(name);
  }

  /** Look up a skill by exact name. Returns undefined if not registered. */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** Return every registered skill in insertion order. */
  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Return skills whose name starts with `prefix` (case-insensitive),
   * sorted alphabetically. Used for slash-command autocomplete.
   */
  matchPrefix(prefix: string): Skill[] {
    const lowered = prefix.toLowerCase();
    return this.list()
      .filter((s) => s.metadata.name.toLowerCase().startsWith(lowered))
      .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
  }

  /** Drop every registered skill. */
  clear(): void {
    this.skills.clear();
  }
}
