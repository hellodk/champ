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

describe("TeamRunner — getPendingAgents", () => {
  it("returns agents not in the completed set", () => {
    const runner = new TeamRunner();
    const agents = [
      makeAgent("pm"),
      makeAgent("infra", ["pm"]),
      makeAgent("security", ["infra"]),
    ];
    const pending = runner.getPendingAgents(agents, new Set(["pm", "infra"]));
    expect(pending.map((a) => a.id)).toEqual(["security"]);
  });

  it("returns all agents when none completed", () => {
    const runner = new TeamRunner();
    const agents = [makeAgent("pm"), makeAgent("infra", ["pm"])];
    const pending = runner.getPendingAgents(agents, new Set());
    expect(pending.map((a) => a.id)).toEqual(["pm", "infra"]);
  });

  it("returns empty array when all agents completed", () => {
    const runner = new TeamRunner();
    const agents = [makeAgent("pm"), makeAgent("infra", ["pm"])];
    const pending = runner.getPendingAgents(agents, new Set(["pm", "infra"]));
    expect(pending).toHaveLength(0);
  });
});

describe("TeamRunner — token counting", () => {
  it("accumulates token counts from agent memory in final state", async () => {
    const runner = new TeamRunner();
    const team = makeTeam([makeAgent("a"), makeAgent("b", ["a"])]);

    // Fake provider that supports streaming
    const fakeProvider = {
      name: "test",
      config: { provider: "test" as const, model: "test" },
      chat: async function* () {
        yield { type: "text" as const, text: "<output>done</output>" };
        yield {
          type: "done" as const,
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
      complete: async function* () {
        yield {
          type: "done" as const,
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
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

    const toolRegistry = {
      get: () => undefined,
      list: () => [],
      execute: async () => ({ success: true, output: "" }),
      register: () => {},
    } as any;

    const states: import("@/agent/team-definition").TeamRunState[] = [];
    await runner.run(team, "test task", fakeProvider as any, toolRegistry, {
      onEvent: (e) => {
        if (e.type === "state_update" || e.type === "complete")
          states.push(e.state);
      },
    });

    const finalState = states[states.length - 1];
    // Each agent receives { inputTokens: 100, outputTokens: 50 } = 150 per agent.
    // Two agents (a, b) should accumulate to 300 total.
    expect(finalState.totalTokens).toBe(300);
    const agentA = finalState.agents.find((a) => a.id === "a")!;
    const agentB = finalState.agents.find((a) => a.id === "b")!;
    expect(agentA.tokenCount).toBe(150);
    expect(agentB.tokenCount).toBe(150);
    expect(finalState.status).toBe("completed");
  });
});

describe("TeamRunner — token budget", () => {
  it("emits budget_warning when totalTokens exceeds 80% of budget", async () => {
    const runner = new TeamRunner();
    const team = makeTeam([makeAgent("a"), makeAgent("b", ["a"])]);
    team.execution.totalTokenBudget = 100;

    const fakeProvider = {
      name: "test",
      config: { provider: "test" as const, model: "test" },
      chat: async function* () {
        yield { type: "text" as const, text: "<output>done</output>" };
        yield {
          type: "done" as const,
          usage: { inputTokens: 45, outputTokens: 45 },
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
    };

    const toolRegistry = {
      get: () => undefined,
      list: () => [],
      execute: async () => ({ success: true, output: "" }),
      register: () => {},
    } as any;

    const events: import("@/agent/team-runner").TeamRunEvent[] = [];
    await runner.run(team, "test", fakeProvider as any, toolRegistry, {
      onEvent: (e) => events.push(e),
    });

    const warned = events.some((e) => e.type === "budget_warning");
    expect(warned).toBe(true);
  });

  it("skips remaining pending agents when totalTokens reaches 100% of budget", async () => {
    const runner = new TeamRunner();
    // 3-agent chain: a → b → c. Budget is 80 tokens. Agent "a" uses 90 tokens.
    // After "a" completes, totalTokens=90 > budget=80, so b and c should be skipped.
    const team = makeTeam([
      makeAgent("a"),
      makeAgent("b", ["a"]),
      makeAgent("c", ["b"]),
    ]);
    team.execution.totalTokenBudget = 80;

    const fakeProvider = {
      name: "test",
      config: { provider: "test" as const, model: "test" },
      chat: async function* () {
        yield { type: "text" as const, text: "<output>done</output>" };
        yield {
          type: "done" as const,
          usage: { inputTokens: 45, outputTokens: 45 },
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
    };

    const toolRegistry = {
      get: () => undefined,
      list: () => [],
      execute: async () => ({ success: true, output: "" }),
      register: () => {},
    } as any;

    let finalState: import("@/agent/team-definition").TeamRunState | undefined;
    await runner.run(team, "test", fakeProvider as any, toolRegistry, {
      onEvent: (e) => {
        if (e.type === "complete") finalState = e.state;
      },
    });

    expect(finalState).toBeDefined();
    const bState = finalState!.agents.find((a) => a.id === "b");
    const cState = finalState!.agents.find((a) => a.id === "c");
    expect(bState?.status).toBe("skipped");
    expect(cState?.status).toBe("skipped");
  });
});

describe("TeamRunner — skip/retry on blocked", () => {
  it("calls onBlocked when agent is BLOCKED and skips when action is skip", async () => {
    const runner = new TeamRunner();
    const team = makeTeam([makeAgent("a"), makeAgent("b", ["a"])]);

    let blockedCallCount = 0;
    const fakeProvider = {
      name: "test",
      config: { provider: "test" as const, model: "test" },
      chat: async function* (msgs: import("@/providers/types").LLMMessage[]) {
        // agent "a" blocks; agent "b" succeeds
        const isAgentA = (msgs[0].content as string).includes("role of a");
        if (isAgentA) {
          yield { type: "text" as const, text: "BLOCKED: missing schema" };
          yield {
            type: "done" as const,
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        } else {
          yield { type: "text" as const, text: "<output>done</output>" };
          yield {
            type: "done" as const,
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        }
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
    };

    const toolRegistry = {
      get: () => undefined,
      list: () => [],
      execute: async () => ({ success: true, output: "" }),
      register: () => {},
    } as any;

    let finalState: import("@/agent/team-definition").TeamRunState | undefined;
    await runner.run(team, "test", fakeProvider as any, toolRegistry, {
      onBlocked: async (agentId, _reason) => {
        blockedCallCount++;
        return { action: "skip" as const };
      },
      onEvent: (e) => {
        if (e.type === "complete") finalState = e.state;
      },
    });

    expect(blockedCallCount).toBe(1);
    expect(finalState!.agents.find((a) => a.id === "a")?.status).toBe(
      "skipped",
    );
  });
});
