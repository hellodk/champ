import {
  AgentOrchestrator,
  type WorkflowResult,
  type AgentProgressEvent,
} from "./orchestrator";
import type { AgentAnalytics } from "../observability/agent-analytics";
import type { AgentRunReport } from "../agent-manager/types";

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
}

export class MultiAgentRunner {
  constructor(private readonly orchestrator: AgentOrchestrator) {}

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
      DEFAULT_SEQUENCE.filter(
        (name) => this.orchestrator.getAgent(name) !== undefined,
      );

    const result = await this.orchestrator.executeWorkflow(
      userRequest,
      sequence,
      {
        abortSignal: options.abortSignal,
        maxRetries: options.maxRetries ?? 3,
        retryFrom: { reviewer: "code" },
        onAgentProgress: (event) => {
          options.onProgress?.(event);
        },
      },
    );

    // Build the analytics report — from the AgentAnalytics instance if provided,
    // otherwise synthesize a minimal report from the execution log.
    const report: AgentRunReport = options.analytics
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

    try {
      options.onProgress?.({ type: "workflow_complete", report });
    } catch {
      // Callback errors must not affect the return value.
    }

    return result;
  }

  /**
   * Build the default pipeline using real LLM-backed agents.
   * Called from extension.ts during activation.
   */
  static buildDefaultPipeline(
    provider: import("../providers/types").LLMProvider,
    toolRegistry: import("../tools/registry").ToolRegistry,
    workspaceRoot: string,
  ): MultiAgentRunner {
    const { PlannerAgent } = require("./agents/planner-agent") as {
      PlannerAgent: new (
        p: import("../providers/types").LLMProvider,
      ) => import("./agents/types").Agent;
    };
    const { ContextAgent } = require("./agents/context-agent") as {
      ContextAgent: new () => import("./agents/types").Agent;
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

    const orch = new AgentOrchestrator();
    orch.registerAgent(new PlannerAgent(provider));
    orch.registerAgent(new ContextAgent());
    orch.registerAgent(new CodeAgent(provider));
    orch.registerAgent(new ReviewerAgent(provider));
    orch.registerAgent(new ValidatorAgent(toolRegistry, { workspaceRoot }));
    return new MultiAgentRunner(orch);
  }
}
