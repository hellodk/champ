/**
 * CLI surface for agent teams.
 *
 * All execution is delegated to the existing TeamRunner; this module only
 * parses command intent, refuses unsafe parallel file ownership, renders
 * progress and maps the final TeamRunState to an exit code. Nothing here
 * reimplements the agent runtime.
 */
import * as path from "path";
import type { LLMProvider } from "../providers/types";
import type { ToolRegistry } from "../tools/registry";
import { TeamLoader } from "../agent/team-loader";
import { TeamRunner, type TeamRunEvent } from "../agent/team-runner";
import { TeamRunStore } from "../ui/team-run-store";
import type { TeamRunState } from "../agent/team-definition";
import { findOwnershipConflicts } from "./team-ownership";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

export type TeamCommand =
  | { name: "list" }
  | { name: "run"; team: string; task: string }
  | { name: "history" }
  | { name: "resume"; runId: string };

export interface TeamCommandDeps {
  workspace: string;
  /** Required for run/resume; list and history are provider-independent. */
  provider?: LLMProvider;
  toolRegistry?: ToolRegistry;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** `--yes`: answer team approval gates affirmatively. */
  yes: boolean;
  /** Operator-set permission profile applied to every team agent's tools. */
  permissionProfile?: import("../policy/profiles").PermissionProfile;
  /** Injectable for tests; defaults to real filesystem-backed components. */
  loader?: TeamLoader;
  runner?: TeamRunner;
  store?: TeamRunStore;
  /** Injectable clock/id for deterministic tests. */
  now?: () => number;
  newRunId?: () => string;
  abortSignal?: AbortSignal;
}

/** Absolute event timestamps are shown in IST, matching the rest of the CLI. */
function ist(ms: number): string {
  return (
    new Date(ms).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }) + " IST"
  );
}

function printSummary(state: TeamRunState, out: (text: string) => void): void {
  out(`\nTeam run ${state.runId}: ${state.status}\n`);
  for (const agent of state.agents) {
    out(
      `  ${agent.status.padEnd(8)} ${agent.name} (${agent.id}) ${agent.tokenCount} tokens\n`,
    );
    if (
      (agent.status === "failed" || agent.status === "blocked") &&
      agent.output.trim()
    ) {
      out(`    ${agent.output.trim().slice(0, 300)}\n`);
    }
  }
  out(
    `Started ${ist(state.startTime)} · Ended ${ist(state.endTime ?? Date.now())}\n`,
  );
  out(
    `Total ${state.totalTokens} tokens · ${state.filesChanged.length} files changed\n`,
  );
}

export async function runTeamCommand(
  command: TeamCommand,
  deps: TeamCommandDeps,
): Promise<number> {
  const loader = deps.loader ?? new TeamLoader(deps.workspace);
  const runner = deps.runner ?? new TeamRunner();
  const store = deps.store ?? new TeamRunStore(deps.workspace);

  if (command.name === "list") {
    const teams = await loader.loadAll();
    if (teams.length === 0) {
      deps.stdout(
        `No teams found in ${path.join(deps.workspace, ".champ", "teams")}\n`,
      );
      return EXIT_OK;
    }
    for (const team of teams) {
      deps.stdout(
        `${team.name.padEnd(28)} ${String(team.agents.length).padStart(2)} agents  ${team.description}\n`,
      );
    }
    return EXIT_OK;
  }

  if (command.name === "history") {
    const records = await store.loadAll();
    if (records.length === 0) {
      deps.stdout("No team runs recorded in this workspace\n");
      return EXIT_OK;
    }
    for (const record of records) {
      const state = record.state;
      deps.stdout(
        `${state.runId}  ${state.status.padEnd(9)}  ${state.teamName}  ${ist(state.startTime)}  ${state.agents.length} agents  ${state.totalTokens} tokens\n`,
      );
    }
    return EXIT_OK;
  }

  let teamName: string;
  if (command.name === "resume") {
    const record = await store.load(command.runId);
    if (!record) {
      deps.stderr(`champ: no team run "${command.runId}" found\n`);
      return EXIT_USAGE;
    }
    teamName = record.state.teamName;
  } else {
    teamName = command.team;
  }

  const teams = await loader.loadAll();
  const team = teams.find((candidate) => candidate.name === teamName);
  if (!team) {
    deps.stderr(
      `champ: team "${teamName}" not found in ${path.join(deps.workspace, ".champ", "teams")}\n`,
    );
    return EXIT_USAGE;
  }

  // Refuse parallel mutation before any agent runs. The check is deliberately
  // conservative: an undefined ownership pattern is a conflict, not a pass.
  if (!deps.provider || !deps.toolRegistry) {
    deps.stderr("champ: team execution requires a configured provider\n");
    return EXIT_USAGE;
  }
  const provider = deps.provider;
  const toolRegistry = deps.toolRegistry;

  const conflicts = findOwnershipConflicts(
    team,
    runner.computeExecutionGroups(team.agents),
  );
  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      deps.stderr(`champ: ${conflict}\n`);
    }
    deps.stderr(
      "champ: refusing to run — declare disjoint `owns` patterns for agents that mutate files\n",
    );
    return EXIT_USAGE;
  }

  const ownController = deps.abortSignal ? undefined : new AbortController();
  const onSigint = () => ownController?.abort();
  if (ownController) process.once("SIGINT", onSigint);
  const signal = deps.abortSignal ?? ownController!.signal;

  const seenStatuses = new Map<string, string>();
  const onEvent = (event: TeamRunEvent): void => {
    switch (event.type) {
      case "state_update":
        for (const agent of event.state.agents) {
          if (seenStatuses.get(agent.id) === agent.status) continue;
          seenStatuses.set(agent.id, agent.status);
          if (
            agent.status === "running" ||
            agent.status === "done" ||
            agent.status === "failed" ||
            agent.status === "blocked"
          ) {
            deps.stdout(
              `[${agent.id}] ${agent.status}${agent.blockedReason ? `: ${agent.blockedReason}` : ""}\n`,
            );
          }
        }
        break;
      case "agent_stream":
        deps.stdout(`[${event.agentId}] ${event.chunk}`);
        break;
      case "blocked":
        deps.stderr(`champ: ${event.agentId} blocked: ${event.reason}\n`);
        break;
      case "budget_warning":
        deps.stderr(
          `champ: token budget ${event.usedTokens}/${event.budgetTokens}\n`,
        );
        break;
      case "error":
        deps.stderr(`champ: ${event.message}\n`);
        break;
      case "complete":
        break;
    }
  };

  const approve = async (description: string): Promise<boolean> => {
    if (deps.permissionProfile === "read-only") return false;
    if (
      deps.permissionProfile === "autonomous" ||
      (deps.permissionProfile === undefined && deps.yes)
    ) {
      return true;
    }
    deps.stderr(
      `champ: approval required (${description}) — pass --permission-profile autonomous or --yes to allow\n`,
    );
    return false;
  };

  const options = {
    workspaceRoot: deps.workspace,
    abortSignal: signal,
    teamRunStore: store,
    onEvent,
    onApprovalRequired: (agentName: string) => approve(`agent ${agentName}`),
    requestApproval: (description: string) => approve(description),
    permissionProfile: deps.permissionProfile,
  };

  const state = await (async (): Promise<TeamRunState> => {
    try {
      if (command.name === "resume") {
        return await runner.resumeFromCheckpoint(
          team,
          command.runId,
          deps.workspace,
          provider,
          toolRegistry,
          { ...options, runId: command.runId },
        );
      }
      const makeRunId =
        deps.newRunId ??
        (() =>
          `team-${(deps.now ?? Date.now)().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
      return await runner.run(team, command.task, provider, toolRegistry, {
        ...options,
        runId: makeRunId(),
      });
    } finally {
      if (ownController) process.removeListener("SIGINT", onSigint);
    }
  })();

  // The runner persists states fire-and-forget; make the final state durable
  // before reporting it so `team history` sees a run that just finished.
  await store.save(state);
  printSummary(state, deps.stdout);
  return state.status === "completed" ? EXIT_OK : EXIT_FAILURE;
}
