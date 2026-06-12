import { describe, it, expect } from "vitest";
import { SystemPromptBuilder } from "../../../src/agent/system-prompt-builder";

describe("SystemPromptBuilder", () => {
  it("builds system content with base instructions for agent mode", () => {
    const builder = new SystemPromptBuilder("agent");
    const content = builder.buildSystemContent("");
    expect(content).toContain("Champ");
    expect(content.length).toBeGreaterThan(100);
  });

  it("injects repo map into system content", () => {
    const builder = new SystemPromptBuilder("agent");
    const content = builder.buildSystemContent(
      "## Repo Map\n- src/\n  - index.ts",
    );
    expect(content).toContain("Repo Map");
  });

  it("injects project rules into system content", () => {
    const builder = new SystemPromptBuilder("agent");
    builder.setProjectRules("Always write tests.");
    const content = builder.buildSystemContent("");
    expect(content).toContain("Always write tests.");
    expect(content).toContain("Project Rules");
  });

  it("invalidates cache when mode changes", () => {
    const builder = new SystemPromptBuilder("agent");
    const agentContent = builder.buildSystemContent("");
    builder.setMode("ask");
    const askContent = builder.buildSystemContent("");
    expect(agentContent).not.toBe(askContent);
  });

  it("withInjectedToolPrompt prepends system message to history", () => {
    const builder = new SystemPromptBuilder("agent");
    const history = [{ role: "user" as const, content: "hello" }];
    const result = builder.withInjectedToolPrompt(history, [], "");
    expect(result[0].role).toBe("system");
    expect(result[1]).toEqual({ role: "user", content: "hello" });
  });

  it("withGroundingSystemPrompt prepends system message", () => {
    const builder = new SystemPromptBuilder("agent");
    const result = builder.withGroundingSystemPrompt([], "");
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("system");
  });

  it("prependOrMergeSystem merges with existing system message", () => {
    const builder = new SystemPromptBuilder("agent");
    const history = [
      { role: "system" as const, content: "existing" },
      { role: "user" as const, content: "hello" },
    ];
    const result = builder.withGroundingSystemPrompt(history, "");
    expect(result[0].role).toBe("system");
    expect(result[0].content as string).toContain("existing");
    expect(result).toHaveLength(2);
  });
});
