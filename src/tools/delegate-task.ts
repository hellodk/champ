/**
 * delegate_task tool: allows an agent to spawn a scoped sub-agent to handle a subtask.
 *
 * This enables hierarchical task decomposition where the primary agent can delegate
 * specialized subtasks to dedicated sub-agents, each with its own scope (file, directory,
 * or workspace) and optionally a different model.
 *
 * Usage in an agent's tool call:
 *   delegate_task({
 *     task: "Refactor the authentication module",
 *     scope: "directory",
 *     model: "claude-haiku",  // optional
 *     context: { ... }        // optional
 *   })
 */
import type { Tool, ToolResult, ToolExecutionContext } from "./types";
import type { ToolParameterSchema } from "../providers/types";

export interface DelegateTaskArgs {
  /** The subtask description */
  task: string;
  /** Scope: 'file' for single file, 'directory' for multi-file, 'workspace' for full workspace */
  scope: "file" | "directory" | "workspace";
  /** Optional model to use for the sub-agent (defaults to parent agent's model) */
  model?: string;
  /** Optional context to pass to the sub-agent */
  context?: Record<string, unknown>;
}

/**
 * Minimal interface for the LLM provider used by the sub-agent.
 * This allows the tool to work with any provider that supports streaming.
 */
export interface SubAgentProvider {
  readonly name: string;
  chat(
    messages: Array<{
      role: string;
      content: string;
    }>,
    options?: unknown,
  ): Promise<{
    stream?: AsyncIterable<unknown>;
    text?: string;
  }>;
}

/**
 * Minimal interface for the agent controller that spawns sub-agents.
 * This abstracts away the full AgentController to make testing easier.
 */
export interface SubAgentController {
  processMessage(
    userMessage: string,
    options?: {
      abortSignal?: AbortSignal;
      maxIterations?: number;
    },
  ): Promise<{
    text: string;
    toolCalls: Array<unknown>;
  }>;
}

/**
 * Minimal interface for shared memory between agents.
 */
export interface SubAgentMemory {
  set(key: string, value: unknown): void;
  get(key: string): unknown;
  subscribe(channel: string, timeout: number): Promise<unknown>;
  hasChannel(channel: string): boolean;
}

class DelegateTaskToolImpl implements Tool {
  readonly name = "delegate_task";
  readonly description =
    "Delegate a subtask to a scoped sub-agent. This allows hierarchical task decomposition " +
    "where you can spawn specialized agents to handle specific parts of a larger workflow. " +
    "The sub-agent has access to the same tools as the parent agent but operates within a " +
    "specified scope (file, directory, or workspace).";
  readonly requiresApproval = true;

  readonly parameters: ToolParameterSchema = {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "A clear description of the subtask for the sub-agent to complete. " +
          "Should be self-contained and specific.",
      },
      scope: {
        type: "string",
        enum: ["file", "directory", "workspace"],
        description:
          "The scope of the subtask: 'file' for single file operations, " +
          "'directory' for multi-file directory operations, or 'workspace' for full workspace operations.",
      },
      model: {
        type: "string",
        description:
          "Optional model ID for the sub-agent (e.g., 'claude-haiku', 'claude-sonnet'). " +
          "If omitted, uses the parent agent's current model.",
      },
      context: {
        type: "object",
        description:
          "Optional context object to pass to the sub-agent. Can include information like " +
          "current file path, line ranges, or other relevant task parameters.",
      },
    },
    required: ["task", "scope"],
  };

  constructor(
    private readonly agentController: SubAgentController,
    private readonly memory: SubAgentMemory,
  ) {}

  getPreview(
    args: Record<string, unknown>,
  ): { type: "command"; content: string } | undefined {
    const task = args.task as string | undefined;
    const scope = args.scope as string | undefined;
    const model = args.model as string | undefined;

    if (!task || !scope) {
      return undefined;
    }

    const modelStr = model ? ` (model: ${model})` : "";
    return {
      type: "command" as const,
      content: `Delegate to sub-agent:\n  Task: ${task}\n  Scope: ${scope}${modelStr}`,
    };
  }

  async execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    // Validate required parameters
    const task = args.task as string | undefined;
    if (!task || typeof task !== "string" || !task.trim()) {
      return {
        success: false,
        output: 'delegate_task: "task" must be a non-empty string.',
      };
    }

    const scopeRaw = args.scope as string | undefined;
    if (!scopeRaw || !["file", "directory", "workspace"].includes(scopeRaw)) {
      return {
        success: false,
        output:
          'delegate_task: "scope" must be one of: "file", "directory", "workspace".',
      };
    }
    const scope = scopeRaw as "file" | "directory" | "workspace";

    const model = args.model as string | undefined;
    const taskContext = args.context as Record<string, unknown> | undefined;

    try {
      // Report that we're delegating the task
      context.reportProgress(
        `Delegating task to sub-agent (scope: ${scope})...`,
      );

      // Build the system prompt for the sub-agent based on scope
      const scopeInstructions = this.buildScopeInstructions(scope);
      const contextStr = taskContext
        ? `\n\nContext: ${JSON.stringify(taskContext)}`
        : "";

      // Build the message for the sub-agent
      const subagentMessage =
        `You are a specialized sub-agent tasked with the following:\n\n` +
        `Task: ${task}\n` +
        scopeInstructions +
        contextStr +
        `\n\nComplete this task efficiently and report your results.`;

      // Execute the subtask via the agent controller
      context.reportProgress(
        `Sub-agent processing: ${task.substring(0, 50)}...`,
      );

      const result = await this.agentController.processMessage(
        subagentMessage,
        {
          abortSignal: context.abortSignal,
          maxIterations: 10, // Sub-agents get a smaller iteration limit
        },
      );

      // Report completion
      context.reportProgress(
        `Sub-agent completed: ${result.text.substring(0, 100)}...`,
      );

      // Store sub-agent output in memory for potential parent agent reference
      this.memory.set(`subtask_${Date.now()}`, {
        task,
        scope,
        output: result.text,
        model: model || "default",
      });

      return {
        success: true,
        output:
          `Sub-agent completed task: ${task}\n\n` + `Result:\n${result.text}`,
        metadata: {
          filesModified: [], // Sub-agent results could indicate modified files
        },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      context.reportProgress(`Sub-agent error: ${errorMsg}`);
      return {
        success: false,
        output:
          `delegate_task failed: ${errorMsg}\n\n` +
          `Ensure the sub-agent has access to necessary files and permissions within the ${scope} scope.`,
      };
    }
  }

  private buildScopeInstructions(
    scope: "file" | "directory" | "workspace",
  ): string {
    switch (scope) {
      case "file":
        return (
          "\n\nScope: Single File\n" +
          "You have access to read and modify a single file. " +
          "Focus on targeted changes within that file only. " +
          "Do not attempt to modify other files or directories."
        );
      case "directory":
        return (
          "\n\nScope: Directory\n" +
          "You have access to read and modify files within a specific directory. " +
          "You can navigate and modify multiple related files in this directory. " +
          "Maintain consistency across related files if needed."
        );
      case "workspace":
        return (
          "\n\nScope: Full Workspace\n" +
          "You have access to the entire workspace and can modify any files as needed. " +
          "Ensure your changes maintain project-wide consistency and don't break other modules."
        );
    }
  }
}

/**
 * Factory function to create the delegate_task tool with an agent controller
 * and shared memory instance. This follows the same pattern as createCodebaseSearchTool.
 */
export function createDelegateTaskTool(
  agentController: SubAgentController,
  memory: SubAgentMemory,
): Tool {
  return new DelegateTaskToolImpl(agentController, memory);
}
