/**
 * Type definitions for the sub-agent delegation system.
 *
 * Defines interfaces for:
 * - SubAgent: a registered agent available for delegation
 * - DelegatedTask: a task to be delegated to an agent
 * - DelegationState: lifecycle states for delegated tasks
 * - DelegationResult: outcome of a delegation attempt
 */

/**
 * A task that can be delegated to a sub-agent.
 */
export interface DelegatedTask {
  /** Unique identifier for this task. */
  id: string;
  /** Human-readable description of the task. */
  description: string;
  /** Parameters to pass to the agent's execute() method. */
  params: Record<string, unknown>;
  /** Optional priority level (higher = more urgent). */
  priority?: number;
  /** Optional timeout in milliseconds. */
  timeoutMs?: number;
}

/**
 * Result of executing a delegated task.
 */
export interface DelegationResult {
  /** Unique identifier of the delegated task. */
  taskId: string;
  /** ID of the agent that handled the task. */
  agentId?: string;
  /** Whether the task completed successfully. */
  success: boolean;
  /** Task output or result. */
  output?: string;
  /** Error message if the task failed. */
  error?: string;
  /** Number of retry attempts made. */
  attempts: number;
  /** Total duration in milliseconds. */
  durationMs: number;
}

/**
 * Lifecycle states for a delegated task.
 */
export type DelegationState =
  | "pending" // Waiting to be assigned to an agent
  | "running" // Currently executing on an agent
  | "completed" // Task finished successfully
  | "failed" // Task failed after all retries
  | "cancelled"; // Task was cancelled before completion

/**
 * Status information for a delegated task.
 */
export interface TaskStatus {
  /** Current state of the task. */
  state: DelegationState;
  /** Whether the task was ultimately successful. */
  success: boolean | undefined;
  /** ID of the agent handling this task. */
  agentId?: string;
  /** Number of attempts made so far. */
  attempts: number;
  /** Timestamp when the task started. */
  startedAt: number;
  /** Timestamp when the task completed (if finished). */
  completedAt?: number;
  /** Current progress percentage (0-100). */
  progress: number;
  /** Optional error message. */
  error?: string;
}

/**
 * A sub-agent available for task delegation.
 */
export interface SubAgent {
  /** Unique identifier for the agent. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Maximum number of tasks that can run concurrently. */
  maxConcurrentTasks: number;
  /**
   * Execute the given task parameters.
   * Should return a result with { success, output, error? }.
   */
  execute(params: Record<string, unknown>): Promise<{
    success: boolean;
    output: string;
    error?: string;
  }>;
}

/**
 * Progress event emitted during task delegation lifecycle.
 */
export interface DelegationProgressEvent {
  /** Type of progress event. */
  type:
    | "task_started"
    | "task_retry"
    | "task_progress"
    | "task_completed"
    | "task_failed"
    | "agent_assigned";
  /** ID of the task. */
  taskId: string;
  /** ID of the agent (if applicable). */
  agentId?: string;
  /** Message describing the event. */
  message?: string;
  /** Retry count (for task_retry events). */
  retryCount?: number;
  /** Progress percentage (for task_progress events). */
  progress?: number;
  /** Timestamp of the event. */
  timestamp: number;
}

/**
 * Execution log entry for audit and debugging.
 */
export interface ExecutionLogEntry {
  /** Timestamp of the log entry. */
  timestamp: number;
  /** Log message. */
  message: string;
  /** Log level (info, warn, error). */
  level: "info" | "warn" | "error";
  /** Optional additional context. */
  context?: Record<string, unknown>;
}

/**
 * Configuration for the DelegationManager.
 */
export interface DelegationManagerConfig {
  /** Maximum number of retry attempts for failed tasks. */
  maxRetries?: number;
  /** Default timeout for tasks in milliseconds. */
  defaultTimeoutMs?: number;
}
