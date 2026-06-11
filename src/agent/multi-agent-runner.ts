/**
 * MultiAgentRunner: coordinates a multi-agent workflow.
 *
 * Executes a sequence of agents (potentially a DAG in more complex
 * workflows) against a shared memory, with retry and conditional
 * branching support.
 *
 * Two retry behaviours are supported:
 *   1. Simple retry — on failure, re-run the same agent up to maxRetries
 *      times.
 *   2. Retry-from branching — on failure of agent X, roll back to a
 *      prior agent Y and re-run from Y. Configured via `retryFrom` and
 *      used for "reviewer rejects code, retry from code" patterns.
 *
 * Also hosts AgentOrchestrator (DAG-based execution) which was previously
 * in a separate orchestrator.ts module.
 */
import type { AgentAnalytics } from "../observability/agent-analytics";
import type { AgentRunReport } from "../agent-manager/types";
import type { IWorkflowRunner } from "./workflow-runner";
import type {
  Agent,
  AgentOutput,
  ContextChunk,
  SharedMemory as ISharedMemory,
} from "./agents/types";
import { SharedMemory } from "./shared-memory";

// ── Shared type definitions (previously in orchestrator.ts) ──────────────────

export interface ExecutionLogEntry {
  agentName: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  success: boolean;
  output: string;
  attempt: number;
}

export interface WorkflowResult extends AgentOutput {
  executionLog: ExecutionLogEntry[];
}

export type AgentProgressEvent =
  | {
      type: "agent_started";
      agentName: string;
      step: number;
      totalSteps: number;
    }
  | {
      type: "agent_completed";
      agentName: string;
      durationMs: number;
      success: boolean;
      output: string;
    }
  | { type: "agent_failed"; agentName: string; error: string; attempt: number };

export interface WorkflowOptions {
  /** Maximum retries per agent (or per branch in retry-from mode). */
  maxRetries?: number;
  /**
   * Map from agent name to the agent it should retry from on failure.
   * Example: { reviewer: 'code' } — on reviewer failure, re-run code
   * and then reviewer again.
   */
  retryFrom?: Record<string, string>;
  /** Optional initial context (passed as AgentInput.context). */
  context?: ContextChunk[];
  /** Abort signal to cancel the workflow mid-execution. */
  abortSignal?: AbortSignal;
  /** Called before and after each agent executes. */
  onAgentProgress?: (event: AgentProgressEvent) => void;
}

export interface DAGNode {
  name: string;
  condition?: (memory: ISharedMemory) => boolean;
  next?: (
    output: AgentOutput,
    memory: ISharedMemory,
  ) => string | null | undefined;
}

// ── AgentOrchestrator (DAG-based execution) ──────────────────────────────────

const DEFAULT_MAX_RETRIES = 3;

export class AgentOrchestrator {
  private agents = new Map<string, Agent>();

  registerAgent(agent: Agent): void {
    this.agents.set(agent.name, agent);
  }

  unregisterAgent(name: string): void {
    this.agents.delete(name);
  }

  getAgent(name: string): Agent | undefined {
    return this.agents.get(name);
  }

  listAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Execute a workflow: run the listed agents in order, passing shared
   * memory between them.
   */
  async executeWorkflow(
    userRequest: string,
    sequence: string[],
    options: WorkflowOptions = {},
  ): Promise<WorkflowResult> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryFrom = options.retryFrom ?? {};

    // Validate that every named agent is registered before we start.
    for (const name of sequence) {
      if (!this.agents.has(name)) {
        throw new Error(`Agent "${name}" is not registered`);
      }
    }

    const memory = new SharedMemory();
    const executionLog: ExecutionLogEntry[] = [];
    // Tracks the number of attempts each agent has made so we can stop
    // retrying once maxRetries is reached.
    const attempts = new Map<string, number>();
    let lastOutput: AgentOutput = {
      success: true,
      output: "Workflow initialized",
    };

    const fireProgress = (event: AgentProgressEvent): void => {
      try {
        options.onAgentProgress?.(event);
      } catch {
        // Callback errors must not crash the workflow.
      }
    };

    let i = 0;
    while (i < sequence.length) {
      if (options.abortSignal?.aborted) {
        return {
          success: false,
          output: "Workflow aborted",
          executionLog,
        };
      }

      const name = sequence[i];
      const agent = this.agents.get(name)!;
      const attemptNumber = (attempts.get(name) ?? 0) + 1;
      attempts.set(name, attemptNumber);

      if (attemptNumber > maxRetries) {
        return {
          success: false,
          output: `Agent "${name}" exceeded max retries (${maxRetries})`,
          error: lastOutput.error,
          executionLog,
        };
      }

      fireProgress({
        type: "agent_started",
        agentName: name,
        step: i + 1,
        totalSteps: sequence.length,
      });

      const startTime = Date.now();
      let output: AgentOutput;
      try {
        output = await agent.execute(
          { userRequest, context: options.context ?? [] },
          memory,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output = {
          success: false,
          output: `Exception: ${message}`,
          error: message,
        };
      }
      const endTime = Date.now();

      executionLog.push({
        agentName: name,
        startTime,
        endTime,
        durationMs: endTime - startTime,
        success: output.success,
        output: output.output,
        attempt: attemptNumber,
      });

      if (output.success) {
        fireProgress({
          type: "agent_completed",
          agentName: name,
          durationMs: endTime - startTime,
          success: true,
          output: output.output,
        });
      } else {
        fireProgress({
          type: "agent_failed",
          agentName: name,
          error: output.error ?? output.output,
          attempt: attemptNumber,
        });
      }

      memory.setOutput(name, output);
      lastOutput = output;

      if (output.success) {
        i++;
        continue;
      }

      // Agent failed. Decide whether to retry in place or branch back.
      const branchTarget = retryFrom[name];
      if (branchTarget) {
        const branchIdx = sequence.indexOf(branchTarget);
        if (branchIdx !== -1 && branchIdx < i) {
          // Reset the target agent's attempt counter so it can re-run,
          // but keep the failing agent's counter so it still counts
          // against maxRetries.
          attempts.set(branchTarget, 0);
          i = branchIdx;
          continue;
        }
      }

      // Simple retry in place: don't advance i, let the loop re-run.
      // maxRetries check at the top of the loop will stop runaway retries.
    }

    return {
      success: lastOutput.success,
      output: lastOutput.output,
      error: lastOutput.error,
      plan: lastOutput.plan,
      chunks: lastOutput.chunks,
      diffs: lastOutput.diffs,
      approved: lastOutput.approved,
      feedback: lastOutput.feedback,
      issues: lastOutput.issues,
      passed: lastOutput.passed,
      executionLog,
    };
  }

  /**
   * Execute a DAG workflow: run agents according to a node list that
   * supports per-node skip conditions and dynamic routing to named nodes.
   */
  async executeDAG(
    userRequest: string,
    nodes: DAGNode[],
    options: WorkflowOptions = {},
  ): Promise<WorkflowResult> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

    // Validate that every named agent is registered before we start.
    for (const node of nodes) {
      if (!this.agents.has(node.name)) {
        throw new Error(`Agent "${node.name}" is not registered`);
      }
    }

    const memory = new SharedMemory();
    if (options.context) {
      memory.set("context", options.context);
    }
    memory.set("userRequest", userRequest);

    const executionLog: ExecutionLogEntry[] = [];
    const attempts = new Map<string, number>();
    let lastOutput: AgentOutput = {
      success: true,
      output: "Workflow initialized",
    };

    // Build lookup maps for O(1) access by name.
    const nodeByName = new Map<string, DAGNode>();
    const nodeIndex = new Map<string, number>();
    for (let idx = 0; idx < nodes.length; idx++) {
      nodeByName.set(nodes[idx].name, nodes[idx]);
      nodeIndex.set(nodes[idx].name, idx);
    }

    const fireProgress = (event: AgentProgressEvent): void => {
      try {
        options.onAgentProgress?.(event);
      } catch {
        // Callback errors must not crash the workflow.
      }
    };

    let currentName: string | null = nodes[0]?.name ?? null;
    // Track whether the current node was reached via a dynamic next() jump.
    // If so, and it has no next() of its own, the workflow ends rather than
    // falling through to the next node in array order.
    let arrivedViaRouting = false;

    while (currentName !== null) {
      if (options.abortSignal?.aborted) {
        return {
          success: false,
          output: "Workflow aborted",
          executionLog,
        };
      }

      const node = nodeByName.get(currentName);
      if (!node) {
        return {
          success: false,
          output: `DAG node "${currentName}" not found in node list`,
          executionLog,
        };
      }

      // Condition check: skip this node and advance to the next in array.
      if (node.condition && !node.condition(memory)) {
        const skipIdx: number = nodeIndex.get(currentName)!;
        currentName = nodes[skipIdx + 1]?.name ?? null;
        arrivedViaRouting = false;
        continue;
      }

      const attemptNumber = (attempts.get(currentName) ?? 0) + 1;
      attempts.set(currentName, attemptNumber);

      if (attemptNumber > maxRetries) {
        return {
          success: false,
          output: `Agent "${currentName}" exceeded max retries (${maxRetries})`,
          error: lastOutput.error,
          executionLog,
        };
      }

      const agent = this.agents.get(currentName)!;
      const idx: number = nodeIndex.get(currentName)!;

      fireProgress({
        type: "agent_started",
        agentName: currentName,
        step: idx + 1,
        totalSteps: nodes.length,
      });

      const startTime = Date.now();
      let output: AgentOutput;
      try {
        output = await agent.execute(
          { userRequest, context: options.context ?? [] },
          memory,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output = {
          success: false,
          output: `Exception: ${message}`,
          error: message,
        };
      }
      const endTime = Date.now();

      executionLog.push({
        agentName: currentName,
        startTime,
        endTime,
        durationMs: endTime - startTime,
        success: output.success,
        output: output.output,
        attempt: attemptNumber,
      });

      memory.setOutput(currentName, output);
      lastOutput = output;

      if (output.success) {
        fireProgress({
          type: "agent_completed",
          agentName: currentName,
          durationMs: endTime - startTime,
          success: true,
          output: output.output,
        });
      } else {
        fireProgress({
          type: "agent_failed",
          agentName: currentName,
          error: output.error ?? output.output,
          attempt: attemptNumber,
        });
      }

      // Determine next node.
      if (node.next) {
        // Dynamic routing via next() callback.
        const nextName = node.next(output, memory);
        currentName = nextName ?? null;
        arrivedViaRouting = true;
      } else if (output.success) {
        if (arrivedViaRouting) {
          // Node reached via routing has no next() — end workflow here.
          currentName = null;
        } else {
          // Advance to the next node in array order.
          currentName = nodes[idx + 1]?.name ?? null;
        }
        arrivedViaRouting = false;
      }
      // On failure with no node.next: retry in place (currentName unchanged).
    }

    return {
      success: lastOutput.success,
      output: lastOutput.output,
      plan: lastOutput.plan,
      chunks: lastOutput.chunks,
      diffs: lastOutput.diffs,
      approved: lastOutput.approved,
      feedback: lastOutput.feedback,
      issues: lastOutput.issues,
      passed: lastOutput.passed,
      executionLog,
    };
  }
}

// ── MultiAgentRunner (sequential execution, inlined) ─────────────────────────

export type MultiAgentProgressEvent =
  | AgentProgressEvent
  | { type: "workflow_complete"; report: AgentRunReport };

export interface MultiAgentRunOptions {
  onProgress?: (event: MultiAgentProgressEvent) => void;
  abortSignal?: AbortSignal;
  analytics?: AgentAnalytics;
  /** Override default pipeline sequence. Default: ["planner","context","code","reviewer","validator"] */
  sequence?: string[];
  maxRetries?: number;
  /**
   * Map from agent name to the agent it should retry from on failure.
   * Example: { reviewer: 'code' } — on reviewer failure, re-run code
   * and then reviewer again.
   */
  retryFrom?: Record<string, string>;
}

const RUNNER_DEFAULT_MAX_RETRIES = 3;

export class MultiAgentRunner implements IWorkflowRunner {
  private agents = new Map<string, Agent>();

  constructor(orchestrator?: AgentOrchestrator) {
    // If an orchestrator is supplied (backward-compat path used by existing
    // tests and buildDefaultPipeline), seed our internal agents map from it.
    if (orchestrator) {
      for (const agent of orchestrator.listAgents()) {
        this.agents.set(agent.name, agent);
      }
    }
  }

  registerAgent(agent: Agent): void {
    this.agents.set(agent.name, agent);
  }

  listAgents(): Agent[] {
    return Array.from(this.agents.values());
  }

  async run(
    userRequest: string,
    options: MultiAgentRunOptions = {},
  ): Promise<WorkflowResult> {
    const DEFAULT_SEQUENCE = [
      "planner",
      "context",
      "code",
      "reviewer",
      "validator",
    ];
    // If no explicit sequence is given, use only the agents that are actually
    // registered (so callers can build partial pipelines in tests and smaller
    // configurations without registering every default agent).
    const sequence =
      options.sequence ??
      DEFAULT_SEQUENCE.filter((name) => this.agents.has(name));

    const maxRetries = options.maxRetries ?? RUNNER_DEFAULT_MAX_RETRIES;
    // Default retryFrom for the standard pipeline: reviewer failure retries from code.
    const retryFrom: Record<string, string> =
      options.retryFrom ?? (options.sequence ? {} : { reviewer: "code" });

    // Validate that every named agent is registered before we start.
    for (const name of sequence) {
      if (!this.agents.has(name)) {
        throw new Error(`Agent "${name}" is not registered`);
      }
    }

    const memory = new SharedMemory();
    const executionLog: ExecutionLogEntry[] = [];
    const attempts = new Map<string, number>();
    let lastOutput: AgentOutput = {
      success: true,
      output: "Workflow initialized",
    };

    const fireProgress = (event: AgentProgressEvent): void => {
      try {
        options.onProgress?.(event);
      } catch {
        // Callback errors must not crash the workflow.
      }
    };

    let i = 0;
    while (i < sequence.length) {
      if (options.abortSignal?.aborted) {
        const abortResult: WorkflowResult = {
          success: false,
          output: "Workflow aborted",
          executionLog,
        };
        try {
          const report = this._buildReport(options, abortResult);
          options.onProgress?.({ type: "workflow_complete", report });
        } catch {
          // ignore
        }
        return abortResult;
      }

      const name = sequence[i];
      const agent = this.agents.get(name)!;
      const attemptNumber = (attempts.get(name) ?? 0) + 1;
      attempts.set(name, attemptNumber);

      if (attemptNumber > maxRetries) {
        const failResult: WorkflowResult = {
          success: false,
          output: `Agent "${name}" exceeded max retries (${maxRetries})`,
          error: lastOutput.error,
          executionLog,
        };
        try {
          const report = this._buildReport(options, failResult);
          options.onProgress?.({ type: "workflow_complete", report });
        } catch {
          // ignore
        }
        return failResult;
      }

      fireProgress({
        type: "agent_started",
        agentName: name,
        step: i + 1,
        totalSteps: sequence.length,
      });

      const startTime = Date.now();
      let output: AgentOutput;
      try {
        output = await agent.execute({ userRequest, context: [] }, memory);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output = {
          success: false,
          output: `Exception: ${message}`,
          error: message,
        };
      }
      const endTime = Date.now();

      executionLog.push({
        agentName: name,
        startTime,
        endTime,
        durationMs: endTime - startTime,
        success: output.success,
        output: output.output,
        attempt: attemptNumber,
      });

      if (output.success) {
        fireProgress({
          type: "agent_completed",
          agentName: name,
          durationMs: endTime - startTime,
          success: true,
          output: output.output,
        });
      } else {
        fireProgress({
          type: "agent_failed",
          agentName: name,
          error: output.error ?? output.output,
          attempt: attemptNumber,
        });
      }

      memory.setOutput(name, output);
      lastOutput = output;

      if (output.success) {
        i++;
        continue;
      }

      // Agent failed. Decide whether to retry in place or branch back.
      const branchTarget = retryFrom[name];
      if (branchTarget) {
        const branchIdx = sequence.indexOf(branchTarget);
        if (branchIdx !== -1 && branchIdx < i) {
          attempts.set(branchTarget, 0);
          i = branchIdx;
          continue;
        }
      }

      // Simple retry in place: don't advance i, let the loop re-run.
    }

    const result: WorkflowResult = {
      success: lastOutput.success,
      output: lastOutput.output,
      error: lastOutput.error,
      plan: lastOutput.plan,
      chunks: lastOutput.chunks,
      diffs: lastOutput.diffs,
      approved: lastOutput.approved,
      feedback: lastOutput.feedback,
      issues: lastOutput.issues,
      passed: lastOutput.passed,
      executionLog,
    };

    // Build the analytics report and emit workflow_complete.
    try {
      const report = this._buildReport(options, result);
      options.onProgress?.({ type: "workflow_complete", report });
    } catch {
      // Callback errors must not affect the return value.
    }

    return result;
  }

  private _buildReport(
    options: MultiAgentRunOptions,
    result: WorkflowResult,
  ): AgentRunReport {
    return options.analytics
      ? options.analytics.toReport()
      : {
          runId: `run-${Date.now()}`,
          startTime: result.executionLog[0]?.startTime ?? Date.now(),
          totalDurationMs: result.executionLog.reduce(
            (s, e) => s + e.durationMs,
            0,
          ),
          totalInputTokens: 0,
          totalOutputTokens: 0,
          success: result.success,
          agents: result.executionLog.map((e) => ({
            agentName: e.agentName,
            startTime: e.startTime,
            endTime: e.endTime,
            durationMs: e.durationMs,
            inputTokens: 0,
            outputTokens: 0,
            toolCalls: [],
            success: e.success,
          })),
        };
  }

  /**
   * Build the default pipeline using real LLM-backed agents.
   * Called from extension.ts during activation.
   */
  static buildDefaultPipeline(
    provider: import("../providers/types").LLMProvider,
    toolRegistry: import("../tools/registry").ToolRegistry,
    workspaceRoot: string,
    indexingService?: {
      search(
        query: string,
        topK?: number,
      ): Promise<
        Array<{
          filePath: string;
          chunkText: string;
          startLine: number;
          endLine: number;
        }>
      >;
    },
  ): MultiAgentRunner {
    const { PlannerAgent } = require("./agents/planner-agent") as {
      PlannerAgent: new (
        p: import("../providers/types").LLMProvider,
      ) => import("./agents/types").Agent;
    };
    const { ContextAgent } = require("./agents/context-agent") as {
      ContextAgent: new (
        c: import("./agents/context-agent").ContextAgentConfig,
      ) => import("./agents/types").Agent;
    };
    const { CodeAgent } = require("./agents/code-agent") as {
      CodeAgent: new (
        p: import("../providers/types").LLMProvider,
      ) => import("./agents/types").Agent;
    };
    const { ReviewerAgent } = require("./agents/reviewer-agent") as {
      ReviewerAgent: new (
        p: import("../providers/types").LLMProvider,
      ) => import("./agents/types").Agent;
    };
    const { ValidatorAgent } = require("./agents/validator-agent") as {
      ValidatorAgent: new (
        r: import("../tools/registry").ToolRegistry,
        c?: import("./agents/validator-agent").ValidatorConfig,
      ) => import("./agents/types").Agent;
    };

    const runner = new MultiAgentRunner();
    runner.registerAgent(new PlannerAgent(provider));
    runner.registerAgent(new ContextAgent({ workspaceRoot, indexingService }));
    runner.registerAgent(new CodeAgent(provider));
    runner.registerAgent(new ReviewerAgent(provider));
    runner.registerAgent(new ValidatorAgent(toolRegistry, { workspaceRoot }));
    return runner;
  }
}
