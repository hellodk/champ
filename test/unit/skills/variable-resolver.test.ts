/**
 * TDD: Tests for VariableResolver.
 *
 * Resolves {{variable}} placeholders in skill templates. Uses a simple
 * textual substitution — no template engine, no conditionals. Unknown
 * placeholders are left intact so the user notices the typo.
 */
import { describe, it, expect } from "vitest";
import {
  VariableResolver,
  type SkillContext,
} from "@/skills/variable-resolver";

const baseContext: SkillContext = {
  workspaceRoot: "/work",
  date: "2026-04-08",
};

describe("VariableResolver", () => {
  it("substitutes a single variable", () => {
    const out = VariableResolver.resolve("Hello {{userInput}}", {
      ...baseContext,
      userInput: "world",
    });
    expect(out).toBe("Hello world");
  });

  it("substitutes multiple distinct variables", () => {
    const out = VariableResolver.resolve(
      "File: {{currentFile}}\nLang: {{language}}",
      {
        ...baseContext,
        currentFile: "src/main.ts",
        language: "typescript",
      },
    );
    expect(out).toContain("File: src/main.ts");
    expect(out).toContain("Lang: typescript");
  });

  it("substitutes the same variable multiple times", () => {
    const out = VariableResolver.resolve("{{language}} → {{language}}", {
      ...baseContext,
      language: "rust",
    });
    expect(out).toBe("rust → rust");
  });

  it("leaves unknown variables as literal text", () => {
    const out = VariableResolver.resolve("Hi {{nope}}", baseContext);
    expect(out).toBe("Hi {{nope}}");
  });

  it("treats unset context fields as empty string", () => {
    const out = VariableResolver.resolve("[{{selection}}]", baseContext);
    expect(out).toBe("[]");
  });

  it("substitutes selection verbatim without escaping", () => {
    const code = `function add(a, b) {\n  return a + b;\n}`;
    const out = VariableResolver.resolve("```\n{{selection}}\n```", {
      ...baseContext,
      selection: code,
    });
    expect(out).toContain("function add(a, b)");
    expect(out).toContain("return a + b;");
  });

  it("supports all the documented variables", () => {
    const ctx: SkillContext = {
      workspaceRoot: "/work",
      date: "2026-04-08",
      selection: "sel",
      currentFile: "f.ts",
      language: "typescript",
      userInput: "input",
      cursorLine: 42,
      branch: "main",
    };
    const template = `${[
      "{{selection}}",
      "{{currentFile}}",
      "{{language}}",
      "{{userInput}}",
      "{{cursorLine}}",
      "{{date}}",
      "{{branch}}",
      "{{workspaceRoot}}",
    ].join("|")}`;
    const out = VariableResolver.resolve(template, ctx);
    expect(out).toBe("sel|f.ts|typescript|input|42|2026-04-08|main|/work");
  });

  it("handles a template with no variables", () => {
    const out = VariableResolver.resolve("just plain text", baseContext);
    expect(out).toBe("just plain text");
  });

  it("does not match malformed placeholders", () => {
    const out = VariableResolver.resolve(
      "{single} { {double space} } {{ }}",
      baseContext,
    );
    expect(out).toBe("{single} { {double space} } {{ }}");
  });
});
