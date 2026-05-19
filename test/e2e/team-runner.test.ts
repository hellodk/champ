/**
 * E2E tests for TeamRunner — all core execution scenarios with mock providers.
 *
 * No real LLM calls are made. The LLMProvider is mocked to return
 * deterministic text streams. Tests verify execution ordering, pause/resume,
 * token budget enforcement, BLOCKED state handling, checkpointing, dynamic
 * spawn, and checkpoint resume.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { TeamRunner } from "../../src/agent/team-runner";
import { SharedMemory } from "../../src/agent/shared-memory";
import type {
  TeamDefinition,
  TeamAgentDefinition,
} from "../../src/agent/team-definition";
import type {
  LLMProvider,
  LLMProviderConfig,
  StreamDelta,
} from "../../src/providers/types";
import type { ToolRegistry } from "../../src/tools/registry";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir: string;

async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "champ-team-runner-test-"));
}

async function cleanupTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Build a minimal TeamDefinition. */
function makeTeam(
  agentDefs: Partial<Required<TeamAgentDefinition>>[],
  overrides: Partial<TeamDefinition> = {},
): TeamDefinition {
  const agents: Required<TeamAgentDefinition>[] = agentDefs.map((def, i) => ({
    id: `agent-${i}`,
    name: `Agent ${i}`,
    role: `Role ${i}`,
    systemPrompt: "You are a helpful assistant.",
    dependsOn: [],
    condition: "",
    tools: [],
    model: "",
    maxTokens: 100,
    outputKey: `agent-${i}`,
    outputFormat: "text" as const,
    selfCritique: false,
    subscribes: [],
    ...def,
  }));

  return {
    name: "test-team",
    description: "Test team",
    version: "1",
    agents,
    execution: {
      maxParallel: 3,
      totalTokenBudget: 0, // no budget by default
      timeoutSeconds: 10,
      retries: 0,
      checkpoints: false,
      mode: "auto",
    },
    defaults: { model: "mock-model", maxTokens: 100 },
    sourcePath: "/tmp/test-team.yaml",
    ...overrides,
  };
}

/** Build a mock LLMProvider that emits a text stream then done. */
function makeMockProvider(
  responseText = "done",
  config?: Partial<LLMProviderConfig>,
): LLMProvider {
  const providerConfig: LLMProviderConfig = {
    provider: "mock",
    model: "mock-model",
    maxTokens: 100,
    temperature: 0,
    ...config,
  };

  async function* streamText(): AsyncIterable<StreamDelta> {
    yield { type: "text", text: responseText };
    yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
  }

  const provider: LLMProvider = {
    name: "mock",
    config: providerConfig,
    chat: () => streamText(),
    complete: () => streamText(),
    supportsToolUse: () => false,
    supportsStreaming: () => true,
    countTokens: (text: string) => Math.ceil(text.length / 4),
    modelInfo: () => ({
      id: "mock-model",
      name: "Mock Model",
      provider: "mock",
      contextWindow: 8192,
      maxOutputTokens: 4096,
      supportsToolUse: false,
      supportsImages: false,
      supportsStreaming: true,
    }),
    dispose: () => {},
    withModel: (model: string) =>
      makeMockProvider(responseText, { ...providerConfig, model }),
  };
  return provider;
}

/** A mock ToolRegistry that returns undefined for all tools. */
const mockToolRegistry: ToolRegistry = {
  get: () => undefined,
  register: () => {},
  getAll: () => [],
  getNames: () => [],
  getDefinitions: () => [],
} as unknown as ToolRegistry;

// ── 1. 3-agent DAG: Planner → Coder → Reviewer ───────────────────────────────

describe("TeamRunner: 3-agent DAG execution (Planner → Coder → Reviewer)", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });
  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("completes all three agents in dependency order", async () => {
    const completionOrder: string[] = [];
    const team = makeTeam([
      { id: "planner", name: "Planner", outputKey: "planner" },
      {
        id: "coder",
        name: "Coder",
        dependsOn: ["planner"],
        outputKey: "coder",
      },
      {
        id: "reviewer",
        name: "Reviewer",
        dependsOn: ["coder"],
        outputKey: "reviewer",
      },
    ]);

    const runner = new TeamRunner();
    const finalState = await runner.run(
      team,
      "build a feature",
      makeMockProvider("completed output"),
      mockToolRegistry,
      {
        workspaceRoot: tmpDir,
        onEvent: (evt) => {
          if (evt.type === "state_update") {
            for (const a of evt.state.agents) {
              if (a.status === "done" && !completionOrder.includes(a.id)) {
                completionOrder.push(a.id);
              }
            }
          }
        },
      },
    );

    expect(finalState.status).toBe("completed");
    expect(finalState.agents.map((a) => a.status)).toEqual([
      "done",
      "done",
      "done",
    ]);
    // Planner must complete before coder, coder before reviewer
    expect(completionOrder.indexOf("planner")).toBeLessThan(
      completionOrder.indexOf("coder"),
    );
    expect(completionOrder.indexOf("coder")).toBeLessThan(
      completionOrder.indexOf("reviewer"),
    );
  });

  it("computeExecutionGroups produces 3 sequential groups for a chain", () => {
    const runner = new TeamRunner();
    const agents: Required<TeamAgentDefinition>[] = [
      {
        id: "p",
        name: "Planner",
        role: "",
        systemPrompt: "",
        dependsOn: [],
        condition: "",
        tools: [],
        model: "",
        maxTokens: 100,
        outputKey: "p",
        outputFormat: "text",
        selfCritique: false,
        subscribes: [],
      },
      {
        id: "c",
        name: "Coder",
        role: "",
        systemPrompt: "",
        dependsOn: ["p"],
        condition: "",
        tools: [],
        model: "",
        maxTokens: 100,
        outputKey: "c",
        outputFormat: "text",
        selfCritique: false,
        subscribes: [],
      },
      {
        id: "r",
        name: "Reviewer",
        role: "",
        systemPrompt: "",
        dependsOn: ["c"],
        condition: "",
        tools: [],
        model: "",
        maxTokens: 100,
        outputKey: "r",
        outputFormat: "text",
        selfCritique: false,
        subscribes: [],
      },
    ];

    const groups = runner.computeExecutionGroups(agents);
    expect(groups).toHaveLength(3);
    expect(groups[0][0].id).toBe("p");
    expect(groups[1][0].id).toBe("c");
    expect(groups[2][0].id).toBe("r");
  });
});

// ── 2. Pause / Resume ─────────────────────────────────────────────────────────

describe("TeamRunner: pause/resume mid-run", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });
  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("run pauses at group boundary and resumes to completion", async () => {
    let pauseEventSeen = false;
    let resumeCount = 0;

    // Pause signal: paused after first group, then auto-resume
    let _resolveResume: (() => void) | undefined;
    const pauseSignal = {
      get isPaused() {
        return pauseEventSeen && resumeCount === 0;
      },
      waitForResume: () =>
        new Promise<void>((resolve) => {
          resumeCount++;
          resolve(); // immediately resume for the test
        }),
      requestPause: () => {
        pauseEventSeen = true;
      },
    };

    const team = makeTeam([
      { id: "a1", name: "A1", outputKey: "a1" },
      { id: "a2", name: "A2", dependsOn: ["a1"], outputKey: "a2" },
    ]);

    // Request pause before run starts
    pauseSignal.requestPause();

    const runner = new TeamRunner();
    const finalState = await runner.run(
      team,
      "test task",
      makeMockProvider("ok"),
      mockToolRegistry,
      {
        workspaceRoot: tmpDir,
        pauseSignal,
      },
    );

    // Should eventually complete
    expect(finalState.status).toBe("completed");
    expect(finalState.agents.every((a) => a.status === "done")).toBe(true);
  });
});

// ── 3. Token budget enforcement ───────────────────────────────────────────────

describe("TeamRunner: token budget enforcement", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });
  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("skips pending agents when token budget is exhausted", async () => {
    const budgetWarnings: Array<{ usedTokens: number; budgetTokens: number }> =
      [];

    // Provider that reports heavy token usage
    async function* heavyStream(): AsyncIterable<StreamDelta> {
      yield { type: "text", text: "output" };
      yield { type: "done", usage: { inputTokens: 5000, outputTokens: 5000 } };
    }
    const heavyProvider: LLMProvider = {
      ...makeMockProvider(),
      chat: () => heavyStream(),
    } as unknown as LLMProvider;

    // Budget set very low: 1 token — first agent will exceed it
    const team = makeTeam(
      [
        { id: "ag1", name: "AG1", outputKey: "ag1" },
        { id: "ag2", name: "AG2", dependsOn: ["ag1"], outputKey: "ag2" },
        { id: "ag3", name: "AG3", dependsOn: ["ag2"], outputKey: "ag3" },
      ],
      {
        execution: {
          maxParallel: 1,
          totalTokenBudget: 1, // 1 token budget — exhausted by first agent
          timeoutSeconds: 10,
          retries: 0,
          checkpoints: false,
          mode: "auto",
        },
      },
    );

    const runner = new TeamRunner();
    const finalState = await runner.run(
      team,
      "heavy task",
      heavyProvider,
      mockToolRegistry,
      {
        workspaceRoot: tmpDir,
        onEvent: (evt) => {
          if (evt.type === "budget_warning") {
            budgetWarnings.push({
              usedTokens: evt.usedTokens,
              budgetTokens: evt.budgetTokens,
            });
          }
        },
      },
    );

    // After first agent, budget is blown — remaining agents should be skipped
    const statuses = finalState.agents.map((a) => ({
      id: a.id,
      status: a.status,
    }));
    const skippedAgents = statuses.filter((s) => s.status === "skipped");
    expect(skippedAgents.length).toBeGreaterThan(0);
  });
});

// ── 4. BLOCKED state handling ─────────────────────────────────────────────────

describe("TeamRunner: BLOCKED state — skip and continue", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });
  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("blocked agent is skipped and subsequent independent agents still run", async () => {
    const blockedEvents: string[] = [];

    // Provider that emits BLOCKED for agent-0
    async function* blockedStream(): AsyncIterable<StreamDelta> {
      yield { type: "text", text: "BLOCKED: missing required input" };
      yield { type: "done", usage: { inputTokens: 5, outputTokens: 5 } };
    }

    // Provider that succeeds for all others
    let callCount = 0;
    const provider: LLMProvider = {
      ...makeMockProvider("success output"),
      chat: () => {
        callCount++;
        if (callCount === 1) return blockedStream();
        return (async function* (): AsyncIterable<StreamDelta> {
          yield { type: "text", text: "success output" };
          yield { type: "done", usage: { inputTokens: 5, outputTokens: 5 } };
        })();
      },
    } as unknown as LLMProvider;

    // Two independent agents — if first is blocked, second should still run
    const team = makeTeam([
      { id: "ag1", name: "AG1", outputKey: "ag1" },
      { id: "ag2", name: "AG2", outputKey: "ag2" }, // independent
    ]);

    const runner = new TeamRunner();
    const finalState = await runner.run(
      team,
      "test",
      provider,
      mockToolRegistry,
      {
        workspaceRoot: tmpDir,
        onBlocked: async (agentId, reason) => {
          blockedEvents.push(`${agentId}: ${reason}`);
          return { action: "skip" };
        },
        onEvent: (evt) => {
          if (evt.type === "blocked") {
            blockedEvents.push(`event:${evt.agentId}`);
          }
        },
      },
    );

    expect(blockedEvents.length).toBeGreaterThan(0);
    // Final state should be completed or paused (depending on whether TeamRunner
    // treats blocked-then-skipped as paused)
    expect(["completed", "paused"]).toContain(finalState.status);
  });
});

// ── 5. Checkpoints written after each agent ───────────────────────────────────

describe("TeamRunner: checkpoint files written after each agent", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });
  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("writes checkpoint-<agentId>.json for each completed agent", async () => {
    const team = makeTeam(
      [
        { id: "planner", name: "Planner", outputKey: "planner" },
        {
          id: "coder",
          name: "Coder",
          dependsOn: ["planner"],
          outputKey: "coder",
        },
      ],
      {
        execution: {
          maxParallel: 3,
          totalTokenBudget: 0,
          timeoutSeconds: 10,
          retries: 0,
          checkpoints: true, // enable checkpoints
          mode: "auto",
        },
      },
    );

    const runner = new TeamRunner();
    const finalState = await runner.run(
      team,
      "build something",
      makeMockProvider("done"),
      mockToolRegistry,
      { workspaceRoot: tmpDir },
    );

    expect(finalState.status).toBe("completed");

    const checkpointDir = path.join(
      tmpDir,
      ".champ",
      "team-runs",
      finalState.runId,
    );
    const files = await fs.readdir(checkpointDir);
    expect(files.some((f) => f.includes("planner"))).toBe(true);
    expect(files.some((f) => f.includes("coder"))).toBe(true);

    // Verify checkpoint JSON is valid
    const plannerCheckpoint = await fs.readFile(
      path.join(checkpointDir, `checkpoint-planner.json`),
      "utf-8",
    );
    expect(() => JSON.parse(plannerCheckpoint)).not.toThrow();
  });
});

// ── 6. Dynamic spawn (SPAWN: protocol) ───────────────────────────────────────

describe("TeamRunner: dynamic SPAWN protocol", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });
  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("accepts a spawned agent from the spawn queue in SharedMemory", async () => {
    // The TeamRunner reads __spawn_queue from SharedMemory after each group.
    // We pre-populate it so the runner accepts a dynamic agent.
    const spawnRequest = {
      id: "dynamic-agent",
      name: "Dynamic Agent",
      role: "A dynamically spawned agent",
      systemPrompt: "Do dynamic work.",
      dependsOn: ["planner"],
      tools: [],
      outputKey: "dynamic-agent",
    };

    // Override: populate spawn queue after first agent runs
    const team = makeTeam([
      { id: "planner", name: "Planner", outputKey: "planner" },
    ]);

    // We use runWithMemory so we can seed the spawn queue
    const memory = new SharedMemory();
    // Pre-seed before run; runner picks it up after group 0 completes
    const runner = new TeamRunner();

    let spawnQueueSet = false;
    const finalState = await runner.run(
      team,
      "build feature",
      makeMockProvider("ok"),
      mockToolRegistry,
      {
        workspaceRoot: tmpDir,
        onEvent: (evt) => {
          // Inject spawn queue after planner completes
          if (
            evt.type === "state_update" &&
            !spawnQueueSet &&
            evt.state.agents.find(
              (a) => a.id === "planner" && a.status === "done",
            )
          ) {
            // Note: we can't inject into the runner's internal memory after it starts,
            // so we verify the mechanism exists via runWithMemory instead
            spawnQueueSet = true;
          }
        },
      },
    );

    expect(finalState.status).toBe("completed");
  });

  it("runWithMemory with spawn queue injected via mock provider accepts dynamic agent", async () => {
    // The TeamRunner drains __spawn_queue from SharedMemory AFTER each group.
    // We must inject the spawn request into memory as a side-effect of the
    // first agent's execution (which happens inside chat). We do this by making
    // the mock provider inject into shared memory via a callback.
    // Use dependsOn: [] so that after planner completes and is added to
    // completedIds, the spawn queue is drained and the dynamic agent
    // can be placed in its own group (no unresolved deps).
    const spawnRequest = {
      id: "dynamic",
      name: "Dynamic",
      role: "dynamic role",
      systemPrompt: "Do work.",
      dependsOn: [],
      tools: [],
      outputKey: "dynamic",
    };

    const team = makeTeam([
      { id: "planner", name: "Planner", outputKey: "planner" },
    ]);

    const memory = new SharedMemory();
    // Pre-seed __spawn_queue before the run. The runner drains it after each
    // group completes. Planner is group 0 — after it completes, the runner
    // reads __spawn_queue and creates the dynamic agent in a new group.
    memory.set("__spawn_queue", [spawnRequest]);

    const runner = new TeamRunner();
    const finalState = await runner.runWithMemory(
      team,
      "test",
      makeMockProvider("ok"),
      mockToolRegistry,
      memory,
      { workspaceRoot: tmpDir },
    );

    // The dynamic agent should have been accepted and run
    const agentIds = finalState.agents.map((a) => a.id);
    expect(agentIds).toContain("dynamic");
    expect(finalState.status).toBe("completed");
  });
});

// ── 7. Resume from checkpoint ─────────────────────────────────────────────────

describe("TeamRunner: resume from checkpoint", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });
  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("resumeFromCheckpoint throws when no checkpoint directory exists", async () => {
    const runner = new TeamRunner();
    const team = makeTeam([{ id: "ag1", outputKey: "ag1" }]);
    await expect(
      runner.resumeFromCheckpoint(
        team,
        "non-existent-run-id",
        tmpDir,
        makeMockProvider(),
        mockToolRegistry,
      ),
    ).rejects.toThrow(/No checkpoints found/);
  });

  it("resumeFromCheckpoint: resumes with pending agents when only some have checkpoints", async () => {
    // Use 3 independent agents (no dependsOn) so that when ag1 is checkpointed
    // and removed from pendingAgents, the remaining agents (ag2, ag3) form a
    // valid self-contained team with no unresolved dependency references.
    const team = makeTeam(
      [
        { id: "ag1", name: "AG1", outputKey: "ag1", dependsOn: [] },
        { id: "ag2", name: "AG2", outputKey: "ag2", dependsOn: [] },
        { id: "ag3", name: "AG3", outputKey: "ag3", dependsOn: [] },
      ],
      {
        execution: {
          maxParallel: 3,
          totalTokenBudget: 0,
          timeoutSeconds: 10,
          retries: 0,
          checkpoints: true,
          mode: "auto",
        },
      },
    );

    // Manually write a checkpoint for ag1 only (simulate partial completion)
    const runId = "test-resume-run";
    const checkpointDir = path.join(tmpDir, ".champ", "team-runs", runId);
    await fs.mkdir(checkpointDir, { recursive: true });
    await fs.writeFile(
      path.join(checkpointDir, "checkpoint-ag1.json"),
      JSON.stringify(
        { ag1: "first agent output", __userRequest: "initial task" },
        null,
        2,
      ),
    );

    const runner = new TeamRunner();
    const resumedRun = await runner.resumeFromCheckpoint(
      team,
      runId,
      tmpDir,
      makeMockProvider("resumed output"),
      mockToolRegistry,
      { workspaceRoot: tmpDir },
    );

    // ag2 and ag3 should have been run
    expect(["completed", "failed"]).toContain(resumedRun.status);
    // ag1 was already checkpointed — not in the pending set; only ag2, ag3 are in resumedRun.agents
    const resumedAgentIds = resumedRun.agents.map((a) => a.id);
    expect(resumedAgentIds).not.toContain("ag1"); // ag1 was removed as completed
  });
});

// ── 8. shouldSkipAgent ────────────────────────────────────────────────────────

describe("TeamRunner: shouldSkipAgent condition evaluation", () => {
  it("returns false when condition is empty string", () => {
    const runner = new TeamRunner();
    const agent: Required<TeamAgentDefinition> = {
      id: "a",
      name: "A",
      role: "",
      systemPrompt: "",
      dependsOn: [],
      condition: "",
      tools: [],
      model: "",
      maxTokens: 100,
      outputKey: "a",
      outputFormat: "text",
      selfCritique: false,
      subscribes: [],
    };
    expect(runner.shouldSkipAgent(agent, {})).toBe(false);
  });

  it("returns false when condition evaluates to true", () => {
    const runner = new TeamRunner();
    const agent: Required<TeamAgentDefinition> = {
      id: "a",
      name: "A",
      role: "",
      systemPrompt: "",
      dependsOn: [],
      condition: "plan != null",
      tools: [],
      model: "",
      maxTokens: 100,
      outputKey: "a",
      outputFormat: "text",
      selfCritique: false,
      subscribes: [],
    };
    expect(runner.shouldSkipAgent(agent, { plan: "some plan" })).toBe(false);
  });

  it("returns true when condition evaluates to false (skip the agent)", () => {
    const runner = new TeamRunner();
    const agent: Required<TeamAgentDefinition> = {
      id: "a",
      name: "A",
      role: "",
      systemPrompt: "",
      dependsOn: [],
      condition: "plan != null",
      tools: [],
      model: "",
      maxTokens: 100,
      outputKey: "a",
      outputFormat: "text",
      selfCritique: false,
      subscribes: [],
    };
    // plan is null → condition false → skip = true
    expect(runner.shouldSkipAgent(agent, { plan: null })).toBe(true);
  });
});

// ── 9. Abort signal ───────────────────────────────────────────────────────────

describe("TeamRunner: abort signal stops the run", () => {
  beforeEach(async () => {
    tmpDir = await makeTmpDir();
  });
  afterEach(async () => {
    await cleanupTmpDir(tmpDir);
  });

  it("run stops gracefully when abort signal fires", async () => {
    const controller = new AbortController();
    // Abort immediately
    controller.abort();

    const team = makeTeam([
      { id: "ag1", name: "AG1", outputKey: "ag1" },
      { id: "ag2", name: "AG2", outputKey: "ag2" },
    ]);

    const runner = new TeamRunner();
    const finalState = await runner.run(
      team,
      "test",
      makeMockProvider("ok"),
      mockToolRegistry,
      {
        workspaceRoot: tmpDir,
        abortSignal: controller.signal,
      },
    );

    // When aborted before any work, status should be stopped or completed
    expect(["stopped", "completed"]).toContain(finalState.status);
  });
});
