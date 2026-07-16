/**
 * TDD: Unit tests for DelegationManager — sub-agent task delegation.
 *
 * Tests the core delegation logic:
 * - Task routing to available sub-agents based on capacity
 * - Execution state tracking and transitions
 * - Retry mechanism on failure
 * - Progress reporting
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { DelegationManager } from "@/agent/delegation/delegation-manager";
import type {
  SubAgent,
  DelegatedTask,
  DelegationState,
} from "@/agent/delegation/types";

describe("DelegationManager", () => {
  let delegationManager: DelegationManager;
  let mockSubAgent1: SubAgent;
  let mockSubAgent2: SubAgent;

  beforeEach(() => {
    delegationManager = new DelegationManager({ maxRetries: 3 });

    // Create mock sub-agents with tracked capacity
    mockSubAgent1 = {
      id: "agent-1",
      name: "TestAgent1",
      maxConcurrentTasks: 3,
      execute: vi
        .fn()
        .mockResolvedValue({ success: true, output: "Agent 1 success" }),
    };

    mockSubAgent2 = {
      id: "agent-2",
      name: "TestAgent2",
      maxConcurrentTasks: 2,
      execute: vi
        .fn()
        .mockResolvedValue({ success: true, output: "Agent 2 success" }),
    };

    delegationManager.registerAgent(mockSubAgent1);
    delegationManager.registerAgent(mockSubAgent2);
  });

  afterEach(() => {
    delegationManager.dispose();
  });

  describe("Task Routing", () => {
    it("should route task to available agent with lowest load", async () => {
      const task: DelegatedTask = {
        id: "task-1",
        description: "Test task",
        params: { input: "test" },
      };

      const result = await delegationManager.delegate(task);

      expect(result.success).toBe(true);
      expect(result.agentId).toBe("agent-1");
      expect(mockSubAgent1.execute).toHaveBeenCalledWith(task.params);
    });

    it("should route to alternative agent when first agent is at capacity", async () => {
      // Block agent-1 by creating a long-running task
      let blockResolve: () => void;
      const blockPromise = new Promise<void>((resolve) => {
        blockResolve = resolve;
      });

      const blockingAgent: SubAgent = {
        id: "blocking-agent",
        name: "BlockingAgent",
        maxConcurrentTasks: 1,
        execute: vi.fn().mockImplementation(async () => {
          await blockPromise;
          return { success: true, output: "Unblocked" };
        }),
      };

      const altAgent: SubAgent = {
        id: "alt-agent",
        name: "AltAgent",
        maxConcurrentTasks: 1,
        execute: vi
          .fn()
          .mockResolvedValue({ success: true, output: "Alt success" }),
      };

      const dm = new DelegationManager({ maxRetries: 1 });
      dm.registerAgent(blockingAgent);
      dm.registerAgent(altAgent);

      // Start blocking task
      const blockingTask: DelegatedTask = {
        id: "blocking-task",
        description: "Blocking task",
        params: { input: "test" },
      };

      const blockingPromise = dm.delegate(blockingTask);

      // Give it a tick to start
      await new Promise((r) => setTimeout(r, 10));

      // Next task should go to alt agent
      const nextTask: DelegatedTask = {
        id: "alt-task",
        description: "Alternative task",
        params: { input: "test" },
      };

      const result = await dm.delegate(nextTask);
      expect(result.agentId).toBe("alt-agent");

      // Cleanup
      blockResolve!();
      await blockingPromise;
      dm.dispose();
    });

    it("should reject delegation when all agents are at capacity", async () => {
      // Fill up both agents
      mockSubAgent1.maxConcurrentTasks = 0;
      mockSubAgent2.maxConcurrentTasks = 0;

      const task: DelegatedTask = {
        id: "task-full",
        description: "Cannot delegate",
        params: { input: "test" },
      };

      const result = await delegationManager.delegate(task);
      expect(result.success).toBe(false);
      expect(result.error).toContain("No available agents");
    });
  });

  describe("Execution State Tracking", () => {
    it("should track task state transitions", async () => {
      const task: DelegatedTask = {
        id: "task-state",
        description: "State tracking task",
        params: { input: "test" },
      };

      const stateChanges: DelegationState[] = [];
      delegationManager.onStateChange((taskId, newState) => {
        if (taskId === "task-state") {
          stateChanges.push(newState);
        }
      });

      await delegationManager.delegate(task);

      // Should have transitioned through: pending -> running -> completed
      expect(stateChanges).toContain("pending");
      expect(stateChanges).toContain("running");
      expect(stateChanges).toContain("completed");
    });

    it("should provide access to task status", async () => {
      const task: DelegatedTask = {
        id: "task-status",
        description: "Status check task",
        params: { input: "test" },
      };

      await delegationManager.delegate(task);

      const status = delegationManager.getTaskStatus("task-status");
      expect(status).toBeDefined();
      expect(status?.state).toBe("completed");
      expect(status?.success).toBe(true);
    });

    it("should return undefined for non-existent task", () => {
      const status = delegationManager.getTaskStatus("non-existent");
      expect(status).toBeUndefined();
    });
  });

  describe("Retry Mechanism", () => {
    it("should retry failed task up to maxRetries", async () => {
      const maxRetries = 2;
      const dm = new DelegationManager({ maxRetries });

      const failingAgent: SubAgent = {
        id: "failing-agent",
        name: "FailingAgent",
        maxConcurrentTasks: 1,
        execute: vi.fn().mockRejectedValue(new Error("Execution failed")),
      };

      dm.registerAgent(failingAgent);

      const task: DelegatedTask = {
        id: "task-retry",
        description: "Failing task",
        params: { input: "test" },
      };

      const result = await dm.delegate(task);

      expect(result.success).toBe(false);
      expect(failingAgent.execute).toHaveBeenCalledTimes(maxRetries + 1); // initial + retries
      dm.dispose();
    });

    it("should succeed if task passes on retry", async () => {
      const dm = new DelegationManager({ maxRetries: 3 });

      let callCount = 0;
      const retryAgent: SubAgent = {
        id: "retry-agent",
        name: "RetryAgent",
        maxConcurrentTasks: 1,
        execute: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount < 2) {
            throw new Error("First attempt failed");
          }
          return { success: true, output: "Succeeded on retry" };
        }),
      };

      dm.registerAgent(retryAgent);

      const task: DelegatedTask = {
        id: "task-retry-success",
        description: "Eventually succeeds",
        params: { input: "test" },
      };

      const result = await dm.delegate(task);

      expect(result.success).toBe(true);
      expect(result.output).toBe("Succeeded on retry");
      expect(retryAgent.execute).toHaveBeenCalledTimes(2);
      dm.dispose();
    });
  });

  describe("Progress Tracking", () => {
    it("should report progress events during execution", async () => {
      const progressEvents: string[] = [];
      delegationManager.onProgress((event) => {
        progressEvents.push(event.type);
      });

      const task: DelegatedTask = {
        id: "task-progress",
        description: "Progress tracking",
        params: { input: "test" },
      };

      await delegationManager.delegate(task);

      expect(progressEvents).toContain("task_started");
      expect(progressEvents).toContain("task_completed");
    });

    it("should include retry count in progress events", async () => {
      const dm = new DelegationManager({ maxRetries: 3 });

      let callCount = 0;
      const agent: SubAgent = {
        id: "progress-agent",
        name: "ProgressAgent",
        maxConcurrentTasks: 1,
        execute: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount < 2) {
            throw new Error("First attempt failed");
          }
          return { success: true, output: "Success" };
        }),
      };

      dm.registerAgent(agent);

      const progressEvents: Array<{ type: string; retryCount?: number }> = [];
      dm.onProgress((event) => {
        progressEvents.push(event);
      });

      const task: DelegatedTask = {
        id: "task-retry-progress",
        description: "Retry with progress",
        params: { input: "test" },
      };

      await dm.delegate(task);

      const retryEvent = progressEvents.find((e) => e.type === "task_retry");
      expect(retryEvent).toBeDefined();
      expect(retryEvent?.retryCount).toBe(1);
      dm.dispose();
    });
  });

  describe("Execution Logs", () => {
    it("should provide access to execution logs", async () => {
      const task: DelegatedTask = {
        id: "task-logs",
        description: "Logging task",
        params: { input: "test" },
      };

      await delegationManager.delegate(task);

      const logs = delegationManager.getExecutionLogs("task-logs");
      expect(logs).toBeDefined();
      expect(logs?.length).toBeGreaterThan(0);
      expect(logs?.[0]).toHaveProperty("timestamp");
      expect(logs?.[0]).toHaveProperty("message");
    });

    it("should return empty array for non-existent task logs", () => {
      const logs = delegationManager.getExecutionLogs("non-existent");
      expect(logs).toEqual([]);
    });
  });

  describe("Multiple Parallel Delegations", () => {
    it("should handle multiple parallel tasks correctly", async () => {
      const tasks = Array.from({ length: 5 }, (_, i) => ({
        id: `task-${i}`,
        description: `Parallel task ${i}`,
        params: { input: `test-${i}` },
      }));

      const results = await Promise.all(
        tasks.map((t) => delegationManager.delegate(t)),
      );

      expect(results).toHaveLength(5);
      results.forEach((result, i) => {
        expect(result.success).toBe(true);
        expect(result.taskId).toBe(`task-${i}`);
      });
    });
  });
});
