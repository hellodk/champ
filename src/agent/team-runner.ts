/**
 * TeamRunner: orchestrates agent team execution.
 *
 * Execution model:
 *   1. Compute parallel groups from dependency DAG (Kahn's BFS)
 *   2. For each group: run eligible agents in parallel (capped by maxParallel)
 *   3. Evaluate conditions — skip agents where condition is false
 *   4. After each agent: check BLOCKED state, file existence validation
 *   5. Emit TeamRunState snapshots after every state change
 *   6. Handle abort signal for clean stop
 */
import * as fs from "fs/promises";
import * as path from "path";
import { ConditionEvaluator } from "./condition-evaluator";
import { SharedMemory } from "./shared-memory";
import { TeamAgent } from "./team-agent";
import type {
  TeamDefinition,
  TeamAgentDefinition,
  TeamRunState,
  TeamAgentRunState,
  TeamAgentStatus,
} from "./team-definition";
import type { LLMProvider } from "../providers/types";
import type { ToolRegistry } from "../tools/registry";
import type { TeamRunStore } from "../ui/team-run-store";

export type TeamRunEvent =
  | { type: "state_update"; state: TeamRunState }
  | { type: "agent_stream"; agentId: string; chunk: string }
  | { type: "blocked"; agentId: string; reason: string }
  | { type: "complete"; state: TeamRunState }
  | { type: "error"; message: string; state: TeamRunState };

export interface TeamRunOptions {
  onEvent?: (event: TeamRunEvent) => void;
  abortSignal?: AbortSignal;
  workspaceRoot?: string;
  /** Called before each agent (supervised) or group (safe) to request user approval. Return false to skip/stop. */
  onApprovalRequired?: (agentName: string) => Promise<boolean>;
  teamRunStore?: TeamRunStore;
}

async function writeCheckpoint(
  workspaceRoot: string,
  runId: string,
  agentId: string,
  memory: SharedMemory,
): Promise<void> {
  try {
    const dir = path.join(workspaceRoot, ".champ", "team-runs", runId);
    await fs.mkdir(dir, { recursive: true });
    const snapshot: Record<string, unknown> = {};
    for (const key of memory.keys()) {
      snapshot[key] = memory.get(key);
    }
    await fs.writeFile(
      path.join(dir, `checkpoint-${agentId}.json`),
      JSON.stringify(snapshot, null, 2),
      "utf-8",
    );
  } catch {
    // Checkpoint write failure is non-fatal
  }
}

export class TeamRunner {
  private evaluator = new ConditionEvaluator();

  /**
   * Compute BFS parallel execution groups from agent dependency graph.
   * Agents in the same group can run in parallel.
   * Returns groups in execution order (group[0] runs first).
   */
  computeExecutionGroups(
    agents: Required<TeamAgentDefinition>[],
  ): Required<TeamAgentDefinition>[][] {
    const inDegree = new Map<string, number>();
    const adj = new Map<string, string[]>();
    const byId = new Map<string, Required<TeamAgentDefinition>>();

    for (const a of agents) {
      inDegree.set(a.id, 0);
      adj.set(a.id, []);
      byId.set(a.id, a);
    }
    for (const a of agents) {
      for (const dep of a.dependsOn) {
        adj.get(dep)!.push(a.id);
        inDegree.set(a.id, (inDegree.get(a.id) ?? 0) + 1);
      }
    }

    const groups: Required<TeamAgentDefinition>[][] = [];
    let frontier = [...inDegree.entries()]
      .filter(([, d]) => d === 0)
      .map(([id]) => byId.get(id)!);

    while (frontier.length > 0) {
      groups.push(frontier);
      const nextFrontier: Required<TeamAgentDefinition>[] = [];
      for (const node of frontier) {
        for (const neighborId of adj.get(node.id) ?? []) {
          const newDeg = (inDegree.get(neighborId) ?? 0) - 1;
          inDegree.set(neighborId, newDeg);
          if (newDeg === 0) nextFrontier.push(byId.get(neighborId)!);
        }
      }
      frontier = nextFrontier;
    }
    return groups;
  }

  /** Returns true if the agent should be skipped based on its condition expression. */
  shouldSkipAgent(
    agent: Required<TeamAgentDefinition>,
    memSnapshot: Record<string, unknown>,
  ): boolean {
    if (!agent.condition) return false;
    return !this.evaluator.evaluate(agent.condition, memSnapshot);
  }

  /** Execute a full team run. Emits TeamRunEvents throughout execution. */
  async run(
    team: TeamDefinition,
    userRequest: string,
    provider: LLMProvider,
    toolRegistry: ToolRegistry,
    options: TeamRunOptions = {},
  ): Promise<TeamRunState> {
    const runId = `team-${Date.now().toString(36)}`;
    const memory = new SharedMemory();
    const workspaceRoot = options.workspaceRoot ?? process.cwd();
    // Store workspaceRoot in memory so ToolCallingLoop can access it
    memory.set("__workspaceRoot", workspaceRoot);
    const startTime = Date.now();

    const agentStates = new Map<string, TeamAgentRunState>(
      team.agents.map((a) => [
        a.id,
        {
          id: a.id,
          name: a.name,
          status: "pending" as TeamAgentStatus,
          output: "",
          tokenCount: 0,
          validationWarnings: [],
          retryCount: 0,
        },
      ]),
    );

    // Token counting: TeamAgent stores usage in SharedMemory under ${agentId}_token_usage.
    // TeamRunner accumulates these as agents complete.
    let totalTokens = 0;
    const filesChanged: string[] = [];

    const buildState = (
      status: TeamRunState["status"] = "running",
    ): TeamRunState => {
      const snapshot: Record<string, string> = {};
      for (const key of memory.keys()) {
        const val = memory.get(key);
        const serialized =
          typeof val === "object" && val !== null
            ? JSON.stringify(val).slice(0, 300)
            : String(val ?? "").slice(0, 300);
        snapshot[key] = serialized;
      }
      return {
        runId,
        teamName: team.name,
        userRequest,
        status,
        agents: [...agentStates.values()],
        sharedMemorySnapshot: snapshot,
        startTime,
        endTime:
          status !== "running" && status !== "paused" ? Date.now() : undefined,
        totalTokens,
        filesChanged,
        mode: team.execution.mode,
      };
    };

    const emit = (status?: TeamRunState["status"]): TeamRunState => {
      const state = buildState(status);
      options.onEvent?.({ type: "state_update", state });
      // Persist state after every change (non-blocking, non-fatal)
      void options.teamRunStore?.save(state);
      return state;
    };

    const groups = this.computeExecutionGroups(team.agents);
    emit("running");

    try {
      for (const group of groups) {
        if (options.abortSignal?.aborted) break;

        // Build memory snapshot for condition evaluation
        const memSnapshot: Record<string, unknown> = {};
        for (const key of memory.keys()) memSnapshot[key] = memory.get(key);

        // Safe mode: pause before each group for approval
        if (team.execution.mode === "safe" && options.onApprovalRequired) {
          const groupNames = group
            .filter((a) => !this.shouldSkipAgent(a, memSnapshot))
            .map((a) => a.name)
            .join(", ");
          if (groupNames) {
            const approved = await options.onApprovalRequired(groupNames);
            if (!approved) {
              // User rejected — mark remaining pending agents as skipped and stop
              for (const [, state] of agentStates) {
                if (state.status === "pending") state.status = "skipped";
              }
              return emit("stopped");
            }
          }
        }

        // Split group into maxParallel-sized batches
        const { maxParallel } = team.execution;
        for (let i = 0; i < group.length; i += maxParallel) {
          if (options.abortSignal?.aborted) break;

          const batch = group.slice(i, i + maxParallel);

          await Promise.all(
            batch.map(async (agentDef) => {
              const agentState = agentStates.get(agentDef.id)!;

              if (this.shouldSkipAgent(agentDef, memSnapshot)) {
                agentState.status = "skipped";
                // Store null sentinel so {{outputKey}} resolves to "(not available)"
                // rather than crashing template interpolation for downstream agents
                memory.set(agentDef.outputKey, null);
                memory.setOutput(agentDef.outputKey, {
                  success: true,
                  output: "",
                  error: undefined,
                });
                emit();
                return;
              }

              // Supervised mode: pause before each individual agent
              if (
                team.execution.mode === "supervised" &&
                options.onApprovalRequired
              ) {
                const approved = await options.onApprovalRequired(
                  agentDef.name,
                );
                if (!approved) {
                  agentState.status = "skipped";
                  emit();
                  return;
                }
              }

              agentState.status = "running";
              agentState.startTime = Date.now();
              emit();

              // Use model override or fall back to provider default
              const effectiveModel =
                agentDef.model || team.defaults.model || "";
              const effectiveProvider =
                effectiveModel && effectiveModel !== provider.config.model
                  ? (provider.withModel?.(effectiveModel) ?? provider)
                  : provider;

              // Build scoped tool registry for this agent
              let scopedRegistry: ToolRegistry | undefined;
              if (agentDef.tools.length > 0) {
                const { ToolRegistry: ToolRegistryClass } =
                  require("../tools/registry") as {
                    ToolRegistry: typeof import("../tools/registry").ToolRegistry;
                  };
                scopedRegistry = new ToolRegistryClass();
                for (const toolName of agentDef.tools) {
                  const tool = toolRegistry.get(toolName);
                  if (tool) scopedRegistry.register(tool);
                }
              }

              const agent = new TeamAgent(
                agentDef,
                effectiveProvider,
                (chunk: string) => {
                  options.onEvent?.({
                    type: "agent_stream",
                    agentId: agentDef.id,
                    chunk,
                  });
                },
                scopedRegistry,
              );

              let attempts = 0;
              const maxAttempts = team.execution.retries + 1;

              while (attempts < maxAttempts) {
                attempts++;

                const timeoutMs = team.execution.timeoutSeconds * 1000;
                const output = await Promise.race([
                  agent.execute({ userRequest, context: [] }, memory),
                  new Promise<never>((_, reject) =>
                    setTimeout(
                      () =>
                        reject(
                          new Error(
                            `Agent "${agentDef.id}" timed out after ${team.execution.timeoutSeconds}s`,
                          ),
                        ),
                      timeoutMs,
                    ),
                  ),
                ]).catch((err: Error) => ({
                  success: false as const,
                  output: `Timed out: ${err.message}`,
                  error: err.message,
                }));

                agentState.output = output.output;
                agentState.endTime = Date.now();

                // BLOCKED state — pause and let user decide
                if (output.error?.startsWith("BLOCKED:")) {
                  agentState.status = "blocked";
                  agentState.blockedReason = output.error
                    .slice("BLOCKED:".length)
                    .trim();
                  emit();
                  options.onEvent?.({
                    type: "blocked",
                    agentId: agentDef.id,
                    reason: agentState.blockedReason,
                  });
                  return;
                }

                if (output.success) {
                  agentState.status = "done";

                  // Accumulate token usage that TeamAgent stored in SharedMemory
                  const agentUsage = memory.get(
                    `${agentDef.id}_token_usage`,
                  ) as
                    | { inputTokens: number; outputTokens: number }
                    | undefined;
                  if (agentUsage) {
                    const agentTokens =
                      (agentUsage.inputTokens ?? 0) +
                      (agentUsage.outputTokens ?? 0);
                    agentState.tokenCount = agentTokens;
                    totalTokens += agentTokens;
                  }

                  if (team.execution.checkpoints) {
                    await writeCheckpoint(
                      workspaceRoot,
                      runId,
                      agentDef.id,
                      memory,
                    );
                  }

                  // Surface template variable warnings
                  const templateWarnings = memory.get(
                    `${agentDef.id}_template_warnings`,
                  );
                  if (Array.isArray(templateWarnings)) {
                    agentState.validationWarnings.push(
                      ...templateWarnings.map((w) => `Template: ${w}`),
                    );
                  }

                  // File existence validation for "files" output format
                  if (agentDef.outputFormat === "files") {
                    const warnings = await validateFilesExist(
                      output.output,
                      workspaceRoot,
                    );
                    agentState.validationWarnings.push(...warnings);
                    filesChanged.push(
                      ...extractMentionedFiles(output.output, workspaceRoot),
                    );
                  }

                  emit();
                  return;
                }

                // Failed — retry if attempts remain
                if (attempts < maxAttempts) {
                  agentState.retryCount++;
                  console.info(
                    `TeamRunner: retrying "${agentDef.id}" (attempt ${attempts + 1}/${maxAttempts})`,
                  );
                }
              }

              // All attempts exhausted
              agentState.status = "failed";
              emit();
            }),
          );
        }
      }

      const agents = [...agentStates.values()];
      const hasBlocked = agents.some((s) => s.status === "blocked");
      const hasFailed = agents.some((s) => s.status === "failed");
      const aborted = options.abortSignal?.aborted ?? false;

      const finalStatus: TeamRunState["status"] = hasBlocked
        ? "paused"
        : hasFailed
          ? "failed"
          : aborted
            ? "stopped"
            : "completed";

      const finalState = emit(finalStatus);
      options.onEvent?.({ type: "complete", state: finalState });
      return finalState;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const finalState = emit("failed");
      options.onEvent?.({ type: "error", message, state: finalState });
      return finalState;
    }
  }
}

/** Check if files mentioned in agent output actually exist on disk. */
async function validateFilesExist(
  output: string,
  workspaceRoot: string,
): Promise<string[]> {
  const warnings: string[] = [];
  const patterns = [
    /(?:created?|wrote?|writing|modified?)[:\s]+([^\s'"`,]+\.\w{1,10})/gi,
    /^#+\s+`?([^\s`]+\.\w{1,10})`?/gm,
  ];
  const mentioned = new Set<string>();
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      mentioned.add(m[1]);
    }
  }
  for (const relPath of mentioned) {
    const abs = path.isAbsolute(relPath)
      ? relPath
      : path.join(workspaceRoot, relPath);
    if (!abs.startsWith(workspaceRoot)) continue; // path traversal guard
    try {
      await fs.access(abs);
    } catch {
      warnings.push(
        `Agent mentioned "${relPath}" but file does not exist on disk`,
      );
    }
  }
  return warnings;
}

/** Extract relative file paths mentioned in output for the filesChanged list. */
function extractMentionedFiles(
  output: string,
  workspaceRoot: string,
): string[] {
  const re = /([^\s'"`,]+\.\w{1,10})/g;
  const found: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const abs = path.isAbsolute(m[1]) ? m[1] : path.join(workspaceRoot, m[1]);
    if (!abs.startsWith(workspaceRoot)) continue;
    found.push(path.relative(workspaceRoot, abs));
  }
  return [...new Set(found)];
}
