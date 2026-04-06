/**
 * TDD: Tests for SystemPromptBuilder.
 * Validates prompt construction with templates, modes, and rules.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { SystemPromptBuilder } from "@/prompts/system-prompt";

describe("SystemPromptBuilder", () => {
  let builder: SystemPromptBuilder;

  beforeEach(() => {
    builder = new SystemPromptBuilder();
  });

  it("should build a base system prompt with environment variables", () => {
    const prompt = builder.build({
      mode: "agent",
      environment: {
        os: "linux",
        workspaceName: "my-project",
        workspaceRoot: "/home/user/my-project",
        openFiles: ["src/main.ts", "src/utils.ts"],
        currentFile: "src/main.ts",
        currentSelection: "const x = 1;",
      },
    });

    expect(prompt).toContain("linux");
    expect(prompt).toContain("my-project");
    expect(prompt).toContain("src/main.ts");
  });

  it("should append agent mode instructions", () => {
    const prompt = builder.build({
      mode: "agent",
      environment: {
        os: "linux",
        workspaceName: "test",
        workspaceRoot: "/test",
      },
    });

    expect(prompt).toContain("autonomous");
    expect(prompt).toContain("Agent");
  });

  it("should append ask mode instructions", () => {
    const prompt = builder.build({
      mode: "ask",
      environment: {
        os: "linux",
        workspaceName: "test",
        workspaceRoot: "/test",
      },
    });

    expect(prompt).toContain("Read-Only");
    expect(prompt).toContain("Do NOT use edit_file");
  });

  it("should append manual mode instructions", () => {
    const prompt = builder.build({
      mode: "manual",
      environment: {
        os: "linux",
        workspaceName: "test",
        workspaceRoot: "/test",
      },
    });

    expect(prompt).toContain("Manual");
    expect(prompt).toContain("approval");
  });

  it("should append plan mode instructions", () => {
    const prompt = builder.build({
      mode: "plan",
      environment: {
        os: "linux",
        workspaceName: "test",
        workspaceRoot: "/test",
      },
    });

    expect(prompt).toContain("Plan");
    expect(prompt).toContain("Do NOT make any edits");
  });

  it("should append composer mode instructions", () => {
    const prompt = builder.build({
      mode: "composer",
      environment: {
        os: "linux",
        workspaceName: "test",
        workspaceRoot: "/test",
      },
    });

    expect(prompt).toContain("Composer");
    expect(prompt).toContain("diff");
  });

  it("should inject project rules", () => {
    const prompt = builder.build({
      mode: "agent",
      environment: {
        os: "linux",
        workspaceName: "test",
        workspaceRoot: "/test",
      },
      rules: [
        { name: "style-guide", content: "Use 2-space indent", type: "always" },
      ],
    });

    expect(prompt).toContain("Use 2-space indent");
    expect(prompt).toContain("style-guide");
  });

  it("should inject user rules", () => {
    const prompt = builder.build({
      mode: "agent",
      environment: {
        os: "linux",
        workspaceName: "test",
        workspaceRoot: "/test",
      },
      userRules: "Always write tests first. Use TypeScript strict mode.",
    });

    expect(prompt).toContain("Always write tests first");
  });

  it("should include guidelines section", () => {
    const prompt = builder.build({
      mode: "agent",
      environment: {
        os: "linux",
        workspaceName: "test",
        workspaceRoot: "/test",
      },
    });

    expect(prompt).toContain("Guidelines");
    expect(prompt).toContain("read files before editing");
  });
});
