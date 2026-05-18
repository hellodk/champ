// src/ui/__tests__/team-builder-panel.test.ts
import { describe, it, expect } from "vitest";
import { buildTeamYaml, parseAgentPositions } from "../team-builder-panel";
import { buildRuleMarkdown } from "../rules-editor-panel";
import type { TeamBuilderSaveRequest } from "../messages";

describe("buildTeamYaml", () => {
  it("serializes a minimal team to valid YAML", () => {
    const req: TeamBuilderSaveRequest["team"] = {
      name: "Test Team",
      description: "A test team",
      version: "1",
      agents: [
        {
          id: "planner",
          name: "Planner",
          role: "Plans the work",
          systemPrompt: "You are a planner.",
          dependsOn: [],
          condition: "",
          tools: [],
          model: "",
          maxTokens: 4096,
          outputKey: "planner",
          outputFormat: "text",
          selfCritique: false,
          subscribes: [],
        },
      ],
      defaults: {},
      execution: {
        maxParallel: 3,
        totalTokenBudget: 100000,
        timeoutSeconds: 120,
        retries: 1,
        checkpoints: true,
        mode: "auto",
      },
    };

    const yaml = buildTeamYaml(req);
    expect(yaml).toContain("name: Test Team");
    expect(yaml).toContain("description: A test team");
    expect(yaml).toContain("id: planner");
    expect(yaml).toContain("role: Plans the work");
  });

  it("omits empty optional fields (condition, tools, model)", () => {
    const req: TeamBuilderSaveRequest["team"] = {
      name: "Lean Team",
      description: "desc",
      version: "1",
      agents: [
        {
          id: "a1",
          name: "Agent One",
          role: "Does stuff",
          systemPrompt: "prompt",
          dependsOn: [],
          condition: "",
          tools: [],
          model: "",
          maxTokens: 4096,
          outputKey: "a1",
          outputFormat: "text",
          selfCritique: false,
          subscribes: [],
        },
      ],
      defaults: {},
      execution: {
        maxParallel: 3,
        totalTokenBudget: 100000,
        timeoutSeconds: 120,
        retries: 1,
        checkpoints: true,
        mode: "auto",
      },
    };

    const yaml = buildTeamYaml(req);
    expect(yaml).not.toContain("condition:");
    expect(yaml).not.toContain("tools:");
    expect(yaml).not.toContain("model:");
  });

  it("serializes dependsOn as a YAML sequence", () => {
    const req: TeamBuilderSaveRequest["team"] = {
      name: "Dep Team",
      description: "desc",
      version: "1",
      agents: [
        {
          id: "a",
          name: "A",
          role: "First",
          systemPrompt: "p",
          dependsOn: [],
          condition: "",
          tools: [],
          model: "",
          maxTokens: 4096,
          outputKey: "a",
          outputFormat: "text",
          selfCritique: false,
          subscribes: [],
        },
        {
          id: "b",
          name: "B",
          role: "Second",
          systemPrompt: "p",
          dependsOn: ["a"],
          condition: "",
          tools: [],
          model: "",
          maxTokens: 4096,
          outputKey: "b",
          outputFormat: "text",
          selfCritique: false,
          subscribes: [],
        },
      ],
      defaults: {},
      execution: {
        maxParallel: 3,
        totalTokenBudget: 100000,
        timeoutSeconds: 120,
        retries: 1,
        checkpoints: true,
        mode: "auto",
      },
    };

    const yaml = buildTeamYaml(req);
    expect(yaml).toContain("dependsOn:");
    expect(yaml).toContain("- a");
  });
});

describe("parseAgentPositions", () => {
  it("returns empty map for empty agents", () => {
    const result = parseAgentPositions([]);
    expect(result.size).toBe(0);
  });

  it("assigns a position to each agent", () => {
    const agents = [
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
    ];
    const result = parseAgentPositions(agents);
    expect(result.has("a")).toBe(true);
    expect(result.has("b")).toBe(true);
    const posA = result.get("a")!;
    const posB = result.get("b")!;
    // b should be below a (higher y) because it depends on a
    expect(posB.y).toBeGreaterThan(posA.y);
  });
});

describe("buildRuleMarkdown", () => {
  it("writes always rule without glob", () => {
    const md = buildRuleMarkdown({
      name: "no-console",
      content: "Never use console.log in production code.",
      type: "always",
    });
    expect(md).toContain("name: no-console");
    expect(md).toContain("type: always");
    expect(md).not.toContain("glob:");
    expect(md).toContain("Never use console.log in production code.");
  });

  it("writes auto-attached rule with glob", () => {
    const md = buildRuleMarkdown({
      name: "ts-style",
      content: "Prefer const over let.",
      type: "auto-attached",
      glob: "**/*.ts",
    });
    expect(md).toContain('glob: "**/*.ts"');
    expect(md).toContain("type: auto-attached");
  });
});
