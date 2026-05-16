/**
 * Type contracts for agent team definitions loaded from
 * .champ/teams/*.yaml files.
 *
 * Teams are domain-agnostic: DevOps, fullstack, PM, SRE, data science —
 * any combination of specialized agents can be described here.
 */

/** Status of an individual agent within a team run. */
export type TeamAgentStatus =
  | "pending" // waiting for dependencies
  | "running" // currently executing
  | "done" // completed successfully
  | "failed" // error — optionally retried
  | "skipped" // condition was false
  | "blocked"; // agent emitted BLOCKED: <reason>

/** Execution mode for the team (controls approval gates). */
export type TeamExecutionMode = "auto" | "safe" | "supervised";

/** A single agent within a team definition. */
export interface TeamAgentDefinition {
  /** Unique identifier within the team, used in dependsOn references. */
  id: string;
  /** Display name shown in the team panel. */
  name: string;
  /** One-line role description, injected into the system prompt header. */
  role: string;
  /**
   * The agent's full system prompt. Supports {{key.path}} template variables
   * that are resolved from SharedMemory at execution time.
   */
  systemPrompt: string;
  /** IDs of agents that must complete before this one starts. Default: []. */
  dependsOn?: string[];
  /**
   * Simple boolean expression evaluated against SharedMemory.
   * Agent is skipped when the expression is false.
   * Example: "plan.assignments.infra != null"
   */
  condition?: string;
  /**
   * Subset of tool names this agent is allowed to use.
   * If omitted, the agent has no tool access (LLM-only).
   */
  tools?: string[];
  /**
   * Model override for this agent. Uses the team default if omitted.
   */
  model?: string;
  /** Maximum tokens for this agent's LLM response. Default: 4096. */
  maxTokens?: number;
  /**
   * Key under which this agent's output is stored in SharedMemory.
   * Defaults to the agent's id.
   */
  outputKey?: string;
  /**
   * Expected output format — used for post-execution validation.
   * "json": output is validated as parseable JSON.
   * "files": agent is expected to have created/edited files.
   * "text": no structural validation (default).
   */
  outputFormat?: "text" | "json" | "files";
  /**
   * Enable the self-critique pass for this agent.
   * When true, after the main response a lightweight critic prompt asks
   * "find at least one problem". If a serious issue is found, one retry
   * is triggered. Default: false.
   */
  selfCritique?: boolean;
  /**
   * List of channel names this agent subscribes to before executing.
   * For each channel, the agent waits (up to 30s) for a publish event
   * before starting its main LLM call. Channel data is injected into the
   * user message as [Channel <name>]: <json>. Default: [].
   */
  subscribes?: string[];
}

/** Team-level execution configuration. */
export interface TeamExecutionConfig {
  /** Max agents running simultaneously. Default: 3. */
  maxParallel: number;
  /** Hard cap on total tokens across all agents. Default: 100000. */
  totalTokenBudget: number;
  /** Per-agent timeout in seconds. Default: 120. */
  timeoutSeconds: number;
  /** How many times to retry a failed agent. Default: 1. */
  retries: number;
  /** Save SharedMemory state after each agent. Default: true. */
  checkpoints: boolean;
  /** Whether to pause for user approval at each agent boundary. Default: "auto". */
  mode: TeamExecutionMode;
  /**
   * Maximum number of dynamically spawned agents allowed during a run.
   * SPAWN requests beyond this cap are silently dropped. Default: 10.
   */
  maxDynamicAgents?: number;
}

/** Default model + parameters applied to agents that don't override. */
export interface TeamDefaults {
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/** A fully parsed and validated team definition. */
export interface TeamDefinition {
  /** Display name shown in the team picker. */
  name: string;
  /** One-line description shown under the name in the picker. */
  description: string;
  /** Semver string for the team definition itself. Default: "1". */
  version: string;
  /** Agents in definition order. Execution order is determined by dependsOn DAG. */
  agents: Required<TeamAgentDefinition>[];
  /** Execution configuration (all fields populated from defaults). */
  execution: TeamExecutionConfig;
  /** Default model/parameter overrides for agents that don't specify their own. */
  defaults: TeamDefaults;
  /** Absolute path to the source YAML file. */
  sourcePath: string;
}

/** Live state of one agent during a team run. */
export interface TeamAgentRunState {
  id: string;
  name: string;
  status: TeamAgentStatus;
  /** Accumulated streaming output text. */
  output: string;
  startTime?: number;
  endTime?: number;
  tokenCount: number;
  blockedReason?: string;
  validationWarnings: string[];
  retryCount: number;
}

/** Full state of a team run, sent to the TeamPanel. */
export interface TeamRunState {
  runId: string;
  teamName: string;
  userRequest: string;
  status: "running" | "paused" | "completed" | "failed" | "stopped";
  agents: TeamAgentRunState[];
  /** Snapshot of SharedMemory keys (values serialized for display). */
  sharedMemorySnapshot: Record<string, string>;
  startTime: number;
  endTime?: number;
  totalTokens: number;
  /** Token budget from team config (0 or undefined = no budget set). */
  tokenBudget?: number;
  filesChanged: string[];
  mode: TeamExecutionMode;
}
