import type { Agent } from "./agents/types";
import type { WorkflowResult } from "./orchestrator";
import type { MultiAgentRunOptions } from "./multi-agent-runner";

/**
 * Narrow interface that WorkflowSession and extension.ts depend on.
 * Decouples them from the concrete MultiAgentRunner.
 */
export interface IWorkflowRunner {
  run(
    userRequest: string,
    options?: MultiAgentRunOptions,
  ): Promise<WorkflowResult>;
  registerAgent(agent: Agent): void;
  listAgents(): Agent[];
}
