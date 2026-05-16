import { describe, it, expect } from "vitest";
import { TeamRunner } from "../../agent/team-runner";
import { SharedMemory } from "../shared-memory";
import type { TeamDefinition, TeamAgentDefinition } from "../team-definition";
import type { SpawnRequest } from "../team-agent";

function makeAgent(
  id: string,
  deps: string[] = [],
): Required<TeamAgentDefinition> {
  return {
    id,
    name: id,
    role: `role of ${id}`,
    systemPrompt: `You are ${id}`,
    dependsOn: deps,
    condition: "",
    tools: [],
    model: "",
    maxTokens: 1000,
    outputKey: id,
    outputFormat: "text" as const,
    selfCritique: false,
    subscribes: [],
  };
}

function makeTeam(agents: Required<TeamAgentDefinition>[]): TeamDefinition {
  return {
    name: "Dynamic Test Team",
    description: "Tests dynamic agent spawning",
    version: "1",
    sourcePath: "/test/dynamic-team.yaml",
    defaults: { model: "", maxTokens: 1000 },
    execution: {
      maxParallel: 3,
      totalTokenBudget: 100_000,
      timeoutSeconds: 10,
      retries: 0,
      checkpoints: false,
      mode: "auto",
      maxDynamicAgents: 5,
    },
    agents,
  };
}

// A provider that optionally injects SPAWN lines from its output
function makeFakeProvider(
  outputByAgentRole: Record<string, string>,
  defaultOutput = "<output>done</output>",
) {
  return {
    name: "test",
    config: { provider: "test" as const, model: "test" },
    chat: async function* (msgs: { role: string; content: string }[]) {
      const systemContent = msgs[0]?.content ?? "";
      let text = defaultOutput;
      for (const [roleFragment, output] of Object.entries(outputByAgentRole)) {
        if (systemContent.includes(roleFragment)) {
          text = output;
          break;
        }
      }
      yield { type: "text" as const, text };
      yield {
        type: "done" as const,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    complete: async function* () {},
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    countTokens: () => 0,
    modelInfo: () => ({
      contextWindow: 4096,
      name: "test",
      provider: "test" as const,
    }),
    dispose: () => {},
    withModel: undefined,
  };
}

const stubToolRegistry = {
  get: () => undefined,
  list: () => [],
  execute: async () => ({ success: true, output: "" }),
  register: () => {},
} as any;

describe("hasCycle (via TeamRunner.computeExecutionGroups)", () => {
  it("detects a simple A→B→A cycle", () => {
    const runner = new TeamRunner();
    // computeExecutionGroups uses Kahn's — a cycle produces fewer groups than agents
    const agents = [makeAgent("a", ["b"]), makeAgent("b", ["a"])];
    const groups = runner.computeExecutionGroups(agents);
    // In a cycle, no node has in-degree 0, so groups is empty
    expect(groups).toHaveLength(0);
  });

  it("accepts a valid DAG without cycles", () => {
    const runner = new TeamRunner();
    const agents = [makeAgent("a"), makeAgent("b", ["a"]), makeAgent("c", ["b"])];
    const groups = runner.computeExecutionGroups(agents);
    expect(groups).toHaveLength(3);
  });
});

describe("TeamRunner — dynamic agent spawn via SPAWN protocol", () => {
  it("runs a spawned agent after the spawning group completes", async () => {
    const runner = new TeamRunner();
    const team = makeTeam([makeAgent("orchestrator")]);

    const spawnPayload: SpawnRequest = {
      id: "spawned1",
      name: "Spawned Worker",
      role: "spawned worker",
      systemPrompt: "You are a spawned worker",
      dependsOn: [],
      tools: [],
      outputKey: "spawned1",
    };

    const spawnLine = `SPAWN: ${JSON.stringify(spawnPayload)}`;

    const provider = makeFakeProvider({
      "role of orchestrator": `${spawnLine}\n<output>orchestrator done</output>`,
      "spawned worker": "<output>spawned done</output>",
    });

    let finalState: import("../team-definition").TeamRunState | undefined;
    await runner.run(team, "test", provider as any, stubToolRegistry, {
      onEvent: (e) => {
        if (e.type === "complete") finalState = e.state;
      },
    });

    expect(finalState).toBeDefined();
    expect(finalState!.status).toBe("completed");
    // Spawned agent should appear in final state
    const spawnedAgentState = finalState!.agents.find(
      (a) => a.id === "spawned1",
    );
    expect(spawnedAgentState).toBeDefined();
    expect(spawnedAgentState!.status).toBe("done");
  });

  it("drops spawn requests beyond maxDynamicAgents cap", async () => {
    const runner = new TeamRunner();
    // Team with cap of 1
    const team = makeTeam([makeAgent("orchestrator")]);
    team.execution.maxDynamicAgents = 1;

    const spawnLine1 = `SPAWN: ${JSON.stringify({ id: "w1", name: "Worker 1", role: "worker one", systemPrompt: "You are worker 1", dependsOn: [], tools: [], outputKey: "w1" })}`;
    const spawnLine2 = `SPAWN: ${JSON.stringify({ id: "w2", name: "Worker 2", role: "worker two", systemPrompt: "You are worker 2", dependsOn: [], tools: [], outputKey: "w2" })}`;

    const provider = makeFakeProvider({
      "role of orchestrator": `${spawnLine1}\n${spawnLine2}\n<output>done</output>`,
      "worker one": "<output>w1 done</output>",
      "worker two": "<output>w2 done</output>",
    });

    let finalState: import("../team-definition").TeamRunState | undefined;
    await runner.run(team, "test", provider as any, stubToolRegistry, {
      onEvent: (e) => {
        if (e.type === "complete") finalState = e.state;
      },
    });

    // w1 accepted, w2 dropped due to cap
    const agentIds = finalState!.agents.map((a) => a.id);
    expect(agentIds).toContain("w1");
    expect(agentIds).not.toContain("w2");
  });

  it("drops spawn with duplicate ID", async () => {
    const runner = new TeamRunner();
    // orchestrator is already in the team — trying to spawn "orchestrator" again should fail
    const team = makeTeam([makeAgent("orchestrator")]);

    const spawnLine = `SPAWN: ${JSON.stringify({ id: "orchestrator", name: "Duplicate", role: "dup", systemPrompt: "dup", dependsOn: [], tools: [], outputKey: "orchestrator" })}`;

    const provider = makeFakeProvider({
      "role of orchestrator": `${spawnLine}\n<output>done</output>`,
    });

    let finalState: import("../team-definition").TeamRunState | undefined;
    await runner.run(team, "test", provider as any, stubToolRegistry, {
      onEvent: (e) => {
        if (e.type === "complete") finalState = e.state;
      },
    });

    // Only 1 agent in final state (duplicate was dropped)
    expect(finalState!.agents).toHaveLength(1);
    expect(finalState!.status).toBe("completed");
  });
});

describe("SharedMemory — channel integration with TeamAgent subscribes", () => {
  it("publish/subscribe round-trip works via SharedMemory directly", async () => {
    const mem = new SharedMemory();
    mem.publish("research-results", { findings: ["a", "b"] });
    const data = await mem.subscribe("research-results", 1000);
    expect(data).toEqual({ findings: ["a", "b"] });
  });
});
