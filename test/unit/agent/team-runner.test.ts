import { describe, it, expect } from "vitest";
import { TeamRunner } from "@/agent/team-runner";
import type { TeamDefinition } from "@/agent/team-definition";

function makeAgent(
  id: string,
  deps: string[] = [],
  condition = "",
): Required<import("@/agent/team-definition").TeamAgentDefinition> {
  return {
    id,
    name: id,
    role: `role of ${id}`,
    systemPrompt: `You are ${id}`,
    dependsOn: deps,
    condition,
    tools: [],
    model: "",
    maxTokens: 1000,
    outputKey: id,
    outputFormat: "text" as const,
    selfCritique: false,
  };
}

function makeTeam(agents: ReturnType<typeof makeAgent>[]): TeamDefinition {
  return {
    name: "Test Team",
    description: "Test",
    version: "1",
    sourcePath: "/test/team.yaml",
    defaults: {},
    execution: {
      maxParallel: 3,
      totalTokenBudget: 100_000,
      timeoutSeconds: 10,
      retries: 0,
      checkpoints: false,
      mode: "auto",
    },
    agents,
  };
}

describe("TeamRunner — DAG scheduling", () => {
  it("puts independent agents in group 0", () => {
    const runner = new TeamRunner();
    const agents = [makeAgent("a"), makeAgent("b"), makeAgent("c")];
    const groups = runner.computeExecutionGroups(agents);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((a) => a.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("puts dependent agents in subsequent groups", () => {
    const runner = new TeamRunner();
    const agents = [makeAgent("pm"), makeAgent("infra", ["pm"])];
    const groups = runner.computeExecutionGroups(agents);
    expect(groups).toHaveLength(2);
    expect(groups[0].map((a) => a.id)).toEqual(["pm"]);
    expect(groups[1].map((a) => a.id)).toEqual(["infra"]);
  });

  it("puts parallel siblings in the same group", () => {
    const runner = new TeamRunner();
    const agents = [
      makeAgent("pm"),
      makeAgent("infra", ["pm"]),
      makeAgent("cicd", ["pm"]),
    ];
    const groups = runner.computeExecutionGroups(agents);
    expect(groups).toHaveLength(2);
    expect(groups[1].map((a) => a.id).sort()).toEqual(["cicd", "infra"]);
  });

  it("computes three-level DAG correctly", () => {
    const runner = new TeamRunner();
    const agents = [
      makeAgent("pm"),
      makeAgent("infra", ["pm"]),
      makeAgent("cicd", ["pm"]),
      makeAgent("security", ["infra", "cicd"]),
    ];
    const groups = runner.computeExecutionGroups(agents);
    expect(groups).toHaveLength(3);
    expect(groups[2].map((a) => a.id)).toEqual(["security"]);
  });

  it("returns empty groups for empty agents array", () => {
    const runner = new TeamRunner();
    const groups = runner.computeExecutionGroups([]);
    expect(groups).toHaveLength(0);
  });
});

describe("TeamRunner — shouldSkipAgent", () => {
  it("returns false when condition is empty (always run)", () => {
    const runner = new TeamRunner();
    const agent = makeAgent("infra", [], "");
    expect(runner.shouldSkipAgent(agent, {})).toBe(false);
  });

  it("returns true when condition evaluates to false", () => {
    const runner = new TeamRunner();
    const agent = makeAgent("infra", [], "plan.infra != null");
    const mem = { plan: { infra: null } };
    expect(runner.shouldSkipAgent(agent, mem)).toBe(true);
  });

  it("returns false when condition evaluates to true", () => {
    const runner = new TeamRunner();
    const agent = makeAgent("infra", [], "plan.infra != null");
    const mem = { plan: { infra: "deploy k8s" } };
    expect(runner.shouldSkipAgent(agent, mem)).toBe(false);
  });
});
