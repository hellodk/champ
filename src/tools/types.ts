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
  requestApproval: (
    description: string,
    preview?: { type: "diff" | "command"; content: string; label?: string },
  ) => Promise<boolean>;
  /** Optional tracker for recording file edits for diff review. */
  editReviewTracker?: import("../agent/edit-review-tracker").EditReviewTracker;
  /**
   * Optional staging buffer for atomic multi-file edits.
   * When present, edit_file writes to this buffer instead of disk.
   * read_file reads from this buffer before falling back to disk.
   * Flushed to disk at the end of the agent turn.
   */
  stagedEdits?: import("../agent/staged-edits").StagedEdits;
  /** Optional audit log — tools call record() on success for tamper-evident logging. */
  auditLog?: import("../observability/audit-log").AuditLog;
  /** Optional execution backend override (defaults to the detected backend). */
  executionBackend?: import("../safety/execution-backend").ExecutionBackend;
  /** Active policy engine, consulted before tool and shell execution. */
  policy?: import("../policy/engine").PolicyEngine;
  /** Session-scoped policy layer, overridden by project/user/managed layers. */
  sessionPolicy?: import("../policy/engine").PolicyRule[];
  /** True when no human can answer an approval prompt. */
  headless?: boolean;
  /**
   * Operator-selected permission profile. Enforced by ToolRegistry before any
   * policy evaluation or approval prompt; never derived from model output.
   */
  permissionProfile?: import("../policy/profiles").PermissionProfile;
  /**
   * Called before a mutating tool writes to disk. Implementations should
   * create a recovery checkpoint of the returned paths. Throwing aborts the
   * mutation. A missing callback means no automatic checkpoint is taken.
   */
  onBeforeMutation?: (paths: string[]) => Promise<void>;
}

/**
 * Optional structured preview shown in the approval dialog before the
 * user decides whether to allow or deny a tool execution.
 *
 * - "diff"    → old vs new content rendered with +/- colouring
 * - "command" → verbatim shell command shown in a code block
 */
export interface ToolPreview {
  type: "diff" | "command";
  content: string;
  label?: string;
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
    fileEditDiff?: { path: string; oldContent: string; newContent: string };
    screenshot?: string; // Base64-encoded screenshot data
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
  /**
   * Optionally return a structured preview of what the tool is about to do.
   * Called just before the approval dialog is shown. When omitted, the dialog
   * falls back to displaying the raw JSON args.
   */
  getPreview?(args: Record<string, unknown>): ToolPreview | undefined;
  /**
   * Workspace-relative paths this tool is about to mutate. Used to create an
   * automatic recovery checkpoint before execution. When omitted, no automatic
   * checkpoint is taken for this tool.
   */
  mutationPaths?(args: Record<string, unknown>): string[];
  /** Execute the tool with the given arguments and context. */
  execute(
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}
