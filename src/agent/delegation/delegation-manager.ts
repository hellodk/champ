/**
 * DelegationManager: coordinates task delegation to sub-agents.
 *
 * Responsibilities:
 * - Route tasks to available sub-agents based on capacity
 * - Track execution state and progress of delegated tasks
 * - Handle retries on failure
 * - Provide execution logs and debugging information
 * - Support parallel task execution
 */

import type {
  SubAgent,
  DelegatedTask,
  DelegationResult,
  DelegationState,
  TaskStatus,
  DelegationProgressEvent,
  ExecutionLogEntry,
  DelegationManagerConfig,
} from "./types";

export class DelegationManager {
  private agents = new Map<string, SubAgent>();
  private tasks = new Map<string, TaskStatus>();
  private logs = new Map<string, ExecutionLogEntry[]>();
  private runningTasks = new Map<string, Set<string>>(); // agent ID -> set of task IDs
  private maxRetries: number;
  private defaultTimeoutMs: number;
  private onStateChangeCallback?: (
    taskId: string,
    state: DelegationState,
  ) => void;
  private onProgressCallback?: (event: DelegationProgressEvent) => void;

  constructor(config: DelegationManagerConfig = {}) {
    this.maxRetries = config.maxRetries ?? 3;
    this.defaultTimeoutMs = config.defaultTimeoutMs ?? 30000;
  }

  /**
   * Register a sub-agent available for delegation.
   */
  registerAgent(agent: SubAgent): void {
    this.agents.set(agent.id, agent);
    this.runningTasks.set(agent.id, new Set());
  }

  /**
   * Unregister a sub-agent (remove from delegation pool).
   */
  unregisterAgent(agentId: string): void {
    if (this.agents.has(agentId)) {
      this.agents.delete(agentId);
      this.runningTasks.delete(agentId);
    }
  }

  /**
   * List all registered agents.
   */
  getRegisteredAgents(): SubAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Register a callback for state change events.
   */
  onStateChange(
    callback: (taskId: string, state: DelegationState) => void,
  ): void {
    this.onStateChangeCallback = callback;
  }

  /**
   * Register a callback for progress events.
   */
  onProgress(callback: (event: DelegationProgressEvent) => void): void {
    this.onProgressCallback = callback;
  }

  /**
   * Delegate a task to the best available sub-agent.
   * Routes based on current load and retries on failure.
   */
  async delegate(task: DelegatedTask): Promise<DelegationResult> {
    const startTime = Date.now();
    const initialState: TaskStatus = {
      state: "pending",
      attempts: 0,
      startedAt: startTime,
      progress: 0,
      success: undefined,
    };
    this.tasks.set(task.id, initialState);
    this.logs.set(task.id, []);

    // Emit initial state change
    this.setState(task.id, "pending");
    this.taskLog(
      task.id,
      "info",
      `Task ${task.id} created: ${task.description}`,
    );

    let lastError: Error | undefined;
    const maxAttempts = this.maxRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // Find best available agent
        const agent = this.selectAgent();
        if (!agent) {
          this.taskLog(task.id, "error", "No available agents with capacity");
          return this.createResult(
            task.id,
            false,
            startTime,
            maxAttempts,
            "No available agents with capacity",
          );
        }

        // Assign agent and change state to running
        const taskStatus = this.tasks.get(task.id)!;
        taskStatus.agentId = agent.id;
        taskStatus.state = "running";
        taskStatus.attempts = attempt;
        this.setState(task.id, "running");

        this.taskLog(
          task.id,
          "info",
          `Task assigned to ${agent.name} (${agent.id})`,
        );

        // Emit agent assigned event
        this.emitProgress({
          type: "agent_assigned",
          taskId: task.id,
          agentId: agent.id,
          message: `Task assigned to ${agent.name}`,
          timestamp: Date.now(),
        });

        // Emit task started event
        this.emitProgress({
          type: "task_started",
          taskId: task.id,
          agentId: agent.id,
          message: `Task ${task.id} started on ${agent.name}`,
          timestamp: Date.now(),
        });

        // Add task to running set
        const runningSet = this.runningTasks.get(agent.id) || new Set();
        runningSet.add(task.id);
        this.runningTasks.set(agent.id, runningSet);

        try {
          const result = await Promise.race([
            agent.execute(task.params),
            this.createTimeout(task.timeoutMs ?? this.defaultTimeoutMs),
          ]);

          // Remove task from running set
          runningSet.delete(task.id);

          if (!result.success) {
            throw new Error(
              result.error ?? "Task execution failed without error message",
            );
          }

          // Success!
          this.setState(task.id, "completed");
          taskStatus.success = true;
          this.taskLog(task.id, "info", `Task completed: ${result.output}`);

          this.emitProgress({
            type: "task_completed",
            taskId: task.id,
            agentId: agent.id,
            message: result.output,
            timestamp: Date.now(),
          });

          return this.createResult(
            task.id,
            true,
            startTime,
            attempt,
            result.output,
          );
        } catch (error) {
          // Remove task from running set
          runningSet.delete(task.id);

          lastError = error as Error;
          this.taskLog(
            task.id,
            "warn",
            `Attempt ${attempt} failed: ${(error as Error).message}`,
          );

          // Emit retry event if we'll retry
          if (attempt < maxAttempts) {
            this.emitProgress({
              type: "task_retry",
              taskId: task.id,
              agentId: agent.id,
              message: `Retrying task ${task.id} (attempt ${attempt + 1})`,
              retryCount: attempt,
              timestamp: Date.now(),
            });

            // Update state back to pending before retry
            this.setState(task.id, "pending");
          }
        }
      } catch (error) {
        lastError = error as Error;
        this.taskLog(
          task.id,
          "error",
          `Attempt ${attempt} error: ${(error as Error).message}`,
        );
      }
    }

    // All retries exhausted
    this.setState(task.id, "failed");
    const taskStatus = this.tasks.get(task.id)!;
    taskStatus.success = false;
    this.taskLog(task.id, "error", `Task failed after ${maxAttempts} attempts`);

    this.emitProgress({
      type: "task_failed",
      taskId: task.id,
      message: `Task ${task.id} failed after ${maxAttempts} attempts`,
      timestamp: Date.now(),
    });

    return this.createResult(
      task.id,
      false,
      startTime,
      maxAttempts,
      lastError?.message ?? "Task failed",
    );
  }

  /**
   * Get the current status of a delegated task.
   */
  getTaskStatus(taskId: string): TaskStatus | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Get execution logs for a task.
   */
  getExecutionLogs(taskId: string): ExecutionLogEntry[] {
    return this.logs.get(taskId) ?? [];
  }

  /**
   * Dispose of the manager and clean up resources.
   */
  dispose(): void {
    this.agents.clear();
    this.tasks.clear();
    this.logs.clear();
    this.runningTasks.clear();
  }

  /**
   * ─── Private Helpers ──────────────────────────────────────────
   */

  private selectAgent(): SubAgent | null {
    let bestAgent: SubAgent | null = null;
    let lowestLoad = Infinity;

    for (const agent of this.agents.values()) {
      const runningSet = this.runningTasks.get(agent.id) || new Set();
      const runningCount = runningSet.size;

      // Skip if agent is at capacity
      if (runningCount >= agent.maxConcurrentTasks) {
        continue;
      }

      // Prefer agent with lowest load
      if (runningCount < lowestLoad) {
        lowestLoad = runningCount;
        bestAgent = agent;
      }
    }

    return bestAgent;
  }

  private setState(taskId: string, state: DelegationState): void {
    const taskStatus = this.tasks.get(taskId);
    if (taskStatus) {
      taskStatus.state = state;
    }
    this.onStateChangeCallback?.(taskId, state);
  }

  private emitProgress(event: DelegationProgressEvent): void {
    this.onProgressCallback?.(event);
  }

  private createResult(
    taskId: string,
    success: boolean,
    startTime: number,
    attempts: number,
    output?: string,
  ): DelegationResult {
    const durationMs = Date.now() - startTime;
    const taskStatus = this.tasks.get(taskId);

    return {
      taskId,
      agentId: taskStatus?.agentId,
      success,
      output,
      attempts,
      durationMs,
      error: success ? undefined : output,
    };
  }

  private createTimeout(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Task timeout after ${ms}ms`)), ms);
    });
  }

  private taskLog(
    taskId: string,
    level: "info" | "warn" | "error",
    message: string,
    context?: Record<string, unknown>,
  ): void {
    const entry: ExecutionLogEntry = {
      timestamp: Date.now(),
      message,
      level,
      context,
    };

    const taskLogs = this.logs.get(taskId) || [];
    taskLogs.push(entry);
    this.logs.set(taskId, taskLogs);
  }
}
