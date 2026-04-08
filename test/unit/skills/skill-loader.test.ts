/**
 * TDD: Tests for SkillLoader.
 *
 * SkillLoader parses a markdown file with YAML frontmatter into a Skill
 * object. The frontmatter must include `name` and `description`; other
 * fields are optional. The body of the markdown is the prompt template
 * (with {{variables}} substituted at invocation time).
 *
 * See docs/PLAN_SKILLS.md for the schema.
 */
import { describe, it, expect } from "vitest";
import { SkillLoader } from "@/skills/skill-loader";

describe("SkillLoader", () => {
  describe("parseFrontmatter", () => {
    it("splits frontmatter and body at the closing ---", () => {
      const text = `---
name: explain
description: Explain code
---

Body line one.
Body line two.
`;
      const { meta, body } = SkillLoader.parseFrontmatter(text);
      expect(meta).toEqual({ name: "explain", description: "Explain code" });
      expect(body).toBe("Body line one.\nBody line two.\n");
    });

    it("throws when no frontmatter is present", () => {
      const text = "Just a markdown file with no frontmatter.";
      expect(() => SkillLoader.parseFrontmatter(text)).toThrow(/frontmatter/i);
    });

    it("throws when frontmatter is unterminated", () => {
      const text = `---
name: oops
this never closes
`;
      expect(() => SkillLoader.parseFrontmatter(text)).toThrow();
    });

    it("preserves whitespace and code fences in the body", () => {
      const text = `---
name: x
description: y
---

Some text.

\`\`\`typescript
const x = 1;
\`\`\`

More text.
`;
      const { body } = SkillLoader.parseFrontmatter(text);
      expect(body).toContain("```typescript");
      expect(body).toContain("const x = 1;");
    });
  });

  describe("parseFile", () => {
    it("returns a Skill with name, description, and template", () => {
      const text = `---
name: explain
description: Explain code in plain English
---

You are explaining code.

{{selection}}
`;
      const skill = SkillLoader.parseFile(text, "built-in");
      expect(skill.metadata.name).toBe("explain");
      expect(skill.metadata.description).toBe("Explain code in plain English");
      expect(skill.template).toContain("You are explaining code.");
      expect(skill.template).toContain("{{selection}}");
      expect(skill.source).toBe("built-in");
    });

    it("accepts optional mode and allowedTools fields", () => {
      const text = `---
name: review
description: Review code
mode: ask
allowedTools: [read_file, grep_search]
---

Review this code.
`;
      const skill = SkillLoader.parseFile(text, "user");
      expect(skill.metadata.mode).toBe("ask");
      expect(skill.metadata.allowedTools).toEqual(["read_file", "grep_search"]);
    });

    it("rejects skills missing the required name field", () => {
      const text = `---
description: No name
---
body`;
      expect(() => SkillLoader.parseFile(text, "user")).toThrow(/name/i);
    });

    it("rejects skills missing the required description field", () => {
      const text = `---
name: nodescription
---
body`;
      expect(() => SkillLoader.parseFile(text, "user")).toThrow(/description/i);
    });

    it("rejects invalid mode values", () => {
      const text = `---
name: x
description: y
mode: superduper
---
body`;
      expect(() => SkillLoader.parseFile(text, "user")).toThrow(/mode/i);
    });

    it("rejects allowedTools that is not an array of strings", () => {
      const text = `---
name: x
description: y
allowedTools: "read_file"
---
body`;
      expect(() => SkillLoader.parseFile(text, "user")).toThrow(
        /allowedtools/i,
      );
    });

    it("attaches the source label to the parsed skill", () => {
      const text = `---
name: x
description: y
---
body`;
      expect(SkillLoader.parseFile(text, "built-in").source).toBe("built-in");
      expect(SkillLoader.parseFile(text, "user").source).toBe("user");
      expect(SkillLoader.parseFile(text, "workspace").source).toBe("workspace");
    });

    it("uses /<name> as the default trigger when not specified", () => {
      const text = `---
name: explain
description: Explain
---
body`;
      const skill = SkillLoader.parseFile(text, "built-in");
      expect(skill.metadata.trigger).toBe("/explain");
    });

    it("honors a custom trigger when specified", () => {
      const text = `---
name: explain
description: Explain
trigger: /xp
---
body`;
      const skill = SkillLoader.parseFile(text, "built-in");
      expect(skill.metadata.trigger).toBe("/xp");
    });
  });
});
