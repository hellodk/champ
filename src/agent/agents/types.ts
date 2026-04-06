/**
 * Multi-agent system type contracts.
 *
 * Each specialized agent (Planner, Code, Reviewer, Validator, Context,
 * File) implements the Agent interface. The orchestrator passes a
 * SharedMemory instance between them so downstream agents can see the
 * structured outputs of earlier agents.
 */

/**
 * Input passed to every agent execution.
 */
export interface AgentInput {
  /** The original user request that triggered the workflow. */
  userRequest: string;
  /** Optional pre-gathered context (file chunks, uploaded files, etc.). */
  context: ContextChunk[];
}

/**
 * A chunk of code or text used as input context for an agent.
 */
export interface ContextChunk {
  filePath: string;
  text: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
}

/**
 * A single step in a structured execution plan produced by the PlannerAgent.
 */
export interface PlanStep {
  step: number;
  description: string;
  targetFiles: string[];
  actionType?: "read" | "write" | "search" | "run" | "test";
}

export interface Plan {
  steps: PlanStep[];
}

/**
 * A single file edit produced by the CodeAgent.
 */
export interface Diff {
  filePath: string;
  oldContent: string;
  newContent: string;
}

/**
 * A single review issue identified by the ReviewerAgent.
 */
export interface ReviewIssue {
  severity: "error" | "warning" | "info";
  description: string;
  file: string;
  line?: number;
}

/**
 * Output returned by every agent execution. Specialized agents populate
 * the fields relevant to their role; other fields remain undefined.
 */
export interface AgentOutput {
  /** Whether the agent succeeded. Retry logic keys off this flag. */
  success: boolean;
  /** Human-readable summary of what the agent did. */
  output: string;
  /** Error message if the agent failed. */
  error?: string;

  // Role-specific fields:

  /** Populated by PlannerAgent. */
  plan?: Plan | PlanStep[];
  /** Populated by ContextAgent. */
  chunks?: ContextChunk[];
  /** Populated by CodeAgent. */
  diffs?: Diff[];
  /** Populated by ReviewerAgent. */
  approved?: boolean;
  feedback?: string;
  issues?: ReviewIssue[];
  /** Populated by ValidatorAgent. */
  passed?: boolean;
}

/**
 * A single message passed between agents via SharedMemory.
 */
export interface AgentMessage {
  from: string;
  to: string;
  content: Record<string, unknown>;
  timestamp: number;
}

/**
 * Shared memory accessible to all agents in a workflow.
 */
export interface SharedMemory {
  /** Store a generic key-value pair. */
  set(key: string, value: unknown): void;
  /** Retrieve a stored value. */
  get(key: string): unknown;
  /** Check if a key exists. */
  has(key: string): boolean;
  /** List all stored keys. */
  keys(): string[];

  /** Record an agent's output. Later agents can read this via getOutput. */
  setOutput(agentName: string, output: AgentOutput): void;
  /** Retrieve an agent's output. */
  getOutput(agentName: string): AgentOutput | undefined;

  /** Send a message from one agent to another. */
  sendMessage(from: string, to: string, content: Record<string, unknown>): void;
  /** Retrieve all messages addressed to the given agent. */
  getMessages(agentName: string): AgentMessage[];

  /** Clear all state. Called at the start of a new workflow. */
  reset(): void;
}

/**
 * Interface implemented by all specialized agents.
 */
export interface Agent {
  /** Unique agent name (e.g., "planner", "code"). */
  name: string;
  /** Human-readable role description (used in system prompts). */
  role: string;
  /**
   * Execute the agent. Must read any upstream agent outputs from `memory`
   * and write its own output via memory.setOutput() (or return it).
   */
  execute(input: AgentInput, memory: SharedMemory): Promise<AgentOutput>;
}
