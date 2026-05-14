import { describe, it, expect } from "vitest";
import { TeamLoader } from "@/agent/team-loader";

const VALID_YAML = `
name: DevOps Platform Team
description: Infrastructure and CI/CD specialists
agents:
  - id: pm
    name: Program Manager
    role: Plans the work
    systemPrompt: You are a PM. Output JSON.
  - id: infra
    name: Infra Engineer
    role: Writes Terraform
    systemPrompt: You are an infra engineer.
    dependsOn: [pm]
    condition: "plan.infra != null"
    tools: [read_file, create_file]
`.trim();

const MISSING_AGENTS_YAML = `
name: Bad Team
description: Missing agents array
`.trim();

const DUPLICATE_IDS_YAML = `
name: Bad Team
description: Duplicate IDs
agents:
  - id: pm
    name: PM
    role: Plans
    systemPrompt: prompt
  - id: pm
    name: PM2
    role: Plans again
    systemPrompt: prompt2
`.trim();

const FORWARD_REF_YAML = `
name: Bad Team
description: Forward reference to nonexistent agent
agents:
  - id: infra
    name: Infra
    role: Does infra
    systemPrompt: prompt
    dependsOn: [nonexistent]
`.trim();

const CYCLE_YAML = `
name: Cycle Team
description: Has a cycle
agents:
  - id: a
    name: A
    role: role a
    systemPrompt: prompt a
    dependsOn: [b]
  - id: b
    name: B
    role: role b
    systemPrompt: prompt b
    dependsOn: [a]
`.trim();

describe("TeamLoader", () => {
  it("parses a valid team YAML string", () => {
    const loader = new TeamLoader("/workspace");
    const team = loader.parseYaml(VALID_YAML, "devops.yaml");
    expect(team.name).toBe("DevOps Platform Team");
    expect(team.agents).toHaveLength(2);
    expect(team.agents[0].id).toBe("pm");
    expect(team.agents[1].dependsOn).toEqual(["pm"]);
    expect(team.agents[1].condition).toBe("plan.infra != null");
    expect(team.agents[1].tools).toEqual(["read_file", "create_file"]);
  });

  it("throws on missing agents array", () => {
    const loader = new TeamLoader("/workspace");
    expect(() => loader.parseYaml(MISSING_AGENTS_YAML, "bad.yaml")).toThrow(
      /agents/i,
    );
  });

  it("throws on duplicate agent IDs", () => {
    const loader = new TeamLoader("/workspace");
    expect(() => loader.parseYaml(DUPLICATE_IDS_YAML, "bad.yaml")).toThrow(
      /duplicate/i,
    );
  });

  it("throws when dependsOn references nonexistent agent ID", () => {
    const loader = new TeamLoader("/workspace");
    expect(() => loader.parseYaml(FORWARD_REF_YAML, "bad.yaml")).toThrow(
      /nonexistent/,
    );
  });

  it("throws on circular dependency", () => {
    const loader = new TeamLoader("/workspace");
    expect(() => loader.parseYaml(CYCLE_YAML, "cycle.yaml")).toThrow(/cycle/i);
  });

  it("returns empty array when teams directory does not exist", async () => {
    const loader = new TeamLoader("/nonexistent-workspace-xyz");
    const teams = await loader.loadAll();
    expect(teams).toEqual([]);
  });

  it("applies defaults to agents that omit optional fields", () => {
    const loader = new TeamLoader("/workspace");
    const team = loader.parseYaml(VALID_YAML, "devops.yaml");
    // pm has no dependsOn — should default to []
    expect(team.agents[0].dependsOn).toEqual([]);
    // no execution block — should have defaults
    expect(team.execution.maxParallel).toBe(3);
    expect(team.execution.retries).toBe(1);
    expect(team.execution.timeoutSeconds).toBe(120);
  });

  it("throws on null agent entry in agents array", () => {
    const loader = new TeamLoader("/workspace");
    const yaml = `
name: Test
description: Test
agents:
  - null
`.trim();
    expect(() => loader.parseYaml(yaml, "test.yaml")).toThrow(
      /mapping object/i,
    );
  });

  it("throws on invalid execution.mode", () => {
    const loader = new TeamLoader("/workspace");
    const yaml = `
name: Test
description: Test
execution:
  mode: turbo
agents:
  - id: a
    name: A
    role: role
    systemPrompt: prompt
`.trim();
    expect(() => loader.parseYaml(yaml, "test.yaml")).toThrow(/mode/i);
  });

  it("throws on unknown tool name", () => {
    const loader = new TeamLoader("/workspace");
    const yaml = `
name: Test
description: Test
agents:
  - id: a
    name: A
    role: role
    systemPrompt: prompt
    tools: [unknown_tool]
`.trim();
    expect(() => loader.parseYaml(yaml, "test.yaml")).toThrow(/unknown_tool/);
  });

  it("handles temperature: 0 correctly (not discarded as falsy)", () => {
    const loader = new TeamLoader("/workspace");
    const yaml = `
name: Test
description: Test
defaults:
  temperature: 0
agents:
  - id: a
    name: A
    role: role
    systemPrompt: prompt
`.trim();
    const team = loader.parseYaml(yaml, "test.yaml");
    expect(team.defaults.temperature).toBe(0);
  });
});
