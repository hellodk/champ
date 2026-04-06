/**
 * Tool system type contracts.
 *
 * Each tool is a self-contained module that implements the Tool interface.
 * The ToolRegistry dispatches LLM tool calls to the appropriate
 * implementation and handles the approval flow for destructive operations.
 */
import type { ToolParameterSchema } from "../providers/types";

/**
 * Context passed to every tool execution. Provides access to workspace
 * state, cancellation, progress reporting, and approval requests.
 */
export interface ToolExecutionContext {
  /** Absolute path to the workspace root. */
  workspaceRoot: string;
  /** Abort signal for cancelling long-running operations. */
  abortSignal: AbortSignal;
  /** Report streaming progress back to the UI (e.g., terminal output). */
  reportProgress: (message: string) => void;
  /** Request user approval for a destructive action. */
  requestApproval: (description: string) => Promise<boolean>;
}

/**
 * Result of a tool execution. The `output` is plain text that gets fed
 * back to the LLM on the next turn.
 */
export interface ToolResult {
  success: boolean;
  output: string;
  metadata?: {
    filesModified?: string[];
    filesCreated?: string[];
    filesDeleted?: string[];
  };
}

/**
 * A tool exposed to the LLM. Each tool registers itself into the
 * ToolRegistry at extension activation time.
 */
export interface Tool {
  /** Unique tool name (snake_case matches LLM conventions). */
  name: string;
  /** Human-readable description sent to the LLM. */
  description: string;
  /** JSON Schema for the tool's parameters. */
  parameters: ToolParameterSchema;
  /**
   * Whether this tool requires explicit user approval before executing.
   * Destructive operations (edit/create/delete/terminal) should set this
   * to true; read-only operations should set it to false.
   */
  requiresApproval: boolean;
  /** Execute the tool with the given arguments and context. */
  execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}
