import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { runTeamCommand, type TeamCommandDeps } from "@/cli/team-commands";
import type {
  ChatOptions,
  LLMProvider,
  LLMProviderConfig,
  StreamDelta,
} from "@/providers/types";
import type { ToolRegistry } from "@/tools/registry";
import type { TeamRunOptions, TeamRunState } from "@/agent/team-runner";
import { TeamRunStore } from "@/ui/team-run-store";

const toolRegistry = {
  get: () => undefined,
  register: () => {},
  getAll: () => [],
  getNames: () => [],
  getDefinitions: () => [],
} as unknown as ToolRegistry;

interface ProviderOptions {
  onCall?: (prompt: string) => void;
  failFor?: (prompt: string) => boolean;
  delayMs?: number;
  /** Simulate a request that hangs until the caller aborts it. */
  throwOnAbort?: boolean;
}

/** Deterministic provider that identifies agents by a token in their system prompt. */
function makeProvider(opts: ProviderOptions = {}): {
  provider: LLMProvider;
  active: { current: number; max: number };
} {
  const active = { current: 0, max: 0 };
  const config: LLMProviderConfig = {
    provider: "mock",
    model: "mock-model",
    maxTokens: 100,
    temperature: 0,
  };

  async function* chat(
    messages: { content: unknown }[],
    options?: ChatOptions,
  ): AsyncIterable<StreamDelta> {
    const prompt = JSON.stringify(messages);
    opts.onCall?.(prompt);
    active.current++;
    active.max = Math.max(active.max, active.current);
    try {
      if (opts.throwOnAbort && options?.abortSignal) {
        const signal = options.abortSignal;
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
        throw new Error("aborted");
      }
      if (opts.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      }
      if (opts.failFor?.(prompt)) {
        yield { type: "error", error: "boom" };
      } else {
        yield { type: "text", text: "done" };
      }
      yield { type: "done", usage: { inputTokens: 10, outputTokens: 5 } };
    } finally {
      active.current--;
    }
  }

  const provider: LLMProvider = {
    name: "mock",
    config,
    chat: chat as LLMProvider["chat"],
    complete: chat as LLMProvider["complete"],
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
    withModel: () => provider,
  };
  return { provider, active };
}

let workspace: string;
let out: string[];
let err: string[];

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "champ-team-cli-test-"));
  await fs.mkdir(path.join(workspace, ".champ", "teams"), { recursive: true });
  out = [];
  err = [];
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
});

async function writeTeam(name: string, yaml: string): Promise<void> {
  await fs.writeFile(
    path.join(workspace, ".champ", "teams", `${name}.yaml`),
    yaml.trim() + "\n",
    "utf8",
  );
}

function deps(overrides: Partial<TeamCommandDeps> = {}): TeamCommandDeps {
  return {
    workspace,
    toolRegistry,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    yes: false,
    newRunId: () => "team-test-run",
    ...overrides,
  };
}

function state(overrides: Partial<TeamRunState> = {}): TeamRunState {
  return {
    runId: "team-test-run",
    teamName: "basic",
    userRequest: "task",
    status: "completed",
    agents: [],
    sharedMemorySnapshot: {},
    startTime: Date.UTC(2026, 0, 2, 8, 0, 0),
    endTime: Date.UTC(2026, 0, 2, 8, 0, 5),
    totalTokens: 0,
    filesChanged: [],
    mode: "auto",
    ...overrides,
  };
}

describe("champ team list / history", () => {
  it("lists teams without needing a provider", async () => {
    await writeTeam(
      "basic",
      `
name: basic
description: A basic team
agents:
  - id: a
    name: A
    role: does work
    systemPrompt: You are A.
`,
    );
    const code = await runTeamCommand({ name: "list" }, deps());
    expect(code).toBe(0);
    expect(out.join("")).toContain("basic");
    expect(out.join("")).toContain("A basic team");
  });

  it("reports an empty workspace without failing", async () => {
    expect(await runTeamCommand({ name: "list" }, deps())).toBe(0);
    expect(out.join("")).toContain("No teams found");
  });

  it("shows recorded runs with IST timestamps", async () => {
    const store = new TeamRunStore(workspace);
    await store.save(state());
    const code = await runTeamCommand({ name: "history" }, deps({ store }));
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("team-test-run");
    expect(text).toContain("completed");
    expect(text).toContain("IST");
  });
});

describe("champ team run", () => {
  const basicTeam = `
name: basic
description: A basic team
agents:
  - id: a
    name: A
    role: does work
    systemPrompt: You are A.
`;

  it("rejects an unknown team before running", async () => {
    const code = await runTeamCommand(
      { name: "run", team: "missing", task: "do it" },
      deps({ provider: makeProvider().provider }),
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain('team "missing" not found');
  });

  it("refuses overlapping file ownership before any agent runs", async () => {
    await writeTeam(
      "unsafe",
      `
name: unsafe
description: Conflicting writers
execution:
  checkpoints: false
agents:
  - id: a
    name: A
    role: writes
    systemPrompt: A
    tools: [edit_file]
    owns: [src/**]
  - id: b
    name: B
    role: writes
    systemPrompt: B
    tools: [edit_file]
    owns: [src/file.ts]
`,
    );
    const { provider } = makeProvider();
    const code = await runTeamCommand(
      { name: "run", team: "unsafe", task: "do it" },
      deps({ provider }),
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain("own overlapping paths");
    expect(err.join("")).toContain("refusing to run");
  });

  it("runs a team, records history and maps status to the exit code", async () => {
    await writeTeam("basic", basicTeam);
    const { provider } = makeProvider();
    const code = await runTeamCommand(
      { name: "run", team: "basic", task: "do it" },
      deps({ provider }),
    );
    expect(code).toBe(0);
    expect(out.join("")).toContain("Team run team-test-run: completed");
    const records = await new TeamRunStore(workspace).loadAll();
    expect(records).toHaveLength(1);
    expect(records[0].state.runId).toBe("team-test-run");
  });

  it("executes dependent agents in dependency order", async () => {
    await writeTeam(
      "chain",
      `
name: chain
description: Ordered agents
execution:
  checkpoints: false
agents:
  - id: reviewer
    name: Reviewer
    role: reviews
    systemPrompt: TOKEN_REVIEWER
    dependsOn: [coder]
  - id: coder
    name: Coder
    role: codes
    systemPrompt: TOKEN_CODER
    dependsOn: [planner]
  - id: planner
    name: Planner
    role: plans
    systemPrompt: TOKEN_PLANNER
`,
    );
    const calls: string[] = [];
    const { provider } = makeProvider({
      onCall: (prompt) => {
        for (const token of [
          "TOKEN_PLANNER",
          "TOKEN_CODER",
          "TOKEN_REVIEWER",
        ]) {
          if (prompt.includes(token)) calls.push(token);
        }
      },
    });
    const code = await runTeamCommand(
      { name: "run", team: "chain", task: "build it" },
      deps({ provider }),
    );
    expect(code).toBe(0);
    expect(calls).toEqual(["TOKEN_PLANNER", "TOKEN_CODER", "TOKEN_REVIEWER"]);
  });

  it("honours maxParallel when agents are independent", async () => {
    await writeTeam(
      "parallel",
      `
name: parallel
description: Independent agents
execution:
  maxParallel: 1
  checkpoints: false
agents:
  - id: a
    name: A
    role: first
    systemPrompt: TOKEN_A
  - id: b
    name: B
    role: second
    systemPrompt: TOKEN_B
`,
    );
    const { provider, active } = makeProvider({ delayMs: 15 });
    const code = await runTeamCommand(
      { name: "run", team: "parallel", task: "build it" },
      deps({ provider }),
    );
    expect(code).toBe(0);
    expect(active.max).toBe(1);
  });

  it("returns a failure exit code when an agent fails", async () => {
    await writeTeam("basic", basicTeam);
    const { provider } = makeProvider({ failFor: () => true });
    const code = await runTeamCommand(
      { name: "run", team: "basic", task: "do it" },
      deps({ provider }),
    );
    expect(code).toBe(1);
    expect(out.join("")).toContain("failed");
  });

  it("reports a timed-out agent as a failed run", async () => {
    await writeTeam("basic", basicTeam);
    const timedOut = state({
      status: "failed",
      agents: [
        {
          id: "a",
          name: "A",
          status: "failed",
          output: 'Agent "a" timed out after 1s',
          tokenCount: 0,
          validationWarnings: [],
          retryCount: 0,
        },
      ],
    });
    const runner = {
      computeExecutionGroups: () => [],
      run: vi.fn().mockResolvedValue(timedOut),
      resumeFromCheckpoint: vi.fn(),
    };
    const code = await runTeamCommand(
      { name: "run", team: "basic", task: "do it" },
      deps({ provider: makeProvider().provider, runner: runner as never }),
    );
    expect(code).toBe(1);
    expect(out.join("")).toContain("timed out after 1s");
  });

  it("cancels a hanging provider at the configured timeout", async () => {
    await writeTeam(
      "slow",
      `
name: slow
description: Hanging provider
execution:
  timeoutSeconds: 1
  retries: 0
  checkpoints: false
agents:
  - id: slow
    name: Slow
    role: hangs
    systemPrompt: TOKEN_SLOW
`,
    );
    const { provider } = makeProvider({ throwOnAbort: true });
    const code = await runTeamCommand(
      { name: "run", team: "slow", task: "do it" },
      deps({ provider }),
    );
    expect(code).toBe(1);
    expect(out.join("")).toContain("timed out after 1s");
  }, 5_000);
});

describe("champ team approvals and resume", () => {
  const supervisedTeam = `
name: supervised
description: Needs approval
execution:
  mode: supervised
  checkpoints: false
agents:
  - id: a
    name: A
    role: writes
    systemPrompt: A
    tools: [create_file]
    owns: [docs/**]
`;

  it("denies team approval gates without --yes and allows them with it", async () => {
    await writeTeam("supervised", supervisedTeam);
    let captured: TeamRunOptions | undefined;
    const runner = {
      computeExecutionGroups: () => [],
      run: vi.fn(
        (
          _team: unknown,
          _task: string,
          _provider: unknown,
          _tools: unknown,
          options: TeamRunOptions,
        ) => {
          captured = options;
          return Promise.resolve(state({ status: "completed" }));
        },
      ),
      resumeFromCheckpoint: vi.fn(),
    };
    await runTeamCommand(
      { name: "run", team: "supervised", task: "do it" },
      deps({ provider: makeProvider().provider, runner: runner as never }),
    );
    expect(await captured!.onApprovalRequired!("A")).toBe(false);
    expect(err.join("")).toContain("pass --yes to allow");

    err.length = 0;
    await runTeamCommand(
      { name: "run", team: "supervised", task: "do it" },
      deps({
        provider: makeProvider().provider,
        runner: runner as never,
        yes: true,
      }),
    );
    expect(await captured!.onApprovalRequired!("A")).toBe(true);
    expect(await captured!.requestApproval!("create a file")).toBe(true);
    expect(err.join("")).toBe("");
  });

  it("resumes a recorded run from its checkpoints", async () => {
    await writeTeam(
      "basic",
      `
name: basic
description: Basic
agents:
  - id: a
    name: A
    role: works
    systemPrompt: A
`,
    );
    const runner = {
      computeExecutionGroups: () => [],
      run: vi.fn(),
      resumeFromCheckpoint: vi.fn().mockResolvedValue(state()),
    };
    const store = new TeamRunStore(workspace);
    await store.save(state({ teamName: "basic", status: "failed" }));
    const code = await runTeamCommand(
      { name: "resume", runId: "team-test-run" },
      deps({
        provider: makeProvider().provider,
        runner: runner as never,
        store,
      }),
    );
    expect(code).toBe(0);
    expect(runner.resumeFromCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({ name: "basic" }),
      "team-test-run",
      workspace,
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        runId: "team-test-run",
        workspaceRoot: workspace,
      }),
    );
  });

  it("rejects resume for an unknown run id", async () => {
    const code = await runTeamCommand(
      { name: "resume", runId: "team-missing" },
      deps({ provider: makeProvider().provider }),
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain("no team run");
  });

  it("continues only pending agents after a checkpointed failure", async () => {
    const calls: string[] = [];
    const { provider } = makeProvider({
      onCall: (prompt) => {
        if (prompt.includes("TOKEN_FIRST")) calls.push("first");
        if (prompt.includes("TOKEN_SECOND")) calls.push("second");
      },
      failFor: (prompt) =>
        prompt.includes("TOKEN_SECOND") && calls.length === 2,
    });
    await writeTeam(
      "cp",
      `
name: cp
description: Checkpointed
execution:
  checkpoints: true
  retries: 0
agents:
  - id: first
    name: First
    role: first
    systemPrompt: TOKEN_FIRST
  - id: second
    name: Second
    role: second
    systemPrompt: TOKEN_SECOND
    dependsOn: [first]
`,
    );
    const baseDeps = deps({ provider });
    const firstCode = await runTeamCommand(
      { name: "run", team: "cp", task: "do it" },
      baseDeps,
    );
    expect(firstCode).toBe(1);
    const checkpointDir = path.join(
      workspace,
      ".champ",
      "team-runs",
      "team-test-run",
    );
    await expect(fs.readdir(checkpointDir)).resolves.toContain(
      "checkpoint-first.json",
    );

    calls.length = 0;
    const resumeCode = await runTeamCommand(
      { name: "resume", runId: "team-test-run" },
      { ...baseDeps, newRunId: () => "team-test-run" },
    );
    expect(resumeCode, err.join("")).toBe(0);
    expect(calls).toEqual(["second"]);
  });
});
