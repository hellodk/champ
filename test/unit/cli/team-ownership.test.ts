import { describe, it, expect } from "vitest";
import { TeamLoader } from "@/agent/team-loader";
import { TeamRunner } from "@/agent/team-runner";
import {
  findOwnershipConflicts,
  ownershipPatternIssues,
} from "@/cli/team-ownership";

function team(yaml: string) {
  return new TeamLoader("/workspace").parseYaml(yaml, "/workspace/team.yaml");
}

function conflictsFor(yaml: string): string[] {
  const definition = team(yaml);
  const runner = new TeamRunner();
  return findOwnershipConflicts(
    definition,
    runner.computeExecutionGroups(definition.agents),
  );
}

const base = (agents: string) => `
name: Test Team
description: Ownership rules
agents:
${agents}
`;

describe("CLI team file ownership", () => {
  it("accepts parallel mutators with disjoint owns patterns", () => {
    const issues = conflictsFor(
      base(`
  - id: a
    name: A
    role: writes src
    systemPrompt: a
    tools: [edit_file]
    owns: [src/a/**]
  - id: b
    name: B
    role: writes docs
    systemPrompt: b
    tools: [create_file]
    owns: [docs/**]
`),
    );
    expect(issues).toEqual([]);
  });

  it("rejects parallel mutators with overlapping owns patterns", () => {
    const issues = conflictsFor(
      base(`
  - id: a
    name: A
    role: writes src
    systemPrompt: a
    tools: [edit_file]
    owns: [src/**]
  - id: b
    name: B
    role: writes src too
    systemPrompt: b
    tools: [create_file]
    owns: [src/shared.ts]
`),
    );
    expect(issues).toContainEqual(
      expect.stringContaining("own overlapping paths"),
    );
  });

  it("rejects a mutator that declares no ownership", () => {
    const issues = conflictsFor(
      base(`
  - id: a
    name: A
    role: writes files
    systemPrompt: a
    tools: [delete_file]
`),
    );
    expect(issues).toContainEqual(
      expect.stringContaining("declares no owns patterns"),
    );
  });

  it("rejects absolute and parent-traversal ownership patterns", () => {
    expect(
      ownershipPatternIssues("a", ["/etc/passwd", "../outside", "src/ok/**"]),
    ).toEqual([
      expect.stringContaining("must be workspace-relative"),
      expect.stringContaining("must be workspace-relative"),
    ]);
  });

  it("ignores read-only agents", () => {
    expect(
      conflictsFor(
        base(`
  - id: reader
    name: Reader
    role: reads files
    systemPrompt: reader
    tools: [read_file, grep_search]
  - id: writer
    name: Writer
    role: writes files
    systemPrompt: writer
    tools: [edit_file]
    owns: [src/writer/**]
`),
      ),
    ).toEqual([]);
  });

  it("allows the same path when agents run sequentially", () => {
    expect(
      conflictsFor(
        base(`
  - id: first
    name: First
    role: writes plan
    systemPrompt: first
    tools: [create_file]
    owns: [plan.json]
  - id: second
    name: Second
    role: updates plan
    systemPrompt: second
    tools: [edit_file]
    owns: [plan.json]
    dependsOn: [first]
`),
      ),
    ).toEqual([]);
  });
});
