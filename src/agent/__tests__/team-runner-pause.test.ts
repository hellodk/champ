// src/agent/__tests__/team-runner-pause.test.ts
import { describe, it, expect, vi } from "vitest";
import { TeamRunner } from "../team-runner";
import type { TeamDefinition, TeamAgentDefinition } from "../team-definition";

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
    name: "Pause Test Team",
    description: "tests pause",
    version: "1",
    sourcePath: "/test/pause-team.yaml",
    defaults: { model: "", maxTokens: 1000 },
    execution: {
      maxParallel: 3,
      totalTokenBudget: 0,
      timeoutSeconds: 10,
      retries: 0,
      checkpoints: false,
      mode: "auto",
      maxDynamicAgents: 5,
    },
    agents,
  };
}

function makeFakeProvider(output = "<output>done</output>") {
  return {
    name: "test",
    config: { provider: "test" as const, model: "test" },
    chat: async function* () {
      yield { type: "text" as const, text: output };
      yield {
        type: "done" as const,
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    complete: async function* () {},
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    countTokens: () => 0,
    modelInfo: () => ({ contextWindow: 4096, name: "test", provider: "test" }),
  };
}

describe("TeamRunner pause/resume", () => {
  it("emits state_update and complete even when pauseSignal never pauses", async () => {
    const team = makeTeam([
      makeAgent("agentA"),
      makeAgent("agentB", ["agentA"]),
    ]);
    const provider = makeFakeProvider();
    const runner = new TeamRunner();
    const events: string[] = [];
    const pauseSignal = {
      get isPaused() {
        return false;
      },
      waitForResume: () => Promise.resolve(),
      requestPause: () => {
        /* no-op */
      },
    };

    await runner.run(
      team,
      "do work",
      provider as never,
      { get: () => undefined, register: vi.fn() } as never,
      {
        pauseSignal,
        onEvent: (e) => {
          events.push(e.type);
        },
      },
    );

    expect(events).toContain("state_update");
    expect(events).toContain("complete");
  });

  it("resumes after pause and completes all agents", async () => {
    const team = makeTeam([makeAgent("a1"), makeAgent("a2", ["a1"])]);
    const provider = makeFakeProvider();
    const runner = new TeamRunner();
    let pauseCallCount = 0;
    const pauseSignal = {
      get isPaused() {
        return pauseCallCount === 1;
      },
      waitForResume: () => Promise.resolve(),
      requestPause: () => {
        pauseCallCount++;
      },
    };

    const finalState = await runner.run(
      team,
      "task",
      provider as never,
      { get: () => undefined, register: vi.fn() } as never,
      { pauseSignal, onEvent: () => {} },
    );

    expect(finalState.status).toBe("completed");
    expect(
      finalState.agents.every(
        (a) => a.status === "done" || a.status === "skipped",
      ),
    ).toBe(true);
  });
});
